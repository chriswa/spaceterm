import { speechPartStarts, type SpeechPart } from '../voice-operator'

/**
 * A reply's actions, each held until the words before it have been heard.
 *
 * Control's actions are announced in the same reply that takes them — "Sent
 * to Kevin." — and an action that happened before its words, or whose words
 * the user talked over, is one the user did not hear about or did not let
 * finish. So each one waits for the speech before it, and runs the moment
 * that is heard. What becomes of the rest is the caller's to say: `all` when
 * nothing more is coming to wait for (the speech finished, or nobody can hear
 * it), `skip` when the user talked over it.
 *
 * Runs go one at a time, in order, however they are released: an action may
 * depend on the one before it, as a send after an interrupt does.
 */
export class HeardActions<A> {
  private readonly waiting: Array<{ action: A; at: number }>
  private chain: Promise<void> = Promise.resolve()
  /** Batches released and not yet finished. */
  private running = 0
  /** `whenDone` callers waiting for actions to leave `waiting`. */
  private wakers: Array<() => void> = []

  /**
   * `after` is how many of `parts` come before an action: 0 runs it at once,
   * `parts.length` once they have all been heard. Actions come in the order
   * they run, so `after` never goes down. `run` reports its own failures.
   */
  constructor(
    parts: readonly SpeechPart[],
    actions: ReadonlyArray<{ action: A; after: number }>,
    private readonly run: (actions: A[]) => Promise<void>,
  ) {
    const starts = speechPartStarts(parts)
    // Heard once its last word has begun, as Voice Operator counts a cut-off
    // word: trailing punctuation is never reported as reached.
    const heardAt = (after: number): number => {
      if (after <= 0 || !parts.length) return 0
      const index = Math.min(after, parts.length) - 1
      return starts[index] + lastWordEnd(parts[index].text)
    }
    this.waiting = actions.map(({ action, after }) => ({ action, at: heardAt(after) }))
    this.heard(0)
  }

  /** Whether any action is still waiting. */
  get pending(): boolean {
    return this.waiting.length > 0
  }

  /** Resolves once everything released so far has run. */
  get settled(): Promise<void> {
    return this.chain
  }

  /**
   * Resolves once every action has run or been skipped. Only `heard`, `all`
   * and `skip` get it there, so whoever waits on it must see to it that one
   * of them is always coming.
   */
  async whenDone(): Promise<void> {
    while (this.waiting.length || this.running) {
      if (this.waiting.length) await new Promise<void>((resolve) => this.wakers.push(resolve))
      else await this.chain
    }
  }

  /** The listener has heard up to `offset` into the parts joined: run what that releases. */
  heard(offset: number): void {
    let count = 0
    while (count < this.waiting.length && this.waiting[count].at <= offset) count++
    this.release(this.waiting.splice(0, count).map(({ action }) => action))
  }

  /** Nothing more is coming to wait for: run the rest. */
  all(): void {
    this.release(this.waiting.splice(0).map(({ action }) => action))
  }

  /** The words before them were never heard: drop the rest, and return them. */
  skip(): A[] {
    const skipped = this.waiting.splice(0).map(({ action }) => action)
    this.wake()
    return skipped
  }

  private wake(): void {
    for (const resolve of this.wakers.splice(0)) resolve()
  }

  /**
   * Released with nothing running, a batch starts at once, in this call: its
   * effects are in place before the caller goes on — as go_quiet's must be,
   * so that nothing after it in the turn is spoken.
   */
  private release(actions: A[]): void {
    if (!actions.length) return
    this.wake()
    // One failed run must not strand the ones after it.
    const go = (): Promise<void> => this.run(actions).catch(() => undefined)
    this.running++
    this.chain = (this.running === 1 ? go() : this.chain.then(go)).finally(() => { this.running-- })
  }
}

/** Just past the last letter or digit of `text`: where its last word ends. */
function lastWordEnd(text: string): number {
  for (let i = text.length; i > 0; i--) {
    if (/[\p{L}\p{N}]/u.test(text[i - 1])) return i
  }
  return 0
}
