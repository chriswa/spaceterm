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
 * - `dictate` — "dictate …": not for Control at all; the rest is kept on the
 *   device it was said on (`dictatedText`).
 * - `hear` — words for the model.
 */
export type ReceptionistWordsRoute = 'overheard' | 'nothing' | 'away' | 'stop-talking' | 'stop-listening' | 'dictate' | 'hear'

/**
 * Words dictated hands-free, the wake word off. `triggered`: they began with
 * it. `hushed`: Control was told to stop talking, and has not heard
 * "Control" since.
 */
export function routeHandsFreeWords(words: { text: string; triggered: boolean }, hushed: boolean): ReceptionistWordsRoute {
  if (hushed && !words.triggered) return 'overheard'
  if (dictatedText(words.text) !== undefined) return 'dictate'
  if (isStopListening(words.text)) return 'stop-listening'
  return routeWords(words.text)
}

/**
 * What follows "dictate" at the start of words said hands-free, for the
 * device to keep — the Mac's clipboard, the phone's last dictation for its
 * Action button — or undefined when they do not start with it. "Dictate"
 * is no wake word: it is heard only where any words would be, in the
 * conversation window or after "Control". Its first letter is capitalised
 * ("dictate, haha" is "Haha"), unless the word is cased oddly ("iPhone").
 */
export function dictatedText(text: string): string | undefined {
  const match = /^dictate\b[\s,.!?:;…—–-]*(.*)$/is.exec(text.trim())
  if (!match) return undefined
  const rest = match[1].trim()
  return /^\p{Ll}(?!\p{Lu})/u.test(rest) ? rest[0].toUpperCase() + rest.slice(1) : rest
}

/** A whole message to Control — typed, or a dictation sent from the microphone button. */
export function routeWords(text: string): Exclude<ReceptionistWordsRoute, 'overheard' | 'stop-listening' | 'dictate'> {
  if (!text) return 'nothing'
  if (isControlShutdown(text)) return 'away'
  if (isControlStopTalking(text)) return 'stop-talking'
  return 'hear'
}
