import type { ClaudeState } from '../../shared/state'
import type { PtySessionId } from '../../shared/ids'
export type { ClaudeState }

/**
 * Dependency injection interface for ClaudeStateMachine.
 *
 * Abstracts the surface state store so the state machine can be tested in
 * isolation and doesn't depend on a concrete manager.
 *
 * There used to be a parallel `broadcastClaudeState` / `broadcastClaudeStatusUnread`
 * / `broadcastClaudeStatusAsleep` trio here. They were wired up in index.ts and
 * never called: the broadcast actually happened because `setClaudeState` wrote
 * to SessionManager, which fired a callback, which index.ts routed to
 * StateManager. With one owner the setters broadcast directly and the trio is
 * gone.
 */
export interface StateMachineDeps {
  getClaudeState(surfaceId: PtySessionId): ClaudeState
  setClaudeState(surfaceId: PtySessionId, state: ClaudeState): void
  /**
   * True when a surface that just stopped shows signs of a stopped API error,
   * so 'stopped' should be upgraded to 'potential_error'.
   *
   * A dep rather than a caller-side check: deciding it downstream of the state
   * machine meant re-entering setClaudeState from its own callback, and left
   * 'potential_error' as the one ClaudeState value that never appeared in the
   * decision log — the artifact every other state bug was diagnosed from.
   */
  hasPotentialError(surfaceId: PtySessionId): boolean
  getClaudeStatusUnread(surfaceId: PtySessionId): boolean
  setClaudeStatusUnread(surfaceId: PtySessionId, unread: boolean): void
  handleClaudeStop(surfaceId: PtySessionId): void
  broadcastClaudeStateDecisionTime(surfaceId: PtySessionId, timestamp: number): void
  setClaudeStatusAsleep(surfaceId: PtySessionId, asleep: boolean): void
}

/**
 * A state transition waiting in the queue to be processed.
 *
 * Events from hooks, JSONL, and status-line are held for TRANSITION_DELAY_MS
 * then processed in source-timestamp order. This prevents race conditions
 * where a late-arriving event from one source clobbers an authoritative state
 * set by the other (e.g. a JSONL assistant message overriding a Stop hook).
 */
export interface QueuedTransition {
  /** Epoch ms — when the event actually happened (from hook timestamp or JSONL entry) */
  sourceTime: number
  surfaceId: PtySessionId
  newState: ClaudeState
  /** Where this transition originated — determines logging and priority */
  source: 'hook' | 'jsonl' | 'status-line' | 'ledger'
  /** Human-readable event name for decision logs (e.g. 'hook:Stop', 'jsonl:assistant') */
  event: string
  /** Optional extra context for the decision log (e.g. tool name, notification type) */
  detail?: string
}
