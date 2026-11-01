/** The phrase hands-free sends for itself when it hears it said without "Control". */
export const LET_ME_TURN_THIS_OFF = ['let', 'me', 'turn', 'this', 'off']

/**
 * The phrases that send Control away at once, without asking the model — for
 * when someone in the room needs the user: "let me turn this off", which a
 * bystander hears as the user dealing with their phone, and the older
 * "Control, shutdown". Nothing is shut down. Control lets go of the device, as
 * the Off choice does: it stops speaking, and its replies wait as unread
 * text. The phone closes the conversation window there and then, so nothing
 * more is taken down for Control until the user says "Control" again, which
 * brings it back as speaking to it always does.
 *
 * Only a phrase on its own counts, never the words inside a longer request:
 * matched on the whole of what was said or sent — a hands-free dictation, a
 * message to Control, or (for "let me turn this off", which needs no
 * "Control" first) the whole of a burst of speech hands-free heard while
 * listening for the wake word. A leading "Control" is allowed either way.
 */
export function isControlShutdown(text: string): boolean {
  const words = phraseWords(text)
  if (words[0] === 'control') words.shift()
  // "shutdown", "shut down" and "shut-down" are how dictation writes it.
  return words.join('') === 'shutdown' || sameWords(words, LET_ME_TURN_THIS_OFF)
}

/**
 * What a burst of speech heard while listening for the wake word was heard as,
 * against "let me turn this off" said without "Control", as it is meant to
 * be: `whole` — the phrase and nothing else; `start` — a start of it, at least
 * "let me", as the first second of it may be heard, so hands-free should wait
 * for the speech to end and check the whole of it. Undefined otherwise —
 * including "shutdown" alone, which counts only after "Control" or in the
 * conversation window.
 */
export function wakeFreeShutdown(heard: string): 'whole' | 'start' | undefined {
  const words = phraseWords(heard)
  if (sameWords(words, LET_ME_TURN_THIS_OFF)) return 'whole'
  return words.length >= 2 && sameWords(words, LET_ME_TURN_THIS_OFF.slice(0, words.length)) ? 'start' : undefined
}

/** The phrases that turn Control's replies off and leave hands-free listening for "Control": see `isControlStopTalking`. */
export const STOP_TALKING_PHRASES = [['stop', 'talking'], ['stop', 'conversation'], ['end', 'conversation']]

/**
 * "Stop talking", "stop conversation" or "end conversation" — all three the
 * same: Control's replies go Off at once, without asking the model, its voice
 * stops with anything queued, and it hears nothing more until the user next
 * says "Control", which brings it back speaking on that device. Unlike
 * `isControlShutdown`, hands-free stays on: it is the user telling Control to
 * be quiet, not putting the phone away. "The conversation" counts as
 * "conversation". Matched as `isControlShutdown` is: the whole of what was
 * said or sent, with or without "Control" first.
 */
export function isControlStopTalking(text: string): boolean {
  const words = phraseWords(text)
  if (words[0] === 'control') words.shift()
  if (words[1] === 'the') words.splice(1, 1)
  return STOP_TALKING_PHRASES.some((phrase) => sameWords(words, phrase))
}

/**
 * "Stop listening", with or without "Control" first: said hands-free, it
 * dismisses Control's attention — "Control" is needed again, and speech
 * without it gets no alarm — and Control gets no words. Unlike "stop
 * talking", replies stay as they were. Only the phrase on its own counts:
 * "stop listening to Kevin" does not.
 */
export function isStopListening(text: string): boolean {
  const words = phraseWords(text)
  if (words[0] === 'control') words.shift()
  return sameWords(words, ['stop', 'listening'])
}

/** Lowercased words, punctuation dropped, "lemme" as dictation sometimes writes "let me". */
function phraseWords(text: string): string[] {
  return text.toLowerCase().replace(/[^\p{L}\s]/gu, ' ').split(/\s+/).filter(Boolean).flatMap((w) => w === 'lemme' ? ['let', 'me'] : [w])
}

function sameWords(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((w, i) => w === b[i])
}
