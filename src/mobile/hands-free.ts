import { create } from 'zustand'
import type { DictationApi, HandsFreeApi } from '../shared/api'
import { isControlShutdown, LET_ME_TURN_THIS_OFF } from '../shared/control-shutdown'
import type { HandsFreeTuning } from '../shared/protocol'
import { playCue, playHandsFreeCue, playPendingTone, quietForMs, type Cue, type HandsFreeCue } from './cues'
import { noteUserInterrupted } from './control-tones'
import { Dictation, type DictationOptions } from './dictation'
import { heldCapture, holdsMicrophone, onHoldStateChange, type Capture } from './held-microphone'
import { nativeHaptic, nativeSpeech, type HapticPattern } from './native-microphone'
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
 * the hands-free button beside the microphone button (HandsFreeButton.tsx) *is* the always-listen switch. What the microphone hears
 * goes through `WakeListener`, on the phone, scored frame by frame for speech
 * by a voice-activity model (speech-detector.ts) — so music or a noisy room is
 * not speech. Nothing leaves the phone unless the user starts talking with
 * nobody talking just before: then the first second of that goes to
 * the Mac, where Voice Operator checks, with Apple's on-device model (never
 * Wispr), whether its first word is "control". Only "Control" said first
 * counts; the word anywhere else in a sentence does not.
 *
 * On a match the phone taps once (a haptic, in the app) and the microphone button
 * turns orange, and an ordinary Wispr dictation opens on the microphone that is
 * already open — fed everything said since the first syllable, out of the
 * listener's buffer, then live. So nothing waits on the check: it is
 * retroactive. A start tone would land mid-sentence, in the recording; two
 * taps at the end are the confirmation that it was heard and sent.
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
 * After "Control", and as hands-free is turned on, a conversation window opens: speech starts a dictation
 * without the wake word — the Mac checks only that it was words, not a cough
 * or filler — and so can cut Control off, echo cancellation permitting. It
 * stays open while either side is speaking and closes, with a tone, once
 * neither has for `conversationMs`; Control thinking does not hold it open.
 * "Let me turn this off" or "Control, shutdown" (control-shutdown.ts) closes
 * it at once, with a tone of its own, as the server sends Control away:
 * nothing more is taken down until "Control" again. "Let me turn this off"
 * needs no "Control": speech whose start the Mac hears as the start of it is
 * watched until it ends, and the whole of it checked (`watchForShutdown`).
 *
 * Outside the window, from the first syllable of what may be speech until
 * it is decided, a soft beep repeats (`playPendingTone`, cues.ts) — "Control"
 * is needed — and stops as the dictation's chirp plays or the speech turns
 * out to be nothing. Speech the Mac says does not start with "Control" is
 * thrown away, and a sad falling tune says so (`notWakeWord`). In the window,
 * where any words will do, neither plays.
 *
 * The phone logs nothing heard: only that a candidate was or was not the
 * word, and its timings. The Mac keeps what was heard, with the audio, in
 * `voice-decisions.jsonl` (src/server/voice-record.ts).
 */

export const WAKE_WORD = 'control'

export type HandsFreePhase = 'off' | 'listening' | 'hearing' | 'sending'

/**
 * `conversation`: the window after "Control" in which anything said starts a
 * dictation without it — open until neither side has spoken for
 * `conversationMs`. `secondsLeft`: how long it has left, whole seconds,
 * rounded up — full while anyone is speaking, since that holds it.
 * `checking`: speech was heard and is being checked on the Mac — for "Control",
 * or for being words — and nothing has been decided yet.
 * `turn`: the turn model's latest answer at a pause in this dictation, with
 * the threshold it was held to — shown on the hands-free button
 * (HandsFreeButton.tsx). Null until the first pause and once they carry on;
 * kept while what was said is sent, so what ended it can be seen.
 * `sampling`: the threshold the answers are held to, while the turn model is
 * being asked about a pause (`TURN_SAMPLE_MS`); null otherwise.
 */
export const useHandsFree = create<{ phase: HandsFreePhase; conversation: boolean; secondsLeft: number | null; checking: boolean; turn: TurnAnswer | null; sampling: number | null }>(
  () => ({ phase: 'off', conversation: false, secondsLeft: null, checking: false, turn: null, sampling: null }),
)

let readEndSilence: () => number | null = () => null

/**
 * How far the quiet has got towards ending hands-free's dictation by itself,
 * 0..1 (UtteranceEndpointer.silence); null with no dictation. Read once a
 * frame by the hands-free button — not a store, which would redraw it every
 * 32 ms of audio.
 */
export function endSilence(): number | null {
  return readEndSilence()
}

/** One answer from the turn model: `p`, 0..1, that the speaker has finished; at or above `threshold`, the dictation ends. */
export interface TurnAnswer { p: number; threshold: number }

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
  /** Whether holding is turned on, though the microphone may be reopening. */
  holdWanted(): boolean
  onHoldStateChange(fn: () => void): () => void
  /** How long this device has been silent; 0 while it plays. */
  quietForMs(): number
  playCue(cue: Cue): void
  /** One of hands-free's own tones: heard whatever Replies is set to. */
  handsFreeCue(cue: HandsFreeCue): void
  /** The beep repeated while it decides whether what may be speech starts with "Control"; `false` stops it. */
  pendingTone(on: boolean): void
  /** A tap the user can feel: the wake word was heard. Nothing, where there is no way to. */
  haptic(pattern: HapticPattern): void
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
  /** Whether Control's voice is playing anywhere, as the server says — on the Mac, through Voice Operator, too. */
  controlSpeaking(): boolean
  /** Turn Control's voice down while someone may be talking over it, and back up. */
  duckSpeech(on: boolean): void
  /**
   * Stop Control mid-reply: the user cut in. `cutInMsAgo`: how long ago they
   * began talking — the check that decided it was for Control took that long,
   * and Control was turned down, not heard, all the while. What was heard is
   * counted up to then, not to now.
   */
  interruptControl(cutInMsAgo: number): void
}

const REAL_DEPS = (api: HandsFreeDeps['api']): HandsFreeDeps => {
  // As broadcast word by word (receptionist-speaking): a page loaded mid-reply hears of it at the next word.
  let controlSpeaking = false
  window.api.receptionist.onSpeaking((speaking) => { controlSpeaking = speaking !== null })
  return {
    api,
    log: (message) => window.api?.log(`[hands-free] ${message}`),
    heldCapture,
    holdWanted: holdsMicrophone,
    onHoldStateChange,
    quietForMs,
    playCue,
    handsFreeCue: playHandsFreeCue,
    pendingTone: playPendingTone,
    haptic: nativeHaptic,
    beginDictation: (options) => Dictation.begin(api.dictation, options),
    // Its own dictation counts as one while it is hearing; see `hearing` below.
    othersDictating: () => Dictation.live > (useHandsFree.getState().phase === 'hearing' ? 1 : 0),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    loadScorer: () => loadFrameScorer((message) => window.api?.log(`[hands-free] ${message}`)),
    record: (kind, detail) => recordMobileEvent(kind, detail),
    nativeSpeech: () => ({ playing: nativePlayback.playing(), outputDb: nativePlayback.outputDb(), voiceProcessing: nativeSpeech.voiceProcessing() }),
    duckSpeech: (on) => nativeSpeech.duck(on),
    controlSpeaking: () => controlSpeaking,
    interruptControl: (cutInMsAgo) => {
      noteUserInterrupted()
      window.api.receptionist.stop(cutInMsAgo)
    },
  }
}

/** While the page is hidden, how often to note that audio is still arriving. */
const BACKGROUND_REPORT_MS = 60_000
/** While listening, how often to record the room: how loud, and how much of it was speech. */
const LEVELS_REPORT_MS = 30_000
/**
 * Through a pause, the turn model is asked again this often — a series of
 * answers, not one — or as soon as the last answer is back, if that took
 * longer. One question at a time: the Mac answers in 60–180 ms.
 */
const TURN_SAMPLE_MS = 500
/** Frames waiting on a slow speech detector beyond this (about 3 s) are dropped, and listening starts afresh. */
const MAX_QUEUED_FRAMES = 100
/** Frames without speech (about half a second) before Control, turned down for someone talking, comes back up. */
const UNDUCK_FRAMES = 16
const FRAME_SECONDS = 512 / 16_000
/** Quiet (about half a second) that ends speech watched for "let me turn this off", so the whole of it is checked. */
const SHUTDOWN_END_FRAMES = 16
/** Speech watched for it that runs past this (about four seconds) is something longer, and let go. */
const SHUTDOWN_MAX_FRAMES = 125

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
    // Sending keeps the last answer, beside the quiet that may have ended it instead.
    useHandsFree.setState(phase === 'sending' ? { phase, sampling: null } : { phase, turn: null, sampling: null })
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
  /** Of those, the ones for speech the listener handed out — not "let me turn this off" — which the pending tone waits on. */
  let candidatesChecking = 0
  let pendingTone = false
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
  /** Bumped at every pause, every resumption, and the dictation's end: a turn verdict counts only for the pause it was asked about. */
  let pauseNumber = 0
  /** No more asking about this pause: the dictation has ended. Its last answer stays shown. */
  const stopSampling = () => {
    pauseNumber++
    if (useHandsFree.getState().sampling !== null) useHandsFree.setState({ sampling: null })
  }
  /**
   * The pause is over — they carried on, or a new one is being asked about:
   * any verdict on it is moot, so it is neither acted on nor shown.
   */
  const pauseOver = () => {
    stopSampling()
    if (useHandsFree.getState().turn) useHandsFree.setState({ turn: null })
  }
  let checkError: string | undefined
  /**
   * Speech outside the window whose start was heard as the start of "let me
   * turn this off": where it began, and how many frames it has gone on and
   * been quiet for, until it ends and the whole of it is checked.
   */
  let shutdownWatch: { start: number; frames: number; quietFrames: number } | undefined
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
    listener.setConversation(true)
    useHandsFree.setState({ conversation: true, secondsLeft: secondsLeft() })
    log('conversation window open: no need to say "Control" until we have both been quiet a while')
    record('hands-free-conversation', { open: true })
  }

  /**
   * `silence`: the window ran out; `server`: the server cannot run it. Both
   * say so with a tone. `shutdown`: "Control, shutdown", with its own. The
   * microphone going — turned off, or not back within `conversationMs` —
   * closes it quietly.
   */
  const closeConversation = (why: 'silence' | 'microphone' | 'server' | 'shutdown') => {
    if (!conversation) return
    conversation = false
    listener.setConversation(false)
    silentFrames = 0
    useHandsFree.setState({ conversation: false, secondsLeft: null })
    log(`conversation window closed (${why}): "Control" again from here`)
    record('hands-free-conversation', { open: false, why })
    if (why === 'shutdown') deps.handsFreeCue('controlShutdown')
    else if (why !== 'microphone') deps.handsFreeCue('conversationClosed')
    // Ran out: felt too, in a pocket, as three.
    if (why === 'silence') deps.haptic('triple')
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
  const check = (clip: Int16Array, mode: 'wake-word' | 'speech'): Promise<{ match: boolean; wakeWord: boolean; shutdown?: 'whole' | 'start' }> =>
    api.handsFree.checkWakeWord(pcmToBase64(clip), mode).then(({ match, error, answered, wakeWord, shutdown }) => {
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
      return { match, wakeWord: mode === 'wake-word' ? match : wakeWord === true, shutdown }
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
   * The pending tone, as things stand: on while listening outside the
   * conversation window and what may be speech is undecided — under way and
   * not yet checked, or being checked for "Control". Off as a dictation
   * starts, before its chirp, and whenever listening stops.
   */
  const updatePendingTone = () => {
    const on = useHandsFree.getState().phase === 'listening' && capture !== undefined && !stoodAside && !conversation
      && (listener.undecided || candidatesChecking > 0)
    if (on === pendingTone) return
    pendingTone = on
    deps.pendingTone(on)
    record('hands-free-pending-tone', { on })
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

  /**
   * A phrase that sends Control away (control-shutdown.ts): the server lets go
   * of Control on these words, and the phone stops taking anything down for
   * it — the window closes, with the tone, or the tone alone if it was shut.
   * `dictated` after "Control" or in the window; `heard` without either.
   */
  const sendAway = (text: string, interrupted: boolean, how: 'dictated' | 'heard') => {
    log(`sending Control away (${how})`)
    api.handsFree.say(text, interrupted)
    record('hands-free-shutdown', { interrupted, how })
    if (conversation) closeConversation('shutdown')
    else deps.handsFreeCue('controlShutdown')
  }

  /**
   * Each frame while listening, for speech being watched for "let me turn this
   * off": once it has been quiet for `SHUTDOWN_END_FRAMES`, the whole of it,
   * out of the listener's buffer, is checked on the Mac as the window's speech
   * is — and if it was the phrase and nothing else, Control is sent away.
   * Speech that runs on is something longer, and let go unchecked.
   */
  const watchForShutdown = () => {
    const watch = shutdownWatch
    if (!watch) return
    watch.frames++
    watch.quietFrames = listener.speaking ? 0 : watch.quietFrames + 1
    if (watch.frames > SHUTDOWN_MAX_FRAMES) {
      shutdownWatch = undefined
      record('hands-free-shutdown-check', { verdict: 'too-long' })
      // Something longer, without "Control": thrown away.
      deps.handsFreeCue('notWakeWord')
      return
    }
    if (watch.quietFrames < SHUTDOWN_END_FRAMES) return
    shutdownWatch = undefined
    const clip = listener.audioSince(watch.start)
    checking++
    useHandsFree.setState({ checking: true })
    void check(clip, 'speech').then(({ shutdown }) => {
      checking--
      if (checking === 0) useHandsFree.setState({ checking: false })
      const whole = shutdown === 'whole'
      record('hands-free-shutdown-check', { verdict: whole ? 'whole' : 'not-it', ms: Math.round((clip.length / 16_000) * 1000) })
      if (whole && useHandsFree.getState().phase === 'listening' && capture) {
        sendAway(LET_ME_TURN_THIS_OFF.join(' '), false, 'heard')
        return
      }
      log('not "let me turn this off" after all')
      // Nor "Control": thrown away.
      if (useHandsFree.getState().phase === 'listening' && capture) deps.handsFreeCue('notWakeWord')
      if (ducked && quietRun >= UNDUCK_FRAMES && checking === 0) setDuck(false)
    })
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
    updatePendingTone()
    shutdownWatch = undefined
    deps.haptic('tap')
    deps.handsFreeCue('dictationStart')
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
      stopSampling()
      utterance = undefined
      utteranceDictation = undefined
      endUtterance = undefined
      deps.haptic('double')
      deps.handsFreeCue('dictationEnd')
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
      if (isControlShutdown(text)) sendAway(text, interrupted, 'dictated')
      else api.handsFree.say(text, interrupted)
    } catch (err) {
      log(`dictation failed: ${err instanceof Error ? err.message : String(err)}`)
      dictation?.cancel()
      deps.playCue('error')
      if (interrupted) carryOn()
    } finally {
      utterance = undefined
      utteranceDictation = undefined
      endUtterance = undefined
      setPhase(capture ? 'listening' : 'off')
      listener.resume()
    }
  }

  /**
   * A pause: ask the turn model every `TURN_SAMPLE_MS` for as long as it
   * lasts, and end here the first time it is sure enough they have finished.
   * Stops when they carry on — an answer arriving after that is about a pause
   * that is over, and is dropped — or when the dictation ends some other way.
   */
  const samplePause = async (talkMs: number) => {
    pauseOver()
    const pause = pauseNumber
    const dictation = utteranceDictation
    if (!dictation) return
    useHandsFree.setState({ sampling: tuning.turnThreshold })
    for (let sample = 1; pause === pauseNumber; sample++) {
      const next = deps.sleep(TURN_SAMPLE_MS)
      const p = await dictation.checkTurn()
      const current = pause === pauseNumber
      log(`pause after ${(talkMs / 1000).toFixed(1)}s, sample ${sample}: ${p === null ? 'no turn verdict' : `p(finished)=${p.toFixed(2)}`}${current ? '' : ', but it is over'}`)
      const ends = current && p !== null && p >= tuning.turnThreshold
      record('hands-free-turn', { talkMs: Math.round(talkMs), sample, p, threshold: tuning.turnThreshold, ends, carriedOn: !current })
      if (!current) return
      if (p !== null) useHandsFree.setState({ turn: { p, threshold: tuning.turnThreshold } })
      if (ends) {
        stopSampling()
        endUtterance?.('finished')
        return
      }
      await next
    }
  }

  /** One scored frame, routed by phase: to the endpointer while dictating, else to the wake-word listener. */
  const routeFrame = (frame: ScoredFrame) => {
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
        else if (event.kind === 'resumed') pauseOver()
        else if (event.wakeWordOnly) {
          // "Control." and a breath: the turn model would call that finished. Wait for the rest.
          log('pause after the wake word alone: waiting for the rest, not asking the turn model')
          record('hands-free-pause', { talkMs: event.talkMs, wakeWordOnly: true })
        } else void samplePause(event.talkMs)
      }
      return
    }
    if (phase !== 'listening') return
    if (deps.quietForMs() < tuning.playbackTailMs || deps.othersDictating()) {
      // Deaf to "Control" until this ends: the phone is talking, or another dictation has the floor.
      if (!stoodAside) record('hands-free-stood-aside', { why: deps.othersDictating() ? 'another dictation' : 'this phone is playing' })
      stoodAside = true
      shutdownWatch = undefined
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
      candidatesChecking++
      useHandsFree.setState({ checking: true })
      void check(candidate.clip, mode).then(({ match, wakeWord, shutdown }) => {
        checking--
        candidatesChecking--
        if (checking === 0) useHandsFree.setState({ checking: false })
        // Decided: off now, before a dictation's chirp, unless more speech is under way.
        updatePendingTone()
        log(match
          ? mode === 'speech' ? 'words, in the conversation window: dictating from its start' : 'it starts with the wake word: dictating from its start'
          : mode === 'speech' ? 'not words (a cough, filler, nothing)' : 'not the wake word')
        record('wake-word', { match, mode, wakeWord, noSpeechBeforeMs: candidate.noSpeechBeforeMs, spokeMs: candidate.spokeMs, overControl })
        if (!match && mode === 'wake-word' && useHandsFree.getState().phase === 'listening' && capture) {
          if (shutdown) {
            // Perhaps "let me turn this off", which needs no "Control": wait for it to end, then check the whole of it.
            log('it may be "let me turn this off": checking the whole of it once it ends')
            shutdownWatch = { start: candidate.start, frames: 0, quietFrames: 0 }
          } else {
            // Not "Control": what they are saying is thrown away, and they hear so.
            deps.handsFreeCue('notWakeWord')
          }
        }
        if (!match || useHandsFree.getState().phase !== 'listening' || !capture) {
          // Not for Control: back up, unless they are still talking.
          if (ducked && quietRun >= UNDUCK_FRAMES && checking === 0) setDuck(false)
          return
        }
        // Said over Control's reply, here or on the Mac: cut it off — its record keeps how much was heard.
        // Stopped from here even when the Mac plays it, so the stop is dated to when they began, not to the dictation's start.
        const here = deps.nativeSpeech().playing
        const interrupting = here || deps.controlSpeaking()
        if (interrupting) {
          // From the first syllable, in audio heard — so a check that took a while costs none of it — plus any still waiting to be scored.
          const cutInMsAgo = Math.round(listener.msSince(candidate.start) + queued.length * FRAME_SECONDS * 1000)
          log(`${mode === 'speech' ? 'words' : '"Control"'} over its reply${here ? '' : ' on another device'}: cutting it off as of ${cutInMsAgo}ms ago, when they began`)
          record('hands-free-interrupt', { mode, cutInMsAgo, here })
          deps.interruptControl(cutInMsAgo)
        }
        // Began with "Control", window or not: "Control." and a breath waits for the rest.
        void respond(candidate, interrupting, wakeWord)
      })
    }
    watchForShutdown()
  }

  /** One scored frame, routed by phase, and the pending tone brought up to date. */
  const onFrame = (frame: ScoredFrame) => {
    routeFrame(frame)
    updatePendingTone()
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

  /** Bumped whenever the microphone goes: a wait for it to come back counts only for the loss it began at. */
  let micLosses = 0
  /** The microphone went with holding still on: when it comes back, that is a reopening, not hands-free turned on. */
  let reopening = false

  /**
   * Follow the hold: listen to the held microphone while there is one. The
   * app reopens its microphone when it stalls — routinely, after a cue or
   * Control's voice takes the audio session — so a hold still turned on keeps
   * the conversation window open for `conversationMs`, waiting for it.
   * Turning hands-free on opens the window too, so the first words need no
   * "Control"; a reopened microphone leaves it as it was.
   */
  const follow = () => {
    const next = deps.heldCapture()
    if (next === capture) return
    unlisten?.()
    unlisten = undefined
    capture = next
    if (!next) {
      downsampler = undefined
      endUtterance?.('lost')
      const loss = ++micLosses
      reopening = deps.holdWanted()
      if (!deps.holdWanted()) closeConversation('microphone')
      else if (conversation) {
        log('the microphone is reopening: the conversation window waits for it')
        void deps.sleep(tuning.conversationMs).then(() => { if (!capture && loss === micLosses) closeConversation('microphone') })
      }
      if (useHandsFree.getState().phase === 'listening') setPhase('off')
      updatePendingTone()
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
    if (!reopening) openConversation()
    reopening = false
  }
  follow()
  const offHold = deps.onHoldStateChange(follow)
  readEndSilence = () => utterance?.silence() ?? null

  return () => {
    readEndSilence = () => null
    offHold()
    offTuning()
    unlisten?.()
    capture = undefined
    closeConversation('microphone')
    useHandsFree.setState({ checking: false })
    setPhase('off')
    updatePendingTone()
  }
}
