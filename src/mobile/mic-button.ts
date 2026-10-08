import type { HoldState } from './held-microphone'
import type { HandsFreePhase } from './hands-free'

/**
 * The microphone button's rules (MicButton.tsx), pure so they can be tested
 * without a phone: what a press was — a tap, a drag up onto the lock, a long
 * press — and what the button looks like.
 *
 * A press is a tap until it moves or is held. Moving the finger up shows a
 * lock above the button, as Messages does for a voice note; carried far
 * enough, the press locks there and then, and is nothing else. Held still
 * long enough, it is a long press. Moved any other way, it is nothing.
 */

/** A press held still this long is a long press. */
export const LONG_PRESS_MS = 450
/** Movement within this is still a tap; rising past it shows the lock. */
export const LOCK_SHOW_PX = 12
/** Rising this far reaches the lock. */
export const LOCK_PX = 48

export interface Press {
  x0: number
  y0: number
  /** How far above where it went down the finger is now; negative below. */
  rise: number
  /** Moved past `LOCK_SHOW_PX` at some point: no longer a tap, nor a long press. */
  strayed: boolean
  /** Already decided, mid-press: the lock reached, or held long enough. */
  done: 'lock' | 'long' | null
}

export function startPress(x: number, y: number): Press {
  return { x0: x, y0: y, rise: 0, strayed: false, done: null }
}

export function movePress(press: Press, x: number, y: number): Press {
  if (press.done) return press
  const rise = press.y0 - y
  const strayed = press.strayed || Math.hypot(x - press.x0, y - press.y0) > LOCK_SHOW_PX
  return { ...press, rise, strayed, done: rise >= LOCK_PX ? 'lock' : null }
}

/** `LONG_PRESS_MS` after it went down. */
export function holdPress(press: Press): Press {
  return press.done || press.strayed ? press : { ...press, done: 'long' }
}

/** What the press was, once the finger lifts. `none`: moved, but not onto the lock. */
export function endPress(press: Press): 'tap' | 'lock' | 'long' | 'none' {
  if (press.done) return press.done
  return press.strayed ? 'none' : 'tap'
}

/**
 * The lock above the button, while it is being dragged toward: how far there
 * (0..1), and whether it has been reached. Null when it is not shown.
 */
export function lockTarget(press: Press | null): { progress: number; reached: boolean } | null {
  if (!press || press.done === 'long') return null
  if (press.done === 'lock') return { progress: 1, reached: true }
  if (press.rise < LOCK_SHOW_PX) return null
  return { progress: Math.min(1, (press.rise - LOCK_SHOW_PX) / (LOCK_PX - LOCK_SHOW_PX)), reached: false }
}

/** Everything the button's look is drawn from. */
export interface MicInputs {
  error: boolean
  /** The button's own dictation: a tap to talk. */
  own: 'idle' | 'starting' | 'listening' | 'sending'
  /** A composer's dictation, which outlives the composer (dictation-session.ts). */
  composer: 'idle' | 'starting' | 'listening' | 'transcribing'
  /** Any dictation on the page sending audio, or waiting for its words (useMicActivity). */
  capturing: boolean
  transcribing: boolean
  hold: HoldState
  handsFree: HandsFreePhase
  conversation: boolean
}

/**
 * One look, however the listening started. `hearing` — the orange — is your
 * voice leaving the phone and nothing else; what Control or Summary Chat is
 * doing never shows here.
 */
export type MicLook = 'error' | 'hearing' | 'starting' | 'transcribing' | 'conversation' | 'armed' | 'preparing' | 'off'

export function micLook(i: MicInputs): MicLook {
  if (i.error) return 'error'
  if (i.capturing || i.own === 'listening' || i.composer === 'listening' || i.handsFree === 'hearing') return 'hearing'
  if (i.own === 'starting' || i.composer === 'starting') return 'starting'
  if (i.transcribing || i.own === 'sending' || i.composer === 'transcribing' || i.handsFree === 'sending') return 'transcribing'
  if (i.hold === 'held') return i.conversation ? 'conversation' : 'armed'
  return i.hold === 'preparing' ? 'preparing' : 'off'
}

/**
 * How much of the conversation window's ring is left, 0..1. The window's
 * length is whatever `secondsLeft` was at its fullest — it is full when the
 * window opens and whenever anyone speaks — so tuning it on the Mac needs
 * nothing here.
 */
export function conversationLeft(secondsLeft: number | null, fullest: number): number {
  if (secondsLeft === null || fullest <= 0) return 0
  return Math.max(0, Math.min(1, secondsLeft / fullest))
}
