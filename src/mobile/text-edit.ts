/**
 * ^W, as a terminal does it: delete the word before the cursor, along with any
 * whitespace between that word and the cursor. Handy after dictation, to take
 * back the last word or two with a tap each.
 */
export function deleteWordBefore(text: string, cursor: number): { text: string; cursor: number } {
  let start = Math.min(cursor, text.length)
  while (start > 0 && /\s/.test(text[start - 1])) start--
  while (start > 0 && !/\s/.test(text[start - 1])) start--
  return { text: text.slice(0, start) + text.slice(cursor), cursor: start }
}
