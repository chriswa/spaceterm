import { create } from 'zustand'
import type { DictationApi, HandsFreeApi } from '../shared/api'
import type { HandsFreeTuning } from '../shared/protocol'
import { playCue, quietForMs, type Cue } from './cues'
import { Dictation, type DictationOptions } from './dictation'
import { heldCapture, onHoldStateChange, type Capture } from './held-microphone'
import { nativeHaptic, nativeSpeech } from './native-microphone'
import { recordMobileEvent } from './mobile-events'
import { nativePlayback } from './speech-player'
import { Downsampler, pcmToBase64 } from './pcm'
import { loadFrameScorer, type FrameScorer } from './speech-detector'
import { DEFAULT_TUNING, EnergyScorer, Framer, SpeechGate, UtteranceEndpointer, WakeListener, levelDb, type ScoredFrame, type WakeCandidate } from './wake-listener'

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
 * It does not listen while the page is playing anything (a cue, or Control's
 * voice in a browser) or for `playbackTailMs` after, so it never hears itself;
 * nor while a dictation it did not start is under way. In the app, Control's
 * voice is played by the app with echo cancellation (native-microphone.ts), so
 * it listens straight through it: anyone speaking turns Control down at once,
 * "Control" cuts it off and is dictated as ever, and if nothing is caught
 * after it Control says it had not finished and carries on. What survives of
 * Control's voice in the microphone is recorded per reply (`hands-free-echo`).
 *
 * After "Control", a conversation window opens: speech starts a dictation
 * without the wake word — the Mac checks only that it was words, not a cough
 * or filler — and so can cut Control off, echo cancellation permitting. It
 * stays open while either side is speaking and closes, with a tone, once
 * neither has for `conversationMs`; Control thinking does not hold it open.
 *
 * Nothing heard is logged: only that a candidate was or was not the word, and
 * its timings.
 */

export const WAKE_WORD = 'control'

export type HandsFreePhase = 'off' | 'listening' | 'hearing' | 'sending'

/**
 * `conversation`: the window after "Control" in which anything said starts a
 * dictation without it — open until neither side has spoken for
 * `conversationMs`. `secondsLeft`: how long it has left, whole seconds,
 * rounded up — full while anyone is speaking, since that holds it.
 */
export const useHandsFree = create<{ phase: HandsFreePhase; conversation: boolean; secondsLeft: number | null }>(
  () => ({ phase: 'off', conversation: false, secondsLeft: null }),
)

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
  /** Control's voice as the app plays it, with echo cancellation — or not playing. */
  nativeSpeech(): { playing: boolean; outputDb?: number; voiceProcessing: boolean }
  /** Turn Control's voice down while someone may be talking over it, and back up. */
  duckSpeech(on: boolean): void
  /** Stop Control mid-reply: the user cut in with "Control". */
  interruptControl(): void
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
  nativeSpeech: () => ({ playing: nativePlayback.playing(), outputDb: nativePlayback.outputDb(), voiceProcessing: nativeSpeech.voiceProcessing() }),
  duckSpeech: (on) => nativeSpeech.duck(on),
  interruptControl: () => window.api.receptionist.stop(),
})

/** While the page is hidden, how often to note that audio is still arriving. */
const BACKGROUND_REPORT_MS = 60_000
/** While listening, how often to record the room: how loud, and how much of it was speech. */
const LEVELS_REPORT_MS = 30_000
/** Frames waiting on a slow speech detector beyond this (about 3 s) are dropped, and listening starts afresh. */
const MAX_QUEUED_FRAMES = 100
/** Frames without speech (about half a second) before Control, turned down for someone talking, comes back up. */
const UNDUCK_FRAMES = 16
const FRAME_SECONDS = 512 / 16_000

/** What the microphone heard while Control's voice played through the app: how much of it got past echo cancellation. */
interface Echo {
  frames: number
  speechFrames: number
  run: number
  longestRun: number
  sumDb: number
  maxDb: number
  ducks: number
  outputDb?: number
}

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
  /** Control's voice playing through the app: what survived of it, and whether it is turned down for someone talking. */
  let echo: Echo | undefined
  let ducked = false
  let speechRun = 0
  let quietRun = 0
  /** Wake-word checks under way: Control stays turned down until each has its answer. */
  let checking = 0
  /** The conversation window, and how many frames neither side has spoken for. */
  let conversation = false
  let silentFrames = 0
  /**
   * Cleared when the server answers a `speech` check with the wake-word
   * question's answer: it predates the window and needs restarting. Until the
   * page reloads (as it does when the server comes back), no window opens.
   */
  let serverKnowsSpeech = true
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

  const secondsLeft = () => Math.max(0, Math.ceil((tuning.conversationMs - silentFrames * FRAME_SECONDS * 1000) / 1000))

  const openConversation = () => {
    silentFrames = 0
    if (!serverKnowsSpeech) return
    if (conversation) {
      if (useHandsFree.getState().secondsLeft !== secondsLeft()) useHandsFree.setState({ secondsLeft: secondsLeft() })
      return
    }
    conversation = true
    useHandsFree.setState({ conversation: true, secondsLeft: secondsLeft() })
    log('conversation window open: no need to say "Control" until we have both been quiet a while')
    record('hands-free-conversation', { open: true })
  }

  /**
   * `silence`: the window ran out; `server`: the server cannot run it. Both
   * say so with a tone. The microphone going closes it quietly.
   */
  const closeConversation = (why: 'silence' | 'microphone' | 'server') => {
    if (!conversation) return
    conversation = false
    silentFrames = 0
    useHandsFree.setState({ conversation: false, secondsLeft: null })
    log(`conversation window closed (${why}): "Control" again from here`)
    record('hands-free-conversation', { open: false, why })
    if (why !== 'microphone') deps.playCue('conversationClosed')
  }

  /**
   * Each frame, while the window is open: anyone speaking — the user (heard,
   * or being taken down) or Control's voice — holds it open; once both are
   * quiet, `conversationMs` of that closes it.
   */
  const tickConversation = (phase: HandsFreePhase) => {
    if (!conversation) return
    const someoneSpeaking = phase !== 'listening' || listener.speaking || deps.nativeSpeech().playing || deps.quietForMs() < tuning.playbackTailMs
    silentFrames = someoneSpeaking ? 0 : silentFrames + 1
    if (silentFrames * FRAME_SECONDS * 1000 >= tuning.conversationMs) {
      closeConversation('silence')
      return
    }
    // Only when the shown second changes: a store update a frame would redraw the bar 30 times a second.
    const left = secondsLeft()
    if (useHandsFree.getState().secondsLeft !== left) useHandsFree.setState({ secondsLeft: left })
  }

  /** `wakeWord`: the words began with "control" — always so for a wake-word match; for speech, as heard. */
  const check = (clip: Int16Array, mode: 'wake-word' | 'speech'): Promise<{ match: boolean; wakeWord: boolean }> =>
    api.handsFree.checkWakeWord(pcmToBase64(clip), mode).then(({ match, error, answered, wakeWord }) => {
      if (error && error !== checkError) log(`cannot check the wake word: ${error}`)
      checkError = error
      if (mode === 'speech' && !error && answered !== 'speech') {
        // Asked "words?", answered "does it start with Control?": a server from before the window.
        if (serverKnowsSpeech) {
          serverKnowsSpeech = false
          log('the server is too old for the conversation window — it answered the wake-word question instead. Restart the server.')
          record('hands-free-server-too-old')
          closeConversation('server')
        }
        return { match, wakeWord: match }
      }
      return { match, wakeWord: mode === 'wake-word' ? match : wakeWord === true }
    }, (err) => {
      log(`wake-word check failed: ${err instanceof Error ? err.message : String(err)}`)
      return { match: false, wakeWord: false }
    })

  const setDuck = (on: boolean) => {
    if (ducked === on) return
    ducked = on
    deps.duckSpeech(on)
    if (on && echo) echo.ducks++
    record('hands-free-duck', { on })
  }

  /**
   * Every frame while Control's voice plays through the app: anyone speaking
   * turns it down at once — echo cancellation means that is not Control
   * itself — and quiet brings it back once no check is pending. While
   * listening, what the microphone hears is counted, and when the reply ends
   * it is recorded: how much of Control's voice got past cancellation.
   */
  const trackPlayback = (frame: ScoredFrame, listening: boolean) => {
    const speech = deps.nativeSpeech()
    if (!speech.playing) {
      if (echo) {
        record('hands-free-echo', {
          seconds: Math.round(echo.frames * FRAME_SECONDS * 10) / 10,
          speechPercent: Math.round((100 * echo.speechFrames) / Math.max(1, echo.frames)),
          longestSpeechMs: Math.round(echo.longestRun * FRAME_SECONDS * 1000),
          micMeanDb: Math.round(echo.sumDb / Math.max(1, echo.frames)),
          micMaxDb: Math.round(echo.maxDb),
          outputDb: echo.outputDb ?? null,
          ducks: echo.ducks,
          voiceProcessing: speech.voiceProcessing,
        })
        echo = undefined
      }
      setDuck(false)
      speechRun = 0
      quietRun = 0
      return
    }
    if (frame.p >= SpeechGate.START) {
      speechRun++
      quietRun = 0
    } else {
      speechRun = 0
      if (frame.p < SpeechGate.STOP) quietRun++
    }
    if (!ducked && speechRun >= SpeechGate.START_FRAMES) setDuck(true)
    if (ducked && quietRun >= UNDUCK_FRAMES && checking === 0) setDuck(false)
    if (!listening) return
    echo ??= { frames: 0, speechFrames: 0, run: 0, longestRun: 0, sumDb: 0, maxDb: -120, ducks: ducked ? 1 : 0 }
    const db = levelDb(frame.pcm)
    echo.frames++
    echo.sumDb += db
    echo.maxDb = Math.max(echo.maxDb, db)
    echo.outputDb = speech.outputDb ?? echo.outputDb
    if (frame.p >= SpeechGate.START) {
      echo.speechFrames++
      echo.run++
      echo.longestRun = Math.max(echo.longestRun, echo.run)
    } else {
      echo.run = 0
    }
  }

  /** Control was cut off and nothing was caught after "Control": it says it had not finished, and carries on. */
  const carryOn = () => {
    log('cut Control off, then caught nothing: it carries on')
    record('hands-free-empty-interruption')
    api.handsFree.say('', true)
  }

  /**
   * The wake word heard — or, in the conversation window, words: dictate
   * from where the user started until they finish; send to Control.
   * `interrupted`: it cut Control's reply off, so even nothing caught is
   * worth telling it — it then carries on.
   */
  const respond = async ({ start, spokeMs }: WakeCandidate, interrupted = false, wakeWordStart = true) => {
    setPhase('hearing')
    deps.haptic()
    openConversation()
    let dictation: HandsFreeDictation | undefined
    try {
      if (!capture) throw new Error('the microphone went away')
      // Ends on what the turn model and the endpointer hear — or, if audio stops coming, on the clock.
      let ended: (reason: EndReason) => void = () => undefined
      const end = new Promise<EndReason>((resolve) => { ended = resolve })
      let backlogMs = 0
      dictation = await deps.beginDictation({
        forControl: true,
        backlog: () => {
          const audio = listener.audioSince(start)
          backlogMs = (audio.length / 16_000) * 1000
          return audio
        },
      })
      utterance = new UtteranceEndpointer(tuning, backlogMs, spokeMs, wakeWordStart)
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
        if (interrupted) carryOn()
        return
      }
      setPhase('sending')
      const text = cleanHandsFreeText(await dictation.finish())
      if (!text) {
        log(`nothing to send besides the wake word (ended on ${reason})`)
        // Control waits for this dictation's words, so it is told there are none.
        if (interrupted) carryOn()
        else api.handsFree.say('', false)
        return
      }
      log(`${text.length} chars to Control (ended on ${reason}${interrupted ? ', having cut it off' : ''})`)
      api.handsFree.say(text, interrupted)
      deps.playCue('pasted')
    } catch (err) {
      log(`dictation failed: ${err instanceof Error ? err.message : String(err)}`)
      dictation?.cancel()
      deps.playCue('transcriptionFailed')
      if (interrupted) carryOn()
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
    trackPlayback(frame, phase === 'listening')
    tickConversation(phase)
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
      // In the conversation window any words will do; otherwise they must start with "Control".
      const mode = conversation ? 'speech' : 'wake-word'
      log(`speech after ${candidate.noSpeechBeforeMs}ms without speech — checking its start ${mode === 'speech' ? 'for words' : `for "${WAKE_WORD}"`}`)
      const overControl = deps.nativeSpeech().playing
      checking++
      void check(candidate.clip, mode).then(({ match, wakeWord }) => {
        checking--
        log(match
          ? mode === 'speech' ? 'words, in the conversation window: dictating from its start' : 'it starts with the wake word: dictating from its start'
          : mode === 'speech' ? 'not words (a cough, filler, nothing)' : 'not the wake word')
        record('wake-word', { match, mode, wakeWord, noSpeechBeforeMs: candidate.noSpeechBeforeMs, spokeMs: candidate.spokeMs, overControl })
        if (!match || useHandsFree.getState().phase !== 'listening' || !capture) {
          // Not for Control: back up, unless they are still talking.
          if (ducked && quietRun >= UNDUCK_FRAMES && checking === 0) setDuck(false)
          return
        }
        // Said over Control's reply: cut it off — its record keeps how much was heard.
        const interrupting = deps.nativeSpeech().playing
        if (interrupting) {
          log(mode === 'speech' ? 'words over its own reply: cutting it off' : '"Control" over its own reply: cutting it off')
          record('hands-free-interrupt', { mode })
          deps.interruptControl()
        }
        // Began with "Control", window or not: "Control." and a breath waits for the rest.
        void respond(candidate, interrupting, wakeWord)
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
      closeConversation('microphone')
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
    closeConversation('microphone')
    setPhase('off')
  }
}
