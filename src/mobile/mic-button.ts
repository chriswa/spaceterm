import type { HoldState } from './held-microphone'
import type { HandsFreePhase } from './hands-free'

/**
 * The microphone button's look (MicButton.tsx), pure so it can be tested
 * without a phone.
 */

/** Everything the button's look is drawn from. */
export interface MicInputs {
  error: boolean
  /** The button's own dictation: a tap to talk. `retrying`: the first start failed, and it is trying once more. */
  own: 'idle' | 'starting' | 'retrying' | 'listening' | 'sending'
  /** A composer's dictation, which outlives the composer (dictation-session.ts). */
  composer: 'idle' | 'starting' | 'listening' | 'transcribing'
  /** Any dictation on the page sending audio — from its first sound — or waiting for its words (useMicActivity). */
  capturing: boolean
  transcribing: boolean
  hold: HoldState
  handsFree: HandsFreePhase
  conversation: boolean
  /** Hands-free heard speech and is checking it on the Mac; nothing decided yet. */
  checking: boolean
}

/**
 * One look, however the listening started, each distinct at a glance
 * (mobile.css):
 *
 * - `off`: grey. The microphone is closed.
 * - `preparing`: white outline, a spark round it. Hands-free is on and opening the microphone.
 * - `armed`: black, white ring. Hands-free is listening for "Control"; nothing leaves the phone.
 * - `checking`: armed, with the ring bright and thick. It heard speech and is asking the Mac whether it was for Control.
 * - `conversation`: black, a blue ring draining. Just talk — no "Control" — until it has drained.
 * - `connecting`: dark, a gold spark running round the rim. A tap was taken; the microphone is starting (AirPods can take seconds). Don't talk yet.
 * - `retrying`: amber icon, an amber spark. The microphone did not start the first time; trying once more by itself.
 * - `hearing`: solid orange with level bars. Your voice is being recorded — talk.
 *   In hands-free, a magenta rim rises from the bottom with the turn model's latest answer at a pause, whole at the threshold.
 * - `transcribing`: orange, a white spark round it. Recording over; waiting for the words.
 * - `error`: solid red with "!". It failed; the message says why. A tap tries again.
 *
 * What Control is doing never shows here; its own button says that.
 */
export type MicLook = 'error' | 'hearing' | 'retrying' | 'connecting' | 'transcribing' | 'checking' | 'conversation' | 'armed' | 'preparing' | 'off'

export function micLook(i: MicInputs): MicLook {
  if (i.error) return 'error'
  if (i.capturing || i.own === 'listening' || i.composer === 'listening' || i.handsFree === 'hearing') return 'hearing'
  if (i.own === 'retrying') return 'retrying'
  if (i.own === 'starting' || i.composer === 'starting') return 'connecting'
  if (i.transcribing || i.own === 'sending' || i.composer === 'transcribing' || i.handsFree === 'sending') return 'transcribing'
  if (i.hold === 'held') return i.checking ? 'checking' : i.conversation ? 'conversation' : 'armed'
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

/** Within this fraction of the threshold, the turn ring is drawn whole: it reads as "there". */
export const TURN_NEAR = 0.95

/**
 * How far up the turn ring is filled, 0..1, from the bottom: the turn
 * model's answer as a share of the threshold that ends the dictation, so the
 * top of the ring is the threshold. Whole at or near it.
 */
export function turnFill(p: number, threshold: number): number {
  if (threshold <= 0) return 1
  const share = Math.max(0, p) / threshold
  return share >= TURN_NEAR ? 1 : share
}
