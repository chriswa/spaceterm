import type { PersistenceIO, CancelScheduled } from '../persistence'

/**
 * An in-memory `PersistenceIO` with a manually-advanced clock.
 *
 * Nothing here touches the filesystem or a real timer, so a test that uses it
 * is deterministic and — importantly — does not clobber the developer's real
 * `~/.spaceterm/state.json` when the suite runs on their machine.
 */
export class FakePersistenceIO implements PersistenceIO {
  /** The current persisted document, as `write` last left it. */
  stored: string | null = null
  /** Every document ever written, oldest first. */
  writes: string[] = []
  /** Set to make the next `write` throw, to exercise the failure path. */
  failNextWrite = false
  /** Labels passed to `archive`, in order — one per document preserved. */
  archived: Array<{ label: string; content: string | null }> = []

  private pending: Array<{ fn: () => void; dueAt: number; cancelled: boolean }> = []
  private clock = 0

  read(): string | null {
    return this.stored
  }

  write(data: string): void {
    if (this.failNextWrite) {
      this.failNextWrite = false
      throw new Error('fake persistence: write failed')
    }
    this.stored = data
    this.writes.push(data)
  }

  archive(label: string): void {
    this.archived.push({ label, content: this.stored })
  }

  schedule(fn: () => void, ms: number): CancelScheduled {
    const entry = { fn, dueAt: this.clock + ms, cancelled: false }
    this.pending.push(entry)
    return () => {
      entry.cancelled = true
    }
  }

  /** Advance the fake clock, firing anything that comes due. */
  advance(ms: number): void {
    this.clock += ms
    const due = this.pending.filter((p) => !p.cancelled && p.dueAt <= this.clock)
    this.pending = this.pending.filter((p) => !p.cancelled && p.dueAt > this.clock)
    for (const p of due) p.fn()
  }

  /** Timers still armed. Cancelled ones do not count. */
  get liveTimers(): number {
    return this.pending.filter((p) => !p.cancelled).length
  }

  /** The last document written, parsed. Throws if nothing has been written. */
  lastWritten<T = unknown>(): T {
    if (this.writes.length === 0) throw new Error('fake persistence: nothing written yet')
    return JSON.parse(this.writes[this.writes.length - 1]) as T
  }

  /** Seed the store with a document, as if a previous run had written it. */
  seed(doc: unknown): void {
    this.stored = typeof doc === 'string' ? doc : JSON.stringify(doc)
  }
}
