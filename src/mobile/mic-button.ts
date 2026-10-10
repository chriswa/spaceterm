import type { HoldState } from './held-microphone'
import type { HandsFreePhase } from './hands-free'

/**
 * The microphone button's look (MicButton.tsx), pure so it can be tested
 * without a phone.
 */

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
 * voice leaving the phone and nothing else; what Control is doing never shows
 * here.
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
