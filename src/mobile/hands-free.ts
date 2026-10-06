import { create } from 'zustand'
import type { DictationApi, HandsFreeApi } from '../shared/api'
import type { HandsFreeTuning } from '../shared/protocol'
import { playCue, quietForMs, type Cue } from './cues'
import { Dictation, type DictationOptions } from './dictation'
import { heldCapture, onHoldStateChange, type Capture } from './held-microphone'
import { nativeHaptic } from './native-microphone'
import { recordMobileEvent } from './mobile-events'
import { Downsampler, pcmToBase64 } from './pcm'
import { loadFrameScorer, type FrameScorer } from './speech-detector'
import { DEFAULT_TUNING, EnergyScorer, Framer, UtteranceEndpointer, WakeListener, levelDb, type ScoredFrame, type WakeCandidate } from './wake-listener'

/**
 * Hands-free mode: start talking with "Control" and just keep going — "Control,
 * what's Kevin doing?" — and stop when you are done.
 *
 * Runs whenever this phone holds its microphone open (held-microphone.ts) —
 * the hold button *is* the always-listen switch. What the microphone hears
 * goes through `WakeListener`, on the phone, scored frame by frame for speech
 * by a voice-activity model (speech-detector.ts) — so music or a noisy room is
 * not speech. Nothing leaves the phone unless the user starts talking with
 * nobody talking just before: then the first second of that goes to
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
 * It ends at a pause, when the server's turn model (Smart Turn,
 * src/server/turn-detector.ts) says the speaker sounds finished; or when a
 * pause outlasts a patience that grows with how long they have been talking
 * — three seconds for a quick request, up to twenty seconds into a monologue
 * — for when the model is unsure or unavailable. "Control" is stripped off the
 * front of the transcript, and the rest goes to Control, which comes to this
 * device.
 *
 * It does not listen while this phone is playing anything (Control's voice, a
 * cue) or for `playbackTailMs` after, so it never hears itself; nor while a
 * dictation it did not start is under way.
 *
 * Nothing heard is logged: only that a candidate was or was not the word, and
 * its timings.
 */

export const WAKE_WORD = 'control'

export type HandsFreePhase = 'off' | 'listening' | 'hearing' | 'sending'

export const useHandsFree = create<{ phase: HandsFreePhase }>(() => ({ phase: 'off' }))

/**
 * What Wispr wrote, as Control should get it: the wake word off the front,
 * punctuation and case around it ignored. Empty when nothing else was said.
 */
export function cleanHandsFreeText(text: string): string {
  return text.trim().replace(/^control\b[\s,.!?:;…—–-]*/i, '').trim()
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
  /** The voice-activity model, once loaded; loudness stands in until then, or for good if it will not load. */
  loadScorer(): Promise<FrameScorer>
  /** For the record (mobile-events.ts): what was heard and decided, never what was said. */
  record(kind: string, detail?: Record<string, unknown>): void
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
  loadScorer: () => loadFrameScorer((message) => window.api?.log(`[hands-free] ${message}`)),
  record: (kind, detail) => recordMobileEvent(kind, detail),
})

/** While the page is hidden, how often to note that audio is still arriving. */
const BACKGROUND_REPORT_MS = 60_000
/** While listening, how often to record the room: how loud, and how much of it was speech. */
const LEVELS_REPORT_MS = 30_000
/** Frames waiting on a slow speech detector beyond this (about 3 s) are dropped, and listening starts afresh. */
const MAX_QUEUED_FRAMES = 100

/** Why a dictation ended: the turn model, the endpointer's silence or cap, or the microphone going away. */
type EndReason = 'finished' | 'silence' | 'too-long' | 'lost'

export function installHandsFree(api: HandsFreeDeps['api'], deps: HandsFreeDeps = REAL_DEPS(api)): () => void {
  const { log } = deps
  let tuning: HandsFreeTuning = DEFAULT_TUNING
  const { record } = deps
  // Every burst of speech the listener noticed, and why it was or was not checked.
  const listener = new WakeListener(tuning, (sighting) => record('hands-free-speech', { ...sighting }))
  const setPhase = (phase: HandsFreePhase) => {
    const was = useHandsFree.getState().phase
    if (was === phase) return
    useHandsFree.setState({ phase })
    record('hands-free-phase', { from: was, to: phase })
  }

  let capture: Capture | undefined
  let unlisten: (() => void) | undefined
  let downsampler: Downsampler | undefined
  const framer = new Framer()
  /** Loudness until the voice-activity model has loaded. */
  let scorer: FrameScorer = new EnergyScorer()
  /** Frames waiting for the scorer, and whether they are being worked through. */
  let queued: Int16Array[] = []
  let draining = false
  /** The room since the last levels report. */
  let levels = { frames: 0, speechFrames: 0, sumDb: 0, maxDb: -120, since: performance.now() }
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

  void deps.loadScorer().then((loaded) => {
    scorer = loaded
    listener.resume()
    record('hands-free-detector', { name: loaded.name })
  })

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

  /** The wake word heard: dictate from where the user started until they finish; send to Control. */
  const respond = async ({ start, spokeMs }: WakeCandidate) => {
    setPhase('hearing')
    deps.haptic()
    let dictation: HandsFreeDictation | undefined
    try {
      if (!capture) throw new Error('the microphone went away')
      // Ends on what the turn model and the endpointer hear — or, if audio stops coming, on the clock.
      let ended: (reason: EndReason) => void = () => undefined
      const end = new Promise<EndReason>((resolve) => { ended = resolve })
      let backlogMs = 0
      dictation = await deps.beginDictation({
        backlog: () => {
          const audio = listener.audioSince(start)
          backlogMs = (audio.length / 16_000) * 1000
          return audio
        },
      })
      utterance = new UtteranceEndpointer(tuning, backlogMs, spokeMs)
      utteranceDictation = dictation
      endUtterance = ended
      void deps.sleep(tuning.maxUtteranceMs + 10_000).then(() => ended('lost'))
      const reason = await end
      utterance = undefined
      utteranceDictation = undefined
      endUtterance = undefined
      deps.playCue('listeningFinished')
      record('hands-free-ended', { reason })
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

  /** One scored frame, routed by phase: to the endpointer while dictating, else to the wake-word listener. */
  const onFrame = (frame: ScoredFrame) => {
    const db = levelDb(frame.pcm)
    levels.frames++
    if (frame.p >= 0.5) levels.speechFrames++
    levels.sumDb += db
    levels.maxDb = Math.max(levels.maxDb, db)
    if (performance.now() - levels.since >= LEVELS_REPORT_MS) {
      record('hands-free-levels', {
        detector: scorer.name,
        seconds: Math.round(levels.frames * 0.032),
        speechPercent: Math.round((100 * levels.speechFrames) / Math.max(1, levels.frames)),
        meanDb: Math.round(levels.sumDb / Math.max(1, levels.frames)),
        maxDb: Math.round(levels.maxDb),
        phase: useHandsFree.getState().phase,
      })
      levels = { frames: 0, speechFrames: 0, sumDb: 0, maxDb: -120, since: performance.now() }
    }
    const phase = useHandsFree.getState().phase
    if (phase === 'hearing') {
      for (const event of utterance?.push([frame]) ?? []) {
        if (event.kind === 'ended') endUtterance?.(event.reason)
        else if (event.kind === 'resumed') pauseNumber++
        else if (event.wakeWordOnly) {
          // "Control." and a breath: the turn model would call that finished. Wait for the rest.
          log('pause after the wake word alone: waiting for the rest, not asking the turn model')
          record('hands-free-pause', { talkMs: event.talkMs, wakeWordOnly: true })
        } else void askAboutPause(event.talkMs)
      }
      return
    }
    if (phase !== 'listening') return
    if (deps.quietForMs() < tuning.playbackTailMs || deps.othersDictating()) {
      // Deaf to "Control" until this ends: the phone is talking, or another dictation has the floor.
      if (!stoodAside) record('hands-free-stood-aside', { why: deps.othersDictating() ? 'another dictation' : 'this phone is playing' })
      stoodAside = true
      return
    }
    if (stoodAside) {
      stoodAside = false
      record('hands-free-listening-again')
      listener.resume()
    }
    for (const candidate of listener.push([frame])) {
      log(`speech after ${candidate.noSpeechBeforeMs}ms without speech — checking its start for "${WAKE_WORD}"`)
      void check(candidate.clip).then((match) => {
        log(match ? 'it starts with the wake word: dictating from its start' : 'not the wake word')
        record('wake-word', { match, noSpeechBeforeMs: candidate.noSpeechBeforeMs, spokeMs: candidate.spokeMs })
        if (match && useHandsFree.getState().phase === 'listening' && capture) void respond(candidate)
      })
    }
  }

  /** Score queued frames in order — at once for loudness, a frame at a time through the model. */
  const drain = async () => {
    if (draining) return
    draining = true
    try {
      while (queued.length > 0) {
        const pcm = queued.shift()!
        const scored = scorer.score(pcm)
        const p = typeof scored === 'number' ? scored : await scored
        onFrame({ pcm, p })
      }
    } catch (err) {
      log(`speech detector failed (${err instanceof Error ? err.message : String(err)}); using loudness`)
      record('hands-free-detector', { name: 'loudness', failed: err instanceof Error ? err.message : String(err) })
      scorer = new EnergyScorer()
      queued = []
      listener.resume()
    } finally {
      draining = false
    }
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
    queued.push(...framer.frames(pcm))
    if (queued.length > MAX_QUEUED_FRAMES) {
      log(`speech detector fell ${queued.length} frames behind: dropping them and listening afresh`)
      record('hands-free-behind', { frames: queued.length })
      queued = []
      listener.resume()
      return
    }
    void drain()
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
      record('hands-free-mic', { listening: false })
      return
    }
    downsampler = new Downsampler(next.sampleRate)
    framer.reset()
    queued = []
    scorer.reset()
    listener.resume()
    unlisten = next.listen(onBlock)
    if (useHandsFree.getState().phase === 'off') setPhase('listening')
    log(`listening for "${WAKE_WORD}" (${next.describe()})`)
    record('hands-free-mic', { listening: true, capture: next.describe() })
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
