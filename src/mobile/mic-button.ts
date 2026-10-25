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
}

/**
 * One look, however the listening started, each distinct at a glance
 * (mobile.css):
 *
 * - `off`: grey. The microphone is closed.
 * - `preparing`: white outline, a spark round it. Hands-free is on and opening the microphone.
 * - `armed`: black, white ring. Hands-free holds the microphone. Whether it needs "Control" (the
 *   conversation window) and whether it is checking speech show on the hands-free button, with the
 *   rest of hands-free (HandsFreeButton.tsx), the same on the phone and the Mac.
 * - `connecting`: dark, a gold spark running round the rim. A tap was taken; the microphone is starting (AirPods can take seconds). Don't talk yet.
 * - `retrying`: amber icon, an amber spark. The microphone did not start the first time; trying once more by itself.
 * - `hearing`: solid orange with level bars. Your voice is being recorded — talk.
 * - `transcribing`: orange, a white spark round it. Recording over; waiting for the words.
 * - `error`: solid red with "!". It failed; the message says why. A tap tries again.
 *
 * What Control is doing never shows here; its own button says that.
 */
export type MicLook = 'error' | 'hearing' | 'retrying' | 'connecting' | 'transcribing' | 'armed' | 'preparing' | 'off'

export function micLook(i: MicInputs): MicLook {
  if (i.error) return 'error'
  if (i.capturing || i.own === 'listening' || i.composer === 'listening' || i.handsFree === 'hearing') return 'hearing'
  if (i.own === 'retrying') return 'retrying'
  if (i.own === 'starting' || i.composer === 'starting') return 'connecting'
  if (i.transcribing || i.own === 'sending' || i.composer === 'transcribing' || i.handsFree === 'sending') return 'transcribing'
  if (i.hold === 'held') return 'armed'
  return i.hold === 'preparing' ? 'preparing' : 'off'
}

/**
 * How much of the conversation window's ring (on the hands-free button) is left, 0..1. The window's
 * length is whatever `secondsLeft` was at its fullest — it is full when the
 * window opens and whenever anyone speaks — so tuning it on the Mac needs
 * nothing here.
 */
export function conversationLeft(secondsLeft: number | null, fullest: number): number {
  if (secondsLeft === null || fullest <= 0) return 0
  return Math.max(0, Math.min(1, secondsLeft / fullest))
}
