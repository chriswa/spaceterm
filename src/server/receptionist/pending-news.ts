/**
 * News waiting to be told to Control, kept on disk.
 *
 * An agent stopping, ending, or answering a side question becomes an event,
 * and the watch that caught it is gone the moment it fires. Kept only in
 * memory, a restart between the news arriving and Control's turn about it
 * lost it for good: "tell me when Dean is done", and then nothing, ever.
 *
 * A turn takes the waiting news, and only once the turn is over is it told.
 * Until then it is held here as the turn's, so a server that stops mid-turn
 * leaves it to the next one, which tells it again: told twice is better than
 * never told.
 */
import * as path from 'path'
import { SOCKET_DIR } from '../../shared/protocol'
import { serverLog } from '../server-log'
import { fileStore, type NameRegistryStore } from './name-registry'
import type { ReceptionistEvent } from './prompt'

export const PENDING_NEWS_FILE = path.join(SOCKET_DIR, 'receptionist', 'pending-news.json')

const KINDS: ReadonlySet<ReceptionistEvent['kind']> = new Set(['agent-stopped', 'agent-ended', 'agent-answer', 'agent-answer-failed'])

/** Which turn took some news: settling a turn that has been superseded must not drop the news its successor took. */
export type Taking = object

export class PendingNews {
  private waiting: ReceptionistEvent[] = []
  private taken: { by: Taking; events: ReceptionistEvent[] } | undefined
  private readonly store: NameRegistryStore

  constructor(deps: { store?: NameRegistryStore } = {}) {
    this.store = deps.store ?? fileStore(PENDING_NEWS_FILE)
    this.load()
  }

  get length(): number {
    return this.waiting.length
  }

  /** The news waiting, oldest first. */
  all(): ReceptionistEvent[] {
    return [...this.waiting]
  }

  some(test: (event: ReceptionistEvent) => boolean): boolean {
    return this.waiting.some(test)
  }

  push(event: ReceptionistEvent): void {
    this.waiting.push(event)
    this.save()
  }

  /** Drop the waiting news that matches. */
  drop(test: (event: ReceptionistEvent) => boolean): void {
    const kept = this.waiting.filter(event => !test(event))
    if (kept.length === this.waiting.length) return
    this.waiting = kept
    this.save()
  }

  /** A turn takes everything waiting. It stays on disk as that turn's until `told`. */
  take(by: Taking): ReceptionistEvent[] {
    const events = this.waiting
    this.waiting = []
    this.taken = { by, events: [...(this.taken?.events ?? []), ...events] }
    this.save()
    return events
  }

  /** The turn that took the news is over: it was told, or the turn failed past retelling. */
  told(by: Taking): void {
    if (this.taken?.by !== by) return
    this.taken = undefined
    this.save()
  }

  /** News a turn took and never told goes back, ahead of whatever came since. */
  requeue(events: readonly ReceptionistEvent[], by: Taking): void {
    if (this.taken?.by === by) this.taken = undefined
    this.waiting = [...events, ...this.waiting]
    this.save()
  }

  private load(): void {
    const raw = this.store.load()
    if (!raw) return
    try {
      const parsed = JSON.parse(raw) as { waiting?: unknown; taken?: unknown }
      // A turn the last server never finished: its news first, since it came first.
      const events = [...asEvents(parsed.taken), ...asEvents(parsed.waiting)]
      this.waiting = events
      if (Array.isArray(parsed.taken) && parsed.taken.length) this.save()
    } catch {
      // A corrupt file is no news, not a server that will not start.
    }
  }

  /** Best-effort: called from state changes, where a failed write must not throw. */
  private save(): void {
    try {
      this.store.save(JSON.stringify({ waiting: this.waiting, taken: this.taken?.events ?? [] }))
    } catch (err) {
      serverLog(`[receptionist] failed to save pending news: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

function asEvents(value: unknown): ReceptionistEvent[] {
  if (!Array.isArray(value)) return []
  return value.filter((event): event is ReceptionistEvent =>
    typeof event === 'object' && event !== null && KINDS.has((event as { kind?: unknown }).kind as ReceptionistEvent['kind'])
    && typeof (event as { agent?: unknown }).agent === 'string')
}
