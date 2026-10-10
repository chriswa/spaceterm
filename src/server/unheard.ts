/**
 * What of a spoken reply the listener never heard, cut out of what is told
 * back to the model, so a reply they missed the end of is not treated as
 * delivered. Shared by Control (receptionist/reply.ts) and the phone's speech
 * (remote-speech.ts), which reports how far the voice got.
 */

/**
 * Marks where a spoken answer was cut off, in what the model is told of it.
 *
 * Without it, an answer the listener never heard the end of would read as
 * delivered. See `redactUnheard`.
 */
export const INTERRUPTED_MARKER = '*INTERRUPTED*'

/**
 * Rewrite a spoken answer to only the part the listener actually heard.
 *
 * A reply cut off mid-flow would otherwise be presented to the model as
 * though all of it had been delivered, and it would answer "as I said…" about
 * words nobody heard. Redacting the tail is what makes what the model is told
 * match the listener's experience.
 *
 * The marker takes the place of the word the voice was cut off in, and
 * everything after it goes. Voice Operator reports where its voice actually
 * stopped, down to the word, and the whole value of that resolution is that
 * stopping three words from the end of a long sentence is recorded as hearing
 * nearly all of it rather than none of it — which is what a listener who
 * interrupts to ask "wait, what was that last bit?" is relying on.
 *
 * The reported offset is the *end* of the word that was in progress: Voice
 * Operator counts a word as heard once it has started, so that the offset and
 * the word its reading overlay had lit up are the same word. Which makes that
 * last word the uncertain one, and dropping it puts the marker where the
 * listener's attention was actually cut. This is deliberately conservative in
 * one direction — a word that had in fact just finished is dropped too — which
 * is the right way to be wrong: a marker slightly early reads as "they were
 * around here", while a word they only half heard, presented as delivered,
 * invites the next answer to build on something they never got.
 *
 * A "word" is a run of non-whitespace, so `src/main.ts` is one thing to hear
 * rather than three and is dropped whole rather than leaving a `src/ma`.
 */
export function redactUnheard(text: string, heard: number): string {
  if (heard >= text.length) return text
  const spoken = text.slice(0, interruptedWordStart(text, Math.max(0, heard))).trim()
  return spoken ? `${spoken} ${INTERRUPTED_MARKER}` : INTERRUPTED_MARKER
}

/**
 * Where the word the voice was cut off in begins.
 *
 * A word's end offset points at whatever follows the word — a space, a comma —
 * never at the start of the next word, since a word and its successor are
 * separated by the whitespace that defines them. So a cut sitting immediately
 * after whitespace did not come from a word ending: it is a whole-sentence
 * offset, from an older Voice Operator or from a sentence that finished before
 * the interruption, and the sentence it completes is left whole.
 *
 * Anything else is inside or just past a word, and that word is the one the
 * marker replaces.
 */
export function interruptedWordStart(text: string, at: number): number {
  if (at === 0 || /\s/.test(text[at - 1])) return at
  let start = at
  while (start > 0 && !/\s/.test(text[start - 1])) start--
  return start
}
