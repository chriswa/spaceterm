import { create } from 'zustand'
import type { HandsFreeApi } from '../shared/api'
import { playCue, playHandsFreeCue, playPendingTone, type Cue, type HandsFreeCue } from './cues'
import { noteUserInterrupted } from './control-tones'
import { nativeHandsFree, nativeHaptic, type HapticPattern } from './native-microphone'
import { recordMobileEvent } from './mobile-events'

/**
 * Hands-free mode: start talking with "Control" and just keep going — "Control,
 * what's Kevin doing?" — and stop when you are done.
 *
 * Voice Operator runs it (its DESIGN.md, "Hands-free"). Everything that
 * listens and decides happens there, on the Mac: the speech detector, whether
 * speech began with "control", the conversation window after it, when the
 * speaker has finished (turn-1-mini, and a silence timeout that grows a little
 * with how long they have been talking), the transcription, and "let me turn this off". On
 * the Mac it listens to the Mac's microphone; on the phone, Voice Operator's
 * SDK in the iPhone app streams the app's microphone to it, the page carrying
 * its lines through the server. What is left here is being its client:
 *
 * - switching it on and off (`HandsFreeLink`): the Mac's through the server,
 *   the phone's with its hold (hands-free-mode.ts);
 * - showing what it is doing: the phase (the microphone button's orange), the
 *   conversation window and its countdown, the turn model's answers and the
 *   quiet that may end a dictation, and when it is not listening because our
 *   own voice is playing (HandsFreeButton.tsx), all from Voice Operator's
 *   messages, animated here between its data points;
 * - its cues and haptics, as this device plays them, and the "deciding" beep
 *   while it says speech is undecided — on the Mac, in the one window the
 *   server says plays them.
 *
 * Control is not this module's: the server reads Voice Operator's messages
 * before they get here, gives Control the words it hands back, and stops
 * Control when it says the user cut it off — once, however many windows are
 * open (src/server/voice-operator-hands-free.ts).
 *
 * The record of what was heard and decided is Voice Operator's now
 * (`hands-free/decisions.jsonl` in its Application Support), as are the
 * models and the tuning.
 */

export type HandsFreePhase = 'off' | 'listening' | 'hearing' | 'sending'

/**
 * Why Voice Operator is not listening to the microphone just now, though
 * hands-free is listening: `speech`, our own voice playing where the
 * microphone would hear it (Control on the phone's speaker, Voice Operator on
 * the Mac's); `sound`, a cue of ours; `dictation`, a Fn dictation on the Mac.
 */
export type StandingAside = 'speech' | 'sound' | 'dictation'

/**
 * `on`: hands-free is wanted on this device. `conversation`: the window after
 * "Control" in which anything said starts a dictation without it.
 * `secondsLeft`: how long it has left, whole seconds, rounded up — full while
 * anyone is speaking, since that holds it. `checking`: speech was heard and is
 * being checked. `mini`: the turn model's latest answer in this dictation;
 * kept while what was said is sent, so what ended it can be seen.
 * `standingAside`: not listening to the microphone, and why; null while it is.
 */
export const useHandsFree = create<{ on: boolean; phase: HandsFreePhase; conversation: boolean; secondsLeft: number | null; checking: boolean; mini: MiniAnswer | null; standingAside: StandingAside | null }>(
  () => ({ on: false, phase: 'off', conversation: false, secondsLeft: null, checking: false, mini: null, standingAside: null }),
)

const STANDING_ASIDE: readonly StandingAside[] = ['speech', 'sound', 'dictation']

/**
 * turn-1-mini, which decides when a dictation ends: its latest answer `p`,
 * 0..1, that the speaker has finished, its highest since this pause began
 * (`peak`, null while they talk), and the `threshold` that ends the
 * dictation, for the button's left half.
 */
export interface MiniAnswer { p: number; peak: number | null; threshold: number }

/** The quiet gauge's data points, from Voice Operator's `gauge`. */
let quiet: { since: number | null; patienceMs: number | null } = { since: null, patienceMs: null }

/**
 * How far the quiet has got towards ending hands-free's dictation by itself,
 * 0..1; null with no dictation. Read once a frame by the hands-free button —
 * computed from Voice Operator's last data point, not sent a frame at a time.
 */
export function endSilence(now = Date.now()): number | null {
  const phase = useHandsFree.getState().phase
  if (phase !== 'hearing' && phase !== 'sending') return null
  if (quiet.since === null || !quiet.patienceMs) return 0
  return Math.max(0, Math.min(1, (now - quiet.since) / quiet.patienceMs))
}

/** Where Voice Operator's hands-free is switched on and off, and where what it says comes from. */
export interface HandsFreeLink {
  start(): void
  stop(): void
  /** Each of Voice Operator's messages about this device's session, as it sent it, and whether this client plays its sounds. */
  onEvent(fn: (event: Record<string, unknown>, audio: boolean) => void): () => void
}

/** Everything outside this module it touches, so a test can supply its own. */
export interface HandsFreeDeps {
  link: HandsFreeLink
  log(message: string): void
  handsFreeCue(cue: HandsFreeCue): void
  playCue(cue: Cue): void
  pendingTone(on: boolean): void
  haptic(pattern: HapticPattern): void
  /** The user cut Control off (the server has stopped it): its going quiet is no failure. */
  noteCutIn(): void
  record(kind: string, detail?: Record<string, unknown>): void
  now(): number
  /** Run `fn` every `ms` until the returned function is called. */
  every(ms: number, fn: () => void): () => void
}

export const realHandsFreeDeps = (link: HandsFreeLink): HandsFreeDeps => ({
  link,
  log: (message) => window.api?.log(`[hands-free] ${message}`),
  handsFreeCue: playHandsFreeCue,
  playCue,
  pendingTone: playPendingTone,
  haptic: nativeHaptic,
  noteCutIn: () => noteUserInterrupted(),
  record: (kind, detail) => recordMobileEvent(kind, detail),
  now: () => Date.now(),
  every: (ms, fn) => {
    const timer = setInterval(fn, ms)
    return () => clearInterval(timer)
  },
})

/** Voice Operator's cue names, as this device's tones. */
const CUES: Record<string, HandsFreeCue> = {
  ready: 'handsFreeReady',
  dictationStart: 'dictationStart',
  dictationEnd: 'dictationEnd',
  notWakeWord: 'notWakeWord',
  conversationClosed: 'conversationClosed',
  shutdown: 'controlShutdown',
}

const HAPTICS = new Set<string>(['tap', 'double', 'triple'])

/** The window's length, for the countdown while it is held open. */
const CONVERSATION_SECONDS = 15

/** Turn hands-free on or off on this device: set by `installHandsFree`. */
let setOn: (on: boolean) => void = () => {}

export function setHandsFree(on: boolean): void {
  setOn(on)
}

/**
 * Follow Voice Operator's hands-free on `link`: its messages into the store,
 * cues and haptics into this device's, its words into Control.
 */
export function installHandsFree(deps: HandsFreeDeps): () => void {
  const { log, record } = deps
  let pending = false
  let closesAt: number | null = null
  const setPending = (on: boolean) => {
    if (on === pending) return
    pending = on
    deps.pendingTone(on)
  }
  const tickSeconds = () => {
    const { conversation, secondsLeft } = useHandsFree.getState()
    const left = !conversation ? null : closesAt === null ? CONVERSATION_SECONDS
      : Math.max(0, Math.ceil((closesAt - deps.now()) / 1000))
    if (left !== secondsLeft) useHandsFree.setState({ secondsLeft: left })
  }
  const stopTicking = deps.every(250, tickSeconds)

  const offEvents = deps.link.onEvent((event, audio) => {
    switch (event.type) {
      case 'session':
        log(`on (${String(event.source ?? 'mac')})`)
        record('hands-free-session', { on: true, source: event.source ?? null })
        // On the Mac, turned on from another window: this one shows it too.
        if (!useHandsFree.getState().on) useHandsFree.setState({ on: true })
        break
      case 'session-ended': {
        const why = String(event.why ?? 'off')
        log(`off (${why})`)
        record('hands-free-session', { on: false, why })
        setPending(false)
        quiet = { since: null, patienceMs: null }
        closesAt = null
        useHandsFree.setState({ phase: 'off', conversation: false, secondsLeft: null, checking: false, mini: null, standingAside: null })
        // Voice Operator restarting, or its connection gone: still on, waiting
        // ("getting ready") — it is started again as soon as Voice Operator is back.
        if (why === 'restarting' || why === 'disconnected') break
        // Ended from the other side — "let me turn this off", turned on on another
        // device, lost, incognito: off here too, so the button does not say it is
        // listening when nothing is.
        if (why !== 'off' && useHandsFree.getState().on) {
          useHandsFree.setState({ on: false })
          deps.link.stop()
          // Said by voice, it has its own cue already; on another device is the user's doing.
          if (audio && why !== 'shutdown' && why !== 'replaced') deps.playCue('error')
        }
        break
      }
      case 'state': {
        const phase = (['off', 'listening', 'hearing', 'sending'] as const).find((p) => p === event.phase) ?? 'off'
        const was = useHandsFree.getState().phase
        if (was !== phase) record('hands-free-phase', { from: was, to: phase })
        closesAt = typeof event.closesAt === 'number' ? event.closesAt : null
        // Hearing again starts a dictation afresh: the last one's answers are not this one's.
        const fresh = phase === 'hearing' && was !== 'hearing'
        if (fresh || phase === 'listening' || phase === 'off') quiet = { since: null, patienceMs: null }
        useHandsFree.setState({
          phase,
          conversation: event.conversation === true,
          checking: event.checking === true,
          standingAside: STANDING_ASIDE.find((why) => why === event.standingAside) ?? null,
          ...(phase === 'listening' || phase === 'off' || fresh ? { mini: null } : {}),
        })
        tickSeconds()
        if (audio) setPending(event.pending === true)
        break
      }
      case 'gauge': {
        quiet = {
          since: typeof event.quietSince === 'number' ? event.quietSince : null,
          patienceMs: typeof event.patienceMs === 'number' ? event.patienceMs : null,
        }
        useHandsFree.setState({
          mini: typeof event.mini === 'number' ? {
            p: event.mini,
            peak: typeof event.miniPeak === 'number' ? event.miniPeak : null,
            threshold: typeof event.miniThreshold === 'number' ? event.miniThreshold : 0.5,
          } : null,
        })
        break
      }
      case 'cue': {
        if (!audio) break
        const name = String(event.name)
        // Decided: the deciding beep ends before the cue, as the cue says what was decided.
        if (name !== 'ready') setPending(false)
        if (name === 'error') deps.playCue('error')
        else if (CUES[name]) deps.handsFreeCue(CUES[name])
        if (typeof event.haptic === 'string' && HAPTICS.has(event.haptic)) deps.haptic(event.haptic as HapticPattern)
        break
      }
      case 'cut-in': {
        const msAgo = typeof event.msAgo === 'number' ? Math.round(event.msAgo) : 0
        log(`cut Control off as of ${msAgo}ms ago, when they began`)
        record('hands-free-interrupt', { cutInMsAgo: msAgo })
        deps.noteCutIn()
        break
      }
      default:
        break
    }
  })

  setOn = (on) => {
    if (useHandsFree.getState().on === on) return
    useHandsFree.setState({ on })
    log(on ? 'turning on' : 'turning off')
    if (on) deps.link.start()
    else deps.link.stop()
  }

  return () => {
    offEvents()
    stopTicking()
    setPending(false)
    setOn = () => {}
    if (useHandsFree.getState().on) deps.link.stop()
    useHandsFree.setState({ on: false, phase: 'off', conversation: false, secondsLeft: null, checking: false, mini: null, standingAside: null })
  }
}

/**
 * The Mac's link: hands-free on the Mac's own microphone, switched through
 * the server, which holds Spaceterm's connection to Voice Operator.
 */
export function macHandsFreeLink(api: Pick<HandsFreeApi, 'setMac' | 'onMacEvent'>): HandsFreeLink {
  return {
    start: () => api.setMac(true),
    stop: () => api.setMac(false),
    onEvent: (fn) => api.onMacEvent(fn),
  }
}

/**
 * The phone's link: Voice Operator's SDK in the iPhone app streams the app's
 * microphone, and the page is its way to the Mac — every line it writes goes
 * to the server, which passes it to Voice Operator, and back. The stream is
 * opened again whenever the server connection comes back; the SDK resumes its
 * session on the new one.
 */
export function phoneHandsFreeLink(
  api: Pick<HandsFreeApi, 'openStream' | 'streamLine' | 'closeStream' | 'onStream'>,
  device: () => string,
  onConnect: (fn: () => void) => () => void,
  native = nativeHandsFree,
): HandsFreeLink & { dispose(): void } {
  let on = false
  let open = false
  const listeners = new Set<(event: Record<string, unknown>, audio: boolean) => void>()
  const openTransport = () => {
    if (!on) return
    open = true
    api.openStream()
    native.transport(true)
  }
  const offNative = native.on((message) => {
    if (message.kind === 'line') {
      if (open) api.streamLine(message.line)
    } else {
      for (const fn of listeners) fn(message.event, true)
    }
  })
  let retry: ReturnType<typeof setTimeout> | undefined
  const offStream = api.onStream((message) => {
    if (message.kind === 'line') native.line(message.line)
    else if (open) {
      open = false
      native.transport(false)
      // Voice Operator went away (or is restarting): try again shortly; the SDK resumes if it can.
      clearTimeout(retry)
      retry = setTimeout(openTransport, 2000)
    }
  })
  // The server came back: a fresh stream, which the SDK resumes its session on.
  const offConnect = onConnect(() => {
    if (!on) return
    if (open) native.transport(false)
    openTransport()
  })
  return {
    start() {
      on = true
      native.start(device())
      openTransport()
    },
    stop() {
      on = false
      clearTimeout(retry)
      native.stop()
      if (open) {
        open = false
        api.closeStream()
        native.transport(false)
      }
    },
    onEvent(fn) {
      listeners.add(fn)
      return () => { listeners.delete(fn) }
    },
    dispose() {
      clearTimeout(retry)
      offNative()
      offStream()
      offConnect()
    },
  }
}
