import type { ClaudeState } from '../../shared/state'
import type { PtySessionId } from '../../shared/ids'
export type { ClaudeState }

/**
 * Dependency injection interface for ClaudeStateMachine.
 *
 * Abstracts the sessionManager and stateManager so the state machine can be
 * tested in isolation and doesn't depend on concrete manager implementations.
 */
export interface StateMachineDeps {
  getClaudeState(surfaceId: PtySessionId): ClaudeState
  setClaudeState(surfaceId: PtySessionId, state: ClaudeState): void
  getClaudeStatusUnread(surfaceId: PtySessionId): boolean
  setClaudeStatusUnread(surfaceId: PtySessionId, unread: boolean): void
  handleClaudeStop(surfaceId: PtySessionId): void
  broadcastClaudeState(surfaceId: PtySessionId, state: ClaudeState): void
  broadcastClaudeStateDecisionTime(surfaceId: PtySessionId, timestamp: number): void
  broadcastClaudeStatusUnread(surfaceId: PtySessionId, unread: boolean): void
  setClaudeStatusAsleep(surfaceId: PtySessionId, asleep: boolean): void
  broadcastClaudeStatusAsleep(surfaceId: PtySessionId, asleep: boolean): void
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
