/**
 * The agents Control is watching for their next stop, kept on disk.
 *
 * A watch is a promise to the user — "I'll tell you when Dean is done" — and
 * the user is told to restart the server often, by the very agents being
 * watched. Kept only in memory, every watch went with the old server: the
 * agent stopped, nothing was watching, and Control said nothing.
 */
import * as path from 'path'
import type { NodeId } from '../../shared/ids'
import { SOCKET_DIR } from '../../shared/protocol'
import { serverLog } from '../server-log'
import { fileStore, type NameRegistryStore } from './name-registry'

export const WATCHES_FILE = path.join(SOCKET_DIR, 'receptionist', 'watches.json')

/**
 * `after-work` is a send's or a spawn's: only a stop after the agent has
 * started working on the message counts. A stop on the way in — the Escape
 * that declines a pending question, before the message is even pasted — used
 * to fire it at once, with nothing said, and the real answer then went unreported.
 */
export type WatchKind = 'next-stop' | 'after-work'

export interface Watch {
  kind: WatchKind
  /**
   * The agent's `stateSince` when the watch began: settled at a different one,
   * it has stopped since, though no server saw it happen.
   */
  since?: number
}

export class Watches {
  private readonly watches = new Map<NodeId, Watch>()
  private readonly store: NameRegistryStore

  constructor(deps: { store?: NameRegistryStore } = {}) {
    this.store = deps.store ?? fileStore(WATCHES_FILE)
    this.load()
  }

  get(nodeId: NodeId): Watch | undefined {
    return this.watches.get(nodeId)
  }

  has(nodeId: NodeId): boolean {
    return this.watches.has(nodeId)
  }

  set(nodeId: NodeId, watch: Watch): void {
    this.watches.set(nodeId, watch)
    this.save()
  }

  /** Returns whether the agent was watched. */
  delete(nodeId: NodeId): boolean {
    if (!this.watches.delete(nodeId)) return false
    this.save()
    return true
  }

  entries(): Array<[NodeId, Watch]> {
    return [...this.watches]
  }

  private load(): void {
    const raw = this.store.load()
    if (!raw) return
    try {
      const parsed = JSON.parse(raw) as { watches?: unknown }
      if (typeof parsed.watches !== 'object' || parsed.watches === null) return
      for (const [nodeId, watch] of Object.entries(parsed.watches as Record<string, Partial<Watch>>)) {
        if (watch?.kind !== 'next-stop' && watch?.kind !== 'after-work') continue
        this.watches.set(nodeId as NodeId, { kind: watch.kind, ...(typeof watch.since === 'number' && { since: watch.since }) })
      }
    } catch {
      // A corrupt file is nothing watched, not a server that will not start.
    }
  }

  /** Best-effort: called from state changes, where a failed write must not throw. */
  private save(): void {
    try {
      this.store.save(JSON.stringify({ watches: Object.fromEntries(this.watches) }))
    } catch (err) {
      serverLog(`[receptionist] failed to save watches: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}
