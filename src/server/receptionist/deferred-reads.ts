import * as path from 'path'
import type { NodeId } from '../../shared/ids'
import { SOCKET_DIR } from '../../shared/protocol'
import { serverLog } from '../server-log'
import { fileStore, type NameRegistryStore } from './name-registry'

/**
 * Agents Control has told the user about, to be marked read once the user has
 * shown they heard it — Control's mark_read tool.
 *
 * Control cannot mark an agent read itself: it writes a reply knowing all of
 * it, and has no way to know whether the user heard it. So mark_read only
 * asks, and the read waits on the reply that carried it. It is kept only if
 * nothing of that reply was cut off — talked over, cut short by Control for
 * news, lost with the device, muted part-way, or failed by the voice — and
 * is done when the user next says something to Control, having taken in all
 * of it by then: heard it through, or, written to a muted device, read it
 * (see `ConsumptionLedger.settle`). A cut drops the read for good, even if
 * the rest is replayed later: an agent left unread is shown again, which is
 * the cheap mistake; one marked read on a report the user missed is lost.
 *
 * Kept on disk, since the user is told to restart the server often: a read
 * waiting on their answer outlives the server, and is done or dropped by the
 * next one when they answer. Replies are where they are in the record, which
 * outlives the server too. A server that shuts down cleanly records how the
 * reply being spoken was cut first; one that crashes cannot, so the reply a
 * read waits on is marked as `unsettled` from when it is written until how
 * it was heard is known, and a mark the next server finds drops its read.
 */

export const DEFERRED_READS_FILE = path.join(SOCKET_DIR, 'receptionist', 'deferred-reads.json')

export interface DeferredRead {
  nodeId: NodeId
  /**
   * When the agent entered the state it was told in (`RosterAgent.stateSince`).
   * An agent that has moved on since has news the user has not heard, so it
   * is not marked read.
   */
  stateSince?: number
}

interface Saved {
  /** Reads by where the reply that told each agent is in the record. */
  replies: Array<[number, DeferredRead[]]>
  /** The reply whose reads wait on how much of it was heard, which is not yet known. */
  unsettled?: number
}

export class DeferredReads {
  /** By where the reply that told each agent is in the record. */
  private readonly byReply = new Map<number, DeferredRead[]>()
  private unsettled: number | undefined
  private readonly store: NameRegistryStore

  constructor(deps: { store?: NameRegistryStore } = {}) {
    this.store = deps.store ?? fileStore(DEFERRED_READS_FILE)
    this.load()
  }

  /**
   * The reply at `at` told the user about these agents. How much of it they
   * hear is not known until `heardOut`, `cut` or `settle`.
   */
  defer(at: number, reads: readonly DeferredRead[]): void {
    if (!reads.length) return
    this.byReply.set(at, [...this.byReply.get(at) ?? [], ...reads])
    this.unsettled = at
    this.save()
  }

  /**
   * How much the user heard of the last reply is known, and anything cut from
   * it has been `cut`: what it waits on is the user's answer alone.
   */
  heardOut(): void {
    if (this.unsettled === undefined) return
    this.unsettled = undefined
    this.save()
  }

  /** The reply at `at` was cut off: what it told is not marked read, whatever the user takes in of it later. Returns what was dropped. */
  cut(at: number): DeferredRead[] {
    const dropped = this.byReply.get(at) ?? []
    this.byReply.delete(at)
    if (this.unsettled === at) this.unsettled = undefined
    if (dropped.length) this.save()
    return dropped
  }

  /**
   * The user's message at `at` answers every reply before it. Returns the
   * reads of those the user took in whole (`whole`), to be done, and the
   * rest, dropped; either way none of them waits any longer.
   */
  settle(at: number, whole: (replyAt: number) => boolean): { done: DeferredRead[]; dropped: DeferredRead[] } {
    const done: DeferredRead[] = []
    const dropped: DeferredRead[] = []
    for (const [replyAt, reads] of this.byReply) {
      if (replyAt >= at) continue
      ;(whole(replyAt) ? done : dropped).push(...reads)
      this.byReply.delete(replyAt)
    }
    if (this.unsettled !== undefined && this.unsettled < at) this.unsettled = undefined
    if (done.length || dropped.length) this.save()
    return { done, dropped }
  }

  private load(): void {
    const raw = this.store.load()
    if (!raw) return
    try {
      const saved = JSON.parse(raw) as Partial<Saved>
      for (const entry of Array.isArray(saved.replies) ? saved.replies : []) {
        if (!Array.isArray(entry) || typeof entry[0] !== 'number' || !Array.isArray(entry[1])) continue
        const reads = (entry[1] as Array<Partial<DeferredRead>>).flatMap(read => typeof read?.nodeId === 'string'
          ? [{ nodeId: read.nodeId, ...(typeof read.stateSince === 'number' ? { stateSince: read.stateSince } : {}) }]
          : [])
        if (reads.length) this.byReply.set(entry[0], reads)
      }
      // The last server went before it knew how much of this reply was heard.
      if (typeof saved.unsettled === 'number' && this.byReply.delete(saved.unsettled)) {
        serverLog(`[receptionist] the last server stopped mid-reply: mark_read on reply ${saved.unsettled} dropped, its agents left unread`)
        this.save()
      }
    } catch {
      // A corrupt file is nothing waiting, not a server that will not start: every agent stays unread.
    }
  }

  /** Best-effort: called on the way to speech, where a failed write must not throw. */
  private save(): void {
    const saved: Saved = { replies: [...this.byReply], ...(this.unsettled !== undefined ? { unsettled: this.unsettled } : {}) }
    try {
      this.store.save(JSON.stringify(saved))
    } catch (err) {
      serverLog(`[receptionist] failed to save deferred reads: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}
