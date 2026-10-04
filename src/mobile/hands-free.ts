import { create } from 'zustand'
import type { DictationApi, HandsFreeApi } from '../shared/api'
import type { HandsFreeTuning } from '../shared/protocol'
import { cueMs, playCue, quietForMs, type Cue } from './cues'
import { Dictation } from './dictation'
import { heldCapture, onHoldStateChange, type Capture } from './held-microphone'
import { Downsampler, pcmToBase64 } from './pcm'
import { DEFAULT_TUNING, UtteranceEndpointer, WakeListener } from './wake-listener'

/**
 * Hands-free mode: say "Control", pause, hear the cue, and talk.
 *
 * Runs whenever this phone holds its microphone open (held-microphone.ts) —
 * the hold button *is* the always-listen switch. What the microphone hears
 * goes through `WakeListener`, on the phone; nothing leaves it unless a short
 * burst with quiet before it looks like one word. That clip goes to the Mac,
 * where Voice Operator checks it with Apple's on-device model (never Wispr).
 * If it was "control", and the quiet after it lasted, the start cue plays and
 * an ordinary Wispr dictation opens on the microphone that is already open —
 * exactly as if the talk button had been pressed — and ends on silence. The
 * words go to Control, which comes to this device.
 *
 * It does not listen while this phone is playing anything (Control's voice, a
 * cue) or for `playbackTailMs` after, so it never hears itself; nor while a
 * dictation it did not start is under way.
 *
 * Nothing heard is logged: only that a candidate was or was not the word, and
 * its timings.
 */

export type HandsFreePhase = 'off' | 'listening' | 'hearing' | 'sending'

export const useHandsFree = create<{ phase: HandsFreePhase }>(() => ({ phase: 'off' }))

/** A dictation as hands-free mode drives it. */
export interface HandsFreeDictation {
  finish(): Promise<string>
  cancel(): void
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
  cueMs(cue: Cue): number
  /** A dictation on the held microphone. */
  beginDictation(): Promise<HandsFreeDictation>
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
  cueMs,
  beginDictation: () => Dictation.begin(api.dictation),
  // Its own dictation counts as one while it is hearing; see `hearing` below.
  othersDictating: () => Dictation.live > (useHandsFree.getState().phase === 'hearing' ? 1 : 0),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
})

/** How long after the start cue ends before the dictation opens, so the cue is not in it. */
const AFTER_CUE_MS = 60
/** While the page is hidden, how often to note that audio is still arriving. */
const BACKGROUND_REPORT_MS = 60_000

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
  /** Each candidate's check, until its pause or withdrawal. */
  const checks = new Map<number, Promise<boolean>>()
  /** The dictation after the cue, fed to its endpointer, and how to say it has ended. */
  let utterance: UtteranceEndpointer | undefined
  /** `lost`: the microphone went away, or stopped sending, mid-dictation. */
  let endUtterance: ((reason: 'silence' | 'no-speech' | 'too-long' | 'lost') => void) | undefined
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

  /** The wake word, then the pause: cue, dictate until quiet, send to Control. */
  const respond = async () => {
    setPhase('hearing')
    let dictation: HandsFreeDictation | undefined
    try {
      deps.playCue('listeningStarted')
      await deps.sleep(deps.cueMs('listeningStarted') + AFTER_CUE_MS)
      if (!capture) throw new Error('the microphone went away')
      dictation = await deps.beginDictation()
      // Ends on what the endpointer hears — or, if audio stops coming, on the clock.
      const reason = await new Promise<'silence' | 'no-speech' | 'too-long' | 'lost'>((resolve) => {
        utterance = new UtteranceEndpointer(tuning)
        endUtterance = resolve
        void deps.sleep(tuning.maxUtteranceMs + tuning.noSpeechTimeoutMs).then(() => resolve('lost'))
      })
      utterance = undefined
      endUtterance = undefined
      if (reason === 'no-speech' || reason === 'lost') {
        log(reason === 'lost' ? 'the microphone stopped mid-dictation' : 'nothing said after the cue')
        dictation.cancel()
        deps.playCue('listeningFinished')
        return
      }
      deps.playCue('listeningFinished')
      setPhase('sending')
      const text = (await dictation.finish()).trim()
      if (!text) {
        log('Wispr heard nothing')
        deps.playCue('transcriptionFailed')
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
      endUtterance = undefined
      setPhase(capture ? 'listening' : 'off')
      listener.resume()
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
    const phase = useHandsFree.getState().phase
    if (phase === 'hearing') {
      if (!utterance) return
      for (const event of utterance.push(pcm)) {
        if (event.kind === 'ended') endUtterance?.(event.reason)
      }
      return
    }
    if (phase !== 'listening') return
    if (deps.quietForMs() < tuning.playbackTailMs || deps.othersDictating()) {
      if (!stoodAside) checks.clear()
      stoodAside = true
      return
    }
    if (stoodAside) {
      stoodAside = false
      listener.resume()
    }
    for (const event of listener.push(pcm)) {
      if (event.kind === 'candidate') {
        log(`candidate: ${event.wordMs}ms of speech after ${event.quietBeforeMs}ms of quiet — checking`)
        checks.set(event.id, check(event.clip))
      } else if (event.kind === 'withdrawn') {
        checks.delete(event.id)
        log('candidate withdrawn: talk carried straight on')
      } else {
        const verdict = checks.get(event.id)
        checks.delete(event.id)
        void verdict?.then((match) => {
          log(match ? 'wake word, then the pause: listening' : 'not the wake word')
          if (match && useHandsFree.getState().phase === 'listening') void respond()
        })
      }
    }
  }

  /** Follow the hold: listen to the held microphone while there is one. */
  const follow = () => {
    const next = deps.heldCapture()
    if (next === capture) return
    unlisten?.()
    unlisten = undefined
    capture = next
    checks.clear()
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
    log(`listening for the wake word (${next.describe()})`)
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
