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

/**
 * How long to let Claude Code take an Escape before pasting: enough for an
 * AskUserQuestion prompt to be dismissed and the ordinary prompt to return.
 * 500ms was enough against Claude Code 2.1.288 driven through a PTY.
 */
export const DISMISS_QUESTION_DELAY_MS = 500

export interface ShipItDeps {
  /** Resolves once the data has left this process. */
  write(data: string): Promise<void>
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

/**
 * `dismissQuestion`: the agent is sitting in an AskUserQuestion prompt
 * (`waiting_question`). Typed into it, the text goes to the multiple-choice
 * picker and the return picks its first option, losing the message. Escape
 * first declines the question ("User declined to answer questions") and
 * leaves the ordinary prompt, empty, for the text to go into as a message.
 * Permission prompts are not handled: Escape there denies the tool call.
 *
 * Resolves once the last keystroke has left this process. The submit is a
 * timer here, so a server that exits first leaves the text in the prompt
 * unsubmitted: shutdown waits on this.
 */
export async function shipIt(deps: ShipItDeps, text: string, submit: boolean, opts: { dismissQuestion?: boolean } = {}): Promise<void> {
  const wait = (ms: number) => new Promise<void>((resolve) => deps.schedule(resolve, ms))
  if (opts.dismissQuestion) {
    void deps.write('\x1b')
    await wait(DISMISS_QUESTION_DELAY_MS)
  }
  const pasted = deps.write(bracketedPaste(text))
  if (!submit) return pasted
  await wait(SHIP_IT_SUBMIT_DELAY_MS)
  await deps.write('\r')
}
