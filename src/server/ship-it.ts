/**
 * Ship text into a terminal surface: one bracketed paste, then a carriage
 * return to submit it.
 *
 * The one implementation. A markdown card's button, the phone's composer and
 * `spaceterm-cli ship-it` all arrive here. There used to be two, in two
 * processes, that had drifted apart on the submit delay.
 */

/**
 * How long to wait after the paste before the carriage return that submits it.
 * Claude's input box needs a beat to finish processing a paste, or the return
 * lands as a newline inside the prompt. 200ms is what the markdown card's
 * button always used, and the one in daily use.
 */
export const SHIP_IT_SUBMIT_DELAY_MS = 200

export interface ShipItDeps {
  write(data: string): void
  schedule(fn: () => void, ms: number): void
}

/**
 * The paste itself. Newlines become carriage returns: a bare `\n` inside a
 * bracketed paste submits Ink/Claude Code's prompt early, and `\r` is what
 * xterm's own paste sends.
 */
export function bracketedPaste(text: string): string {
  return '\x1b[200~' + text.replace(/\r?\n/g, '\r') + '\x1b[201~'
}

export function shipIt(deps: ShipItDeps, text: string, submit: boolean): void {
  deps.write(bracketedPaste(text))
  if (submit) deps.schedule(() => deps.write('\r'), SHIP_IT_SUBMIT_DELAY_MS)
}
