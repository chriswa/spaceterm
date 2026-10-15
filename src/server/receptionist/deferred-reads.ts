import type { NodeId } from '../../shared/ids'

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
 * Nothing here outlives the server: a restart before the user answers
 * leaves the agent unread, which is the same cheap mistake.
 */

export interface DeferredRead {
  nodeId: NodeId
  /**
   * When the agent entered the state it was told in (`RosterAgent.stateSince`).
   * An agent that has moved on since has news the user has not heard, so it
   * is not marked read.
   */
  stateSince?: number
}

export class DeferredReads {
  /** By where the reply that told each agent is in the record. */
  private readonly byReply = new Map<number, DeferredRead[]>()

  /** The reply at `at` told the user about these agents. */
  defer(at: number, reads: readonly DeferredRead[]): void {
    if (reads.length) this.byReply.set(at, [...this.byReply.get(at) ?? [], ...reads])
  }

  /** The reply at `at` was cut off: what it told is not marked read, whatever the user takes in of it later. Returns what was dropped. */
  cut(at: number): DeferredRead[] {
    const dropped = this.byReply.get(at) ?? []
    this.byReply.delete(at)
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
    return { done, dropped }
  }
}
