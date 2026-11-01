import { isControlShutdown, isControlStopTalking, isStopListening } from '../shared/control-shutdown'

/**
 * What the server does with words for Control, before the model sees any:
 *
 * - `overheard` — said in the conversation window without "Control" while
 *   Control has been told to stop talking: not for it. The user is talking
 *   to someone else.
 * - `nothing` — nothing was caught for Control.
 * - `away` — "let me turn this off" or "Control, shutdown": replies Off, and
 *   hands-free goes off with it (Voice Operator turns it off itself).
 * - `stop-talking` — "stop talking", "stop conversation" or "end
 *   conversation": replies Off, and attention dismissed — Control hears
 *   nothing more until "Control"; hands-free stays on.
 * - `stop-listening` — "stop listening": attention dismissed, replies as
 *   they were, and no words for Control.
 * - `hear` — words for the model.
 */
export type ReceptionistWordsRoute = 'overheard' | 'nothing' | 'away' | 'stop-talking' | 'stop-listening' | 'hear'

/**
 * Words dictated hands-free, the wake word off. `triggered`: they began with
 * it. `hushed`: Control was told to stop talking, and has not heard
 * "Control" since.
 */
export function routeHandsFreeWords(words: { text: string; triggered: boolean }, hushed: boolean): ReceptionistWordsRoute {
  if (hushed && !words.triggered) return 'overheard'
  if (isStopListening(words.text)) return 'stop-listening'
  return routeWords(words.text)
}

/** A whole message to Control — typed, or a dictation sent from the microphone button. */
export function routeWords(text: string): Exclude<ReceptionistWordsRoute, 'overheard' | 'stop-listening'> {
  if (!text) return 'nothing'
  if (isControlShutdown(text)) return 'away'
  if (isControlStopTalking(text)) return 'stop-talking'
  return 'hear'
}
