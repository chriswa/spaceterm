import { create } from 'zustand'
import type { DictationApi, HandsFreeApi } from '../shared/api'
import type { HandsFreeTuning } from '../shared/protocol'
import { playCue, quietForMs, type Cue } from './cues'
import { Dictation, type DictationOptions } from './dictation'
import { heldCapture, onHoldStateChange, type Capture } from './held-microphone'
import { nativeHaptic } from './native-microphone'
import { Downsampler, pcmToBase64 } from './pcm'
import { DEFAULT_TUNING, UtteranceEndpointer, WakeListener } from './wake-listener'

/**
 * Hands-free mode: start talking with "Control" and just keep going — "Control,
 * what's Kevin doing?" — and end with "over and out", or by going quiet.
 *
 * Runs whenever this phone holds its microphone open (held-microphone.ts) —
 * the hold button *is* the always-listen switch. What the microphone hears
 * goes through `WakeListener`, on the phone. Nothing leaves it unless the user
 * starts talking after a quiet spell: then the first second of that goes to
 * the Mac, where Voice Operator checks, with Apple's on-device model (never
 * Wispr), whether its first word is "control". Only "Control" said first
 * counts; the word anywhere else in a sentence does not.
 *
 * On a match the phone taps (a haptic, in the app) and the hold button turns
 * green, and an ordinary Wispr dictation opens on the microphone that is
 * already open — fed everything said since the first syllable, out of the
 * listener's buffer, then live. So nothing waits on the check: it is
 * retroactive. A start tone would land mid-sentence, in the recording; the end
 * tone is the confirmation that it was heard and sent.
 *
 * It ends when Voice Operator hears "over and out" (watched for on-device,
 * alongside Wispr); or at a pause, when the server's turn model (Smart Turn,
 * src/server/turn-detector.ts) says the speaker sounds finished; or when a
 * pause outlasts a patience that grows with how long they have been talking
 * — a second and a half for a quick request, up to twenty seconds into a
 * monologue — for when the model is unsure or unavailable. "Control" is stripped
 * off the front of the transcript, "over and out" and anything after it off
 * the end, and the rest goes to Control, which comes to this device.
 *
 * It does not listen while this phone is playing anything (Control's voice, a
 * cue) or for `playbackTailMs` after, so it never hears itself; nor while a
 * dictation it did not start is under way.
 *
 * Nothing heard is logged: only that a candidate was or was not the word, and
 * its timings.
 */

export const WAKE_WORD = 'control'
export const END_PHRASE = 'over and out'

export type HandsFreePhase = 'off' | 'listening' | 'hearing' | 'sending'

export const useHandsFree = create<{ phase: HandsFreePhase }>(() => ({ phase: 'off' }))

/**
 * What Wispr wrote, as Control should get it: the wake word off the front,
 * the end phrase and anything after it off the end. Punctuation and case
 * around either are ignored. Empty when nothing else was said.
 */
export function cleanHandsFreeText(text: string): string {
  let out = text.trim().replace(/^control\b[\s,.!?:;…—–-]*/i, '')
  const end = /\bover[\s,.!?…—–-]+(?:and|&)[\s,.!?…—–-]+out\b/gi
  let last: RegExpExecArray | null = null
  for (let match = end.exec(out); match; match = end.exec(out)) last = match
  if (last) out = out.slice(0, last.index)
  return out.replace(/[\s,;:…—–-]+$/, '').trim()
}

/** A dictation as hands-free mode drives it. */
export interface HandsFreeDictation {
  finish(): Promise<string>
  cancel(): void
  /** At a pause: probability 0..1 that the speaker has finished; null when it cannot say. */
  checkTurn(): Promise<number | null>
}

/** Everything outside this module it touches, so a test can supply its own. */
export interface HandsFreeDeps {
  api: { handsFree: HandsFreeApi; dictation: DictationApi }
  log(message: string): void
  heldCapture(): Capture | undefined
  onHoldStateChange(fn: () => void): () => void
  /** How long this device has been silent; 0 while it plays. */
  quietForMs(): number
  playCue(cue: Cue): void
  /** A tap the user can feel: the wake word was heard. Nothing, where there is no way to. */
  haptic(): void
  /** A dictation on the held microphone. */
  beginDictation(options: DictationOptions): Promise<HandsFreeDictation>
  /** Whether some other dictation is capturing on this page. */
  othersDictating(): boolean
  sleep(ms: number): Promise<void>
}

const REAL_DEPS = (api: HandsFreeDeps['api']): HandsFreeDeps => ({
  api,
  log: (message) => window.api?.log(`[hands-free] ${message}`),
  heldCapture,
  onHoldStateChange,
  quietForMs,
  playCue,
  haptic: nativeHaptic,
  beginDictation: (options) => Dictation.begin(api.dictation, options),
  // Its own dictation counts as one while it is hearing; see `hearing` below.
  othersDictating: () => Dictation.live > (useHandsFree.getState().phase === 'hearing' ? 1 : 0),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
})

/** While the page is hidden, how often to note that audio is still arriving. */
const BACKGROUND_REPORT_MS = 60_000

/**
 * Why a dictation ended: the end phrase, the turn model, the endpointer's
 * silence or cap, or the microphone going away.
 */
type EndReason = 'over and out' | 'finished' | 'silence' | 'too-long' | 'lost'

export function installHandsFree(api: HandsFreeDeps['api'], deps: HandsFreeDeps = REAL_DEPS(api)): () => void {
  const { log } = deps
  let tuning: HandsFreeTuning = DEFAULT_TUNING
  const listener = new WakeListener(tuning)
  const setPhase = (phase: HandsFreePhase) => {
    if (useHandsFree.getState().phase !== phase) useHandsFree.setState({ phase })
  }

  let capture: Capture | undefined
  let unlisten: (() => void) | undefined
  let downsampler: Downsampler | undefined
  /** Set while not listening — this device playing, another dictation — so listening starts afresh after. */
  let stoodAside = false
  /** The dictation after the wake word, fed to its endpointer, and how to say it has ended. */
  let utterance: UtteranceEndpointer | undefined
  let utteranceDictation: HandsFreeDictation | undefined
  let endUtterance: ((reason: EndReason) => void) | undefined
  /** Bumped at every pause and every resumption: a turn verdict counts only for the pause it was asked about. */
  let pauseNumber = 0
  let checkError: string | undefined
  let heardSamples = 0
  let lastReport = 0

  const offTuning = api.handsFree.onTuning((overrides) => {
    tuning = { ...DEFAULT_TUNING, ...overrides }
    listener.setTuning(tuning)
    log(`tuning ${JSON.stringify(tuning)}`)
  })

  const check = (clip: Int16Array): Promise<boolean> =>
    api.handsFree.checkWakeWord(pcmToBase64(clip)).then(({ match, error }) => {
      if (error && error !== checkError) log(`cannot check the wake word: ${error}`)
      checkError = error
      return match
    }, (err) => {
      log(`wake-word check failed: ${err instanceof Error ? err.message : String(err)}`)
      return false
    })

  /** The wake word heard: dictate from where the user started, until the end phrase or quiet; send to Control. */
  const respond = async (start: number) => {
    setPhase('hearing')
    deps.haptic()
    let dictation: HandsFreeDictation | undefined
    try {
      if (!capture) throw new Error('the microphone went away')
      // Ends on the end phrase, on what the endpointer hears — or, if audio stops coming, on the clock.
      let ended: (reason: EndReason) => void = () => undefined
      const end = new Promise<EndReason>((resolve) => { ended = resolve })
      let backlogMs = 0
      dictation = await deps.beginDictation({
        backlog: () => {
          const audio = listener.audioSince(start)
          backlogMs = (audio.length / 16_000) * 1000
          return audio
        },
        endPhrase: END_PHRASE,
        onEndPhrase: () => ended('over and out'),
      })
      utterance = new UtteranceEndpointer(tuning, backlogMs)
      utteranceDictation = dictation
      endUtterance = ended
      void deps.sleep(tuning.maxUtteranceMs + 10_000).then(() => ended('lost'))
      const reason = await end
      utterance = undefined
      utteranceDictation = undefined
      endUtterance = undefined
      deps.playCue('listeningFinished')
      if (reason === 'lost') {
        log('the microphone stopped mid-dictation')
        dictation.cancel()
        return
      }
      setPhase('sending')
      const text = cleanHandsFreeText(await dictation.finish())
      if (!text) {
        log(`nothing to send besides the wake word (ended on ${reason})`)
        return
      }
      log(`${text.length} chars to Control (ended on ${reason})`)
      api.handsFree.say(text)
      deps.playCue('pasted')
    } catch (err) {
      log(`dictation failed: ${err instanceof Error ? err.message : String(err)}`)
      dictation?.cancel()
      deps.playCue('transcriptionFailed')
    } finally {
      utterance = undefined
      utteranceDictation = undefined
      endUtterance = undefined
      setPhase(capture ? 'listening' : 'off')
      listener.resume()
    }
  }

  /** A pause: if the turn model is sure enough they have finished, and they have not started again, end here. */
  const askAboutPause = async (talkMs: number) => {
    const asked = ++pauseNumber
    const dictation = utteranceDictation
    if (!dictation) return
    const p = await dictation.checkTurn()
    const current = asked === pauseNumber && dictation === utteranceDictation
    log(`pause after ${(talkMs / 1000).toFixed(1)}s: ${p === null ? 'no turn verdict' : `p(finished)=${p.toFixed(2)}`}${current ? '' : ', but they carried on'}`)
    if (current && p !== null && p >= tuning.turnThreshold) endUtterance?.('finished')
  }

  const onBlock = (block: Float32Array) => {
    if (!downsampler) return
    const pcm = downsampler.push(block)
    if (pcm.length === 0) return
    heardSamples += pcm.length
    if (document.visibilityState === 'hidden' && performance.now() - lastReport > BACKGROUND_REPORT_MS) {
      lastReport = performance.now()
      log(`still hearing with the page hidden (${Math.round(heardSamples / 16_000)}s of audio so far)`)
    }
    const phase = useHandsFree.getState().phase
    if (phase === 'hearing') {
      for (const event of utterance?.push(pcm) ?? []) {
        if (event.kind === 'ended') endUtterance?.(event.reason)
        else if (event.kind === 'resumed') pauseNumber++
        else void askAboutPause(event.talkMs)
      }
      return
    }
    if (phase !== 'listening') return
    if (deps.quietForMs() < tuning.playbackTailMs || deps.othersDictating()) {
      stoodAside = true
      return
    }
    if (stoodAside) {
      stoodAside = false
      listener.resume()
    }
    for (const candidate of listener.push(pcm)) {
      log(`speech after ${candidate.quietBeforeMs}ms of quiet — checking its start for "${WAKE_WORD}"`)
      void check(candidate.clip).then((match) => {
        log(match ? 'it starts with the wake word: dictating from its start' : 'not the wake word')
        if (match && useHandsFree.getState().phase === 'listening' && capture) void respond(candidate.start)
      })
    }
  }

  /** Follow the hold: listen to the held microphone while there is one. */
  const follow = () => {
    const next = deps.heldCapture()
    if (next === capture) return
    unlisten?.()
    unlisten = undefined
    capture = next
    if (!next) {
      downsampler = undefined
      endUtterance?.('lost')
      if (useHandsFree.getState().phase === 'listening') setPhase('off')
      log('not listening: the microphone is not held')
      return
    }
    downsampler = new Downsampler(next.sampleRate)
    listener.resume()
    unlisten = next.listen(onBlock)
    if (useHandsFree.getState().phase === 'off') setPhase('listening')
    log(`listening for "${WAKE_WORD}" (${next.describe()})`)
  }
  follow()
  const offHold = deps.onHoldStateChange(follow)

  return () => {
    offHold()
    offTuning()
    unlisten?.()
    capture = undefined
    setPhase('off')
  }
}
