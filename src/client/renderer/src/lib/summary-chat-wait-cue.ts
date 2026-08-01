import type { NodeId } from '../../../../shared/ids'
/**
 * Audible progress cue for Summary Chat while its cyan thinking indicator is
 * visible. It mirrors Voice Operator's decaying echo timing, but uses a lower
 * note so the two waiting states remain distinguishable.
 */
const INITIAL_DELAY_MS = 1_500
const CUE_DURATION_MS = 1_500
const REPEAT_GAP_MS = 1_000
const FREQUENCY_HZ = 494
const SEGMENT_DURATION_S = 0.24
const SEGMENT_GAP_S = 0.06
const SEGMENT_GAINS = [0.045, 0.0225, 0.01125, 0.005625, 0.0028125]

let audioContext: AudioContext | null = null
let cueTimer: ReturnType<typeof setTimeout> | undefined
let waitingNodeIds = new Set<string>()
let activeOscillators = new Set<OscillatorNode>()

function getAudioContext(): AudioContext {
  if (!audioContext) audioContext = new AudioContext()
  return audioContext
}

function stopActiveCue(): void {
  for (const oscillator of activeOscillators) oscillator.stop()
  activeOscillators.clear()
}

function playCue(): void {
  if (waitingNodeIds.size === 0) return

  const context = getAudioContext()
  const start = context.currentTime
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
    oscillator.addEventListener('ended', () => activeOscillators.delete(oscillator))
    activeOscillators.add(oscillator)
    oscillator.start(segmentStart)
    oscillator.stop(segmentStart + SEGMENT_DURATION_S)
  }
}

function scheduleCue(delayMs: number): void {
  cueTimer = setTimeout(() => {
    cueTimer = undefined
    playCue()
    if (waitingNodeIds.size > 0) scheduleCue(CUE_DURATION_MS + REPEAT_GAP_MS)
  }, delayMs)
}

/** A small confirmation that Cmd+P accepted a Summary Chat request. */
export function playSummaryChatStartedCue(): void {
  const context = getAudioContext()
  const start = context.currentTime
  const oscillator = context.createOscillator()
  const gain = context.createGain()
  oscillator.type = 'sine'
  oscillator.frequency.setValueAtTime(587, start)
  oscillator.frequency.linearRampToValueAtTime(740, start + 0.07)
  gain.gain.setValueAtTime(0.035, start)
  gain.gain.linearRampToValueAtTime(0, start + 0.08)
  oscillator.connect(gain).connect(context.destination)
  oscillator.start(start)
  oscillator.stop(start + 0.08)
}

/**
 * Keep the cue exactly coupled to Summary Chat's thinking state. A transition
 * out of cyan cancels both pending repeats and every active oscillator so the
 * yellow speaking indicator never overlaps a stale waiting sound.
 */
export function setSummaryChatWaiting(nodeId: NodeId, waiting: boolean): void {
  const wasWaiting = waitingNodeIds.size > 0
  if (waiting) waitingNodeIds.add(nodeId)
  else waitingNodeIds.delete(nodeId)

  const isWaiting = waitingNodeIds.size > 0
  if (!wasWaiting && isWaiting) {
    scheduleCue(INITIAL_DELAY_MS)
    return
  }
  if (wasWaiting && !isWaiting) {
    if (cueTimer !== undefined) clearTimeout(cueTimer)
    cueTimer = undefined
    stopActiveCue()
  }
}
