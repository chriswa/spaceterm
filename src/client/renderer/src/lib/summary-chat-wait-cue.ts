import type { NodeId } from '../../../../shared/ids'
/**
 * Audible progress cue for Summary Chat while it is waiting on Haiku.
 *
 * The cue is a pure function of the surface's phase (see `SummaryChatPhase`):
 * it plays while, and only while, at least one surface is `thinking`. Anything
 * else — synthesizing, speaking, ready, error — silences it. It used to be
 * driven by a `thinking` flag that the server left set for the whole duration
 * of the spoken answer, so the echo played underneath the speech.
 *
 * Which is why `thinking` stops at Voice Operator's door rather than at the
 * first syllable. Voice Operator runs a decaying echo of its own for exactly
 * the stretch between accepting a speech job and making a sound — a stretch
 * that can run to tens of seconds on a slow or contended synthesizer — so a
 * cue that kept playing across it would be a second echo over the top of the
 * first, not a progress signal. One waiter, one cue: spaceterm owns the wait
 * until the answer is handed over, and Voice Operator owns it after.
 */
const INITIAL_DELAY_MS = 1_500
const CUE_DURATION_MS = 1_500
const REPEAT_GAP_MS = 1_000
/**
 * Hard stop on a single wait, however the phase events behave.
 *
 * A real wait is a Haiku round trip plus a speech-queue handoff — seconds. This
 * is not a tuning knob but a backstop: an echo is unbounded audible output, so
 * it must not be able to outlive its `ready` under any failure (a server
 * restart mid-answer, a dropped socket, a Voice Operator that never settles).
 * `speakingStore` carries the same kind of watchdog for the same reason.
 */
const MAX_WAIT_MS = 60_000
const FREQUENCY_HZ = 494
const SEGMENT_DURATION_S = 0.24
const SEGMENT_GAP_S = 0.06
const SEGMENT_GAINS = [0.045, 0.0225, 0.01125, 0.005625, 0.0028125]

/**
 * Everything the cue reaches outside itself. jsdom has no Web Audio, so the
 * schedule — which is where the bugs live — is tested against a fake tone
 * player rather than by mocking `AudioContext`.
 */
export interface WaitCueDeps {
  /** Play one decaying echo. Returns a function that silences it early. */
  playTone(): () => void
  setTimer(fn: () => void, ms: number): number
  clearTimer(handle: number): void
}

export const REAL_WAIT_CUE_DEPS: WaitCueDeps = {
  playTone: playEchoTone,
  setTimer: (fn, ms) => setTimeout(fn, ms) as unknown as number,
  clearTimer: (handle) => clearTimeout(handle),
}

/**
 * Tracks which surfaces are waiting and keeps the echo running for exactly as
 * long as at least one of them is.
 */
export class SummaryChatWaitCue {
  private readonly waitingNodeIds = new Set<string>()
  private cueTimer: number | undefined
  private watchdogTimer: number | undefined
  private stopTone: (() => void) | undefined

  constructor(private readonly deps: WaitCueDeps = REAL_WAIT_CUE_DEPS) {}

  /**
   * Keep the cue exactly coupled to Summary Chat's waiting phase. Leaving that
   * phase cancels pending repeats and any sound already in flight, so a spoken
   * answer never overlaps a stale waiting cue.
   */
  setWaiting(nodeId: NodeId, waiting: boolean): void {
    const wasWaiting = this.waitingNodeIds.size > 0
    if (waiting) this.waitingNodeIds.add(nodeId)
    else this.waitingNodeIds.delete(nodeId)

    const isWaiting = this.waitingNodeIds.size > 0
    if (wasWaiting === isWaiting) return
    if (isWaiting) {
      this.cueTimer = this.deps.setTimer(() => this.tick(), INITIAL_DELAY_MS)
      this.watchdogTimer = this.deps.setTimer(() => this.silence(), MAX_WAIT_MS)
      return
    }
    this.silence()
  }

  /** Stop everything and forget every waiter. Also the watchdog's action. */
  private silence(): void {
    this.waitingNodeIds.clear()
    if (this.cueTimer !== undefined) this.deps.clearTimer(this.cueTimer)
    if (this.watchdogTimer !== undefined) this.deps.clearTimer(this.watchdogTimer)
    this.cueTimer = undefined
    this.watchdogTimer = undefined
    this.stopTone?.()
    this.stopTone = undefined
  }

  private tick(): void {
    this.cueTimer = undefined
    if (this.waitingNodeIds.size === 0) return
    this.stopTone = this.deps.playTone()
    this.cueTimer = this.deps.setTimer(() => this.tick(), CUE_DURATION_MS + REPEAT_GAP_MS)
  }
}

const cue = new SummaryChatWaitCue()

export function setSummaryChatWaiting(nodeId: NodeId, waiting: boolean): void {
  cue.setWaiting(nodeId, waiting)
}

let audioContext: AudioContext | null = null

function getAudioContext(): AudioContext {
  if (!audioContext) audioContext = new AudioContext()
  return audioContext
}

function playEchoTone(): () => void {
  const context = getAudioContext()
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

/** A small confirmation that the chord started a Summary Chat. */
export function playSummaryChatStartedCue(): void {
  playChirp(587, 740)
}

/**
 * The same chord's other meaning: an answer was cut off.
 *
 * Falling rather than rising, and a little lower, so the two outcomes of one
 * key are told apart by ear. It matters here more than most confirmations do —
 * the press that cancels is usually made *while* something is talking, and the
 * listener needs to know it landed without waiting to hear silence.
 */
export function playSummaryChatCancelledCue(): void {
  playChirp(494, 370)
}

function playChirp(fromHz: number, toHz: number): void {
  const context = getAudioContext()
  const start = context.currentTime
  const oscillator = context.createOscillator()
  const gain = context.createGain()
  oscillator.type = 'sine'
  oscillator.frequency.setValueAtTime(fromHz, start)
  oscillator.frequency.linearRampToValueAtTime(toHz, start + 0.07)
  gain.gain.setValueAtTime(0.035, start)
  gain.gain.linearRampToValueAtTime(0, start + 0.08)
  oscillator.connect(gain).connect(context.destination)
  oscillator.start(start)
  oscillator.stop(start + 0.08)
}
