import type { SoundName } from '../../../../shared/protocol'

let ctx: AudioContext | null = null
function getCtx(): AudioContext {
  if (!ctx) ctx = new AudioContext()
  return ctx
}

// -- Note definitions (single source of truth) --

type Note = { freq: number; start: number; duration: number; type: OscillatorType; gain: number }

const G5 = 783.99
const E5 = 659.25
const C5 = 523.25

const SUCCESS_NOTES: Note[] = [
  { freq: C5, start: 0,   duration: 0.35, type: 'sine', gain: 1.0 },
  { freq: E5, start: 0.1, duration: 0.35, type: 'sine', gain: 1.0 },
  { freq: G5, start: 0.2, duration: 0.35, type: 'sine', gain: 1.0 },
]

const ERROR_NOTES: Note[] = [
  { freq: G5, start: 0,   duration: 0.35, type: 'sine', gain: 1.0 },
  { freq: E5, start: 0.1, duration: 0.35, type: 'sine', gain: 1.0 },
  { freq: C5, start: 0.2, duration: 0.35, type: 'sine', gain: 1.0 },
]

const DONE_NOTES: Note[] = [
  { freq: G5, start: 0, duration: 0.35, type: 'sine', gain: 1.0 },
]

// -- Synth engine --

function synthNotes(notes: Note[]): void {
  const ac = getCtx()
  const now = ac.currentTime
  for (const n of notes) {
    const osc = ac.createOscillator()
    const gain = ac.createGain()
    osc.type = n.type
    osc.frequency.value = n.freq
    gain.gain.setValueAtTime(n.gain, now + n.start)
    gain.gain.exponentialRampToValueAtTime(0.001, now + n.start + n.duration)
    osc.connect(gain).connect(ac.destination)
    osc.start(now + n.start)
    osc.stop(now + n.start + n.duration)
  }
}

const synths: Record<SoundName, () => void> = {
  done: () => synthNotes(DONE_NOTES),
  error: () => synthNotes(ERROR_NOTES),
  success: () => synthNotes(SUCCESS_NOTES),
}

/** Play a named sound using Web Audio synthesis. */
export function playSound(name: SoundName): void {
  const fn = synths[name]
  if (fn) fn()
}
