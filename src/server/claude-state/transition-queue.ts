import type { QueuedTransition, ClaudeState } from './types'

/**
 * How long (ms) to hold queued transitions before processing them.
 *
 * Events from hooks and JSONL arrive asynchronously and may be out of order.
 * Holding for 500ms lets us collect events from both sources, then process
 * them in source-timestamp order so causally-later events win. Without this
 * delay, a JSONL assistant message could override a Stop hook that actually
 * happened later (or vice versa), because file-watcher latency differs from
 * hook delivery latency.
 */
export const TRANSITION_DELAY_MS = 500

/**
 * How often (ms) to drain the transition queue.
 *
 * 50ms gives responsive processing while batching events that arrive in bursts.
 * Lower values waste CPU on empty drain cycles; higher values add visible
 * latency to state indicator updates.
 */
export const TRANSITION_DRAIN_INTERVAL_MS = 50

export type ApplyFn = (
  surfaceId: string,
  newState: ClaudeState,
  source: 'hook' | 'jsonl' | 'status-line',
  event: string,
  detail?: string
) => void

/**
 * Manages a time-ordered queue of state transitions.
 *
 * Events are enqueued with their source timestamp. The drain cycle processes
 * events older than TRANSITION_DELAY_MS in source-timestamp order, ensuring
 * that causally-later events from different sources (hooks vs JSONL) are
 * applied in the correct order.
 */
export class TransitionQueue {
  private queue: QueuedTransition[] = []
  private drainTimer: ReturnType<typeof setInterval> | null = null
  private applyFn: ApplyFn

  constructor(applyFn: ApplyFn) {
    this.applyFn = applyFn
    this.drainTimer = setInterval(() => this.drain(), TRANSITION_DRAIN_INTERVAL_MS)
  }

  enqueue(
    surfaceId: string,
    newState: ClaudeState,
    source: 'hook' | 'jsonl' | 'status-line',
    event: string,
    sourceTime: number,
    detail?: string
  ): void {
    this.queue.push({ sourceTime, surfaceId, newState, source, event, detail })
  }

  /**
   * Process transitions whose source timestamp is older than the delay threshold.
   * @param flush — if true, process ALL queued transitions regardless of age
   *                (used during shutdown to avoid losing pending state changes)
   */
  drain(flush = false): void {
    const cutoff = flush ? Infinity : Date.now() - TRANSITION_DELAY_MS
    const ready: QueuedTransition[] = []
    const remaining: QueuedTransition[] = []
    for (const t of this.queue) {
      if (t.sourceTime <= cutoff) {
        ready.push(t)
      } else {
        remaining.push(t)
      }
    }
    if (ready.length === 0) return
    this.queue.length = 0
    this.queue.push(...remaining)

    // Process in source-timestamp order so causally-later events win
    ready.sort((a, b) => a.sourceTime - b.sourceTime)
    for (const t of ready) {
      this.applyFn(t.surfaceId, t.newState, t.source, t.event, t.detail)
    }
  }

  dispose(): void {
    if (this.drainTimer) {
      clearInterval(this.drainTimer)
      this.drainTimer = null
    }
    // Flush remaining transitions so no pending state changes are lost
    this.drain(true)
  }
}
