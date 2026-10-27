import { useReceptionistStore, type ReceptionistState } from '@/stores/receptionistStore'
import type { Cue } from './cues'

/**
 * What Control's turns sound like on the phone, beyond its voice and the
 * sonar while it waits (thinking-cue.ts): the `nothingToSay` tone when it
 * finished thinking and chose to say nothing — not a failure — and the
 * `error` tone when it failed. Played only where replies are Hear
 * (`cuesAudible`, cues.ts).
 *
 * A turn the user cut short is neither: talking over Control, or a tap on
 * the microphone, stops it, and it then goes back to `ready` without a word.
 * `noteUserInterrupted` marks that, and a dictation under way means the same.
 */

/** A stop the user asked for within this long explains a silent end. */
const INTERRUPT_EXPLAINS_MS = 10_000

let interruptedAt = -Infinity

/** The user stopped Control — a tap on the microphone over it, or talking over it hands-free. */
export function noteUserInterrupted(now = performance.now()): void {
  interruptedAt = now
}

export interface ControlTonesDeps {
  play(cue: Cue): void
  /** A dictation is starting or under way on this phone: the user is talking, so Control was stopped for them. */
  userTalking(): boolean
  now(): number
}

type Watched = Pick<ReceptionistState, 'phase' | 'error'>

/** Decide, from one change of Control's status to the next, which tone (if any) it earns. Pure. */
export function toneFor(before: Watched, after: Watched, userCutItShort: boolean): Cue | null {
  if (after.error && after.error !== before.error) return 'error'
  if (before.phase === 'thinking' && after.phase === 'ready' && !after.error && !userCutItShort) return 'nothingToSay'
  return null
}

export function installControlTones(deps: ControlTonesDeps): () => void {
  let before: Watched = useReceptionistStore.getState()
  return useReceptionistStore.subscribe((state) => {
    const after: Watched = { phase: state.phase, error: state.error }
    if (after.phase === before.phase && after.error === before.error) return
    const cutShort = deps.userTalking() || deps.now() - interruptedAt < INTERRUPT_EXPLAINS_MS
    const tone = toneFor(before, after, cutShort)
    before = after
    if (tone) deps.play(tone)
  })
}
