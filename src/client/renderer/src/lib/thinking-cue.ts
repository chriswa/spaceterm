/**
 * Audible progress cue while Control is waiting on the model.
 *
 * The cue is a pure function of Control's phase (see `ReceptionistPhase`): it
 * plays while, and only while, Control is `thinking`. Anything else —
 * synthesizing, speaking, ready, error — silences it. And only where Control
 * is heard: the device holding it, unmuted (`isThinkingWithinEarshot`). Every
 * client sees the phase, so without that the Mac would ping for a phone's
 * question, and a muted device would ping for an answer it will only read. It used to be driven by
 * a `thinking` flag that the server left set for the whole duration of the
 * spoken answer, so the echo played underneath the speech.
 *
 * Which is why `thinking` stops at Voice Operator's door rather than at the
 * first syllable. Voice Operator runs a decaying echo of its own for exactly
 * the stretch between accepting a speech job and making a sound — a stretch
 * that can run to tens of seconds on a slow or contended synthesizer — so a
 * cue that kept playing across it would be a second echo over the top of the
 * first, not a progress signal. One waiter, one cue: spaceterm owns the wait
 * until the answer is handed over, and Voice Operator owns it after.
 */
/**
 * The phone's exceptions (src/mobile/main.tsx): there the cue carries on while
 * Control's voice is made, since Voice Operator's own echo plays on the Mac,
 * not in the phone's ear, and the wait for a voice is still a wait. And there
 * the iPhone app plays it (`playTone`, cues.ts `playThinkingSonar`): the
 * page's own sound is silenced by the screen lock and the Ring/Silent switch,
 * and turned down under hands-free's microphone.
 */
export const thinkingCueScope: { alsoSynthesizing: boolean; playTone: () => () => void } = {
  alsoSynthesizing: false,
  playTone: () => playEchoTone(),
}

const INITIAL_DELAY_MS = 1_500
const CUE_DURATION_MS = 1_500
const REPEAT_GAP_MS = 1_000
/**
 * Hard stop on a single wait, however the phase events behave.
 *
 * A real wait is a model round trip plus a speech-queue handoff — seconds.
 * This is not a tuning knob but a backstop: an echo is unbounded audible
 * output, so it must not be able to outlive its `ready` under any failure (a
 * server restart mid-answer, a dropped socket, a Voice Operator that never
 * settles).
 */
const MAX_WAIT_MS = 60_000
const FREQUENCY_HZ = 494
const SEGMENT_DURATION_S = 0.24
const SEGMENT_GAP_S = 0.06
/**
 * Each echo half the one before. The loudest peaks near -25 dBFS and the
 * echoes never overlap, so there is ample headroom before clipping.
 */
const SEGMENT_GAINS = [0.05625, 0.028125, 0.0140625, 0.00703125, 0.003515625]

/**
 * One echo and the rest before the next, as (frequency Hz, seconds, gain)
 * notes, frequency 0 a rest: what the phone's app loops in place of
 * `playEchoTone`. As long as one tick of `ThinkingCue`, so the loop keeps the
 * cue's own time.
 */
export function echoNotes(): Array<[number, number, number]> {
  const notes: Array<[number, number, number]> = []
  SEGMENT_GAINS.forEach((gain, index) => {
    if (index > 0) notes.push([0, SEGMENT_GAP_S, 0])
    notes.push([FREQUENCY_HZ, SEGMENT_DURATION_S, gain])
  })
  const echoS = SEGMENT_GAINS.length * SEGMENT_DURATION_S + (SEGMENT_GAINS.length - 1) * SEGMENT_GAP_S
  notes.push([0, (CUE_DURATION_MS + REPEAT_GAP_MS) / 1000 - echoS, 0])
  return notes
}

/**
 * Everything the cue reaches outside itself. jsdom has no Web Audio, so the
 * schedule — which is where the bugs live — is tested against a fake tone
 * player rather than by mocking `AudioContext`.
 */
export interface ThinkingCueDeps {
  /** Play one decaying echo. Returns a function that silences it early. */
  playTone(): () => void
  setTimer(fn: () => void, ms: number): number
  clearTimer(handle: number): void
}

export const REAL_THINKING_CUE_DEPS: ThinkingCueDeps = {
  playTone: () => thinkingCueScope.playTone(),
  setTimer: (fn, ms) => setTimeout(fn, ms) as unknown as number,
  clearTimer: (handle) => clearTimeout(handle),
}

/** Keeps the echo running for exactly as long as Control is thinking. */
export class ThinkingCue {
  private thinking = false
  private cueTimer: number | undefined
  private watchdogTimer: number | undefined
  private stopTone: (() => void) | undefined

  constructor(private readonly deps: ThinkingCueDeps = REAL_THINKING_CUE_DEPS) {}

  /**
   * Keep the cue exactly coupled to the thinking phase. Leaving it cancels
   * pending repeats and any sound already in flight, so a spoken answer never
   * overlaps a stale waiting cue.
   */
  setThinking(thinking: boolean): void {
    if (this.thinking === thinking) return
    if (!thinking) {
      this.silence()
      return
    }
    this.thinking = true
    this.cueTimer = this.deps.setTimer(() => this.tick(), INITIAL_DELAY_MS)
    this.watchdogTimer = this.deps.setTimer(() => this.silence(), MAX_WAIT_MS)
  }

  /** Stop everything. Also the watchdog's action. */
  private silence(): void {
    this.thinking = false
    if (this.cueTimer !== undefined) this.deps.clearTimer(this.cueTimer)
    if (this.watchdogTimer !== undefined) this.deps.clearTimer(this.watchdogTimer)
    this.cueTimer = undefined
    this.watchdogTimer = undefined
    this.stopTone?.()
    this.stopTone = undefined
  }

  private tick(): void {
    this.cueTimer = undefined
    if (!this.thinking) return
    this.stopTone = this.deps.playTone()
    this.cueTimer = this.deps.setTimer(() => this.tick(), CUE_DURATION_MS + REPEAT_GAP_MS)
  }
}

const cue = new ThinkingCue()

export function setControlThinking(thinking: boolean): void {
  cue.setThinking(thinking)
}

let audioContext: AudioContext | null = null

function getAudioContext(): AudioContext {
  if (!audioContext) audioContext = new AudioContext()
  return audioContext
}

/** One decaying echo, played by the page; on `context` if given, else a context of the cue's own. */
export function playEchoTone(context: AudioContext = getAudioContext()): () => void {
  const start = context.currentTime
  const oscillators: OscillatorNode[] = []
  for (let index = 0; index < SEGMENT_GAINS.length; index++) {
    const segmentStart = start + index * (SEGMENT_DURATION_S + SEGMENT_GAP_S)
    const oscillator = context.createOscillator()
    const gain = context.createGain()
    oscillator.type = 'sine'
    oscillator.frequency.setValueAtTime(FREQUENCY_HZ, segmentStart)
    gain.gain.setValueAtTime(0, segmentStart)
    gain.gain.linearRampToValueAtTime(SEGMENT_GAINS[index], segmentStart + 0.008)
    gain.gain.setValueAtTime(SEGMENT_GAINS[index], segmentStart + SEGMENT_DURATION_S - 0.012)
    gain.gain.linearRampToValueAtTime(0, segmentStart + SEGMENT_DURATION_S)
    oscillator.connect(gain).connect(context.destination)
    oscillators.push(oscillator)
    oscillator.start(segmentStart)
    oscillator.stop(segmentStart + SEGMENT_DURATION_S)
  }
  return () => {
    for (const oscillator of oscillators) {
      try { oscillator.stop() } catch { /* already finished */ }
    }
  }
}
