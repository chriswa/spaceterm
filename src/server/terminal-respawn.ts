import type { NodeId, PtySessionId } from '../shared/ids'

/**
 * Rebinding a terminal node to a fresh pty.
 *
 * Six paths do this — restart, reincarnate, unarchive, restart-recovery,
 * startup revive, and startup daemon-reattach — and all six were the same five
 * statements written out by hand in `index.ts`:
 *
 * ```
 * sessionManager.create(options)
 * snapshotManager.addSession(...)
 * if (node.shellTitleHistory?.length) sessionManager.seedTitleHistory(...)
 * stateManager.reincarnateTerminal(...)
 * seedHistoryAfterReincarnate(...)
 * ```
 *
 * Order is load-bearing in two places and neither is obvious from reading it:
 *
 * - The snapshot session must exist before the node is rebound, or output that
 *   arrives between the two lands in no snapshot buffer.
 * - Shell titles must be seeded from the node *before* `reincarnateTerminal`
 *   opens a new terminal session — that call is what starts the new session
 *   record, and seeding after it attributes the old surface's titles to the
 *   new one.
 *
 * Six hand-written copies of an order-sensitive sequence is the setup for a
 * bug that only appears on one of the six paths. Hence one function.
 *
 * How the pty comes into existence is the caller's business: five paths spawn
 * a fresh one, and startup reattach adopts a pty the daemon already has. That
 * is why the pty arrives as a thunk rather than as create-options.
 */

/** A pty that has just been created. */
export interface SpawnedPty {
  sessionId: PtySessionId
  cols: number
  rows: number
}

/**
 * The collaborators involved. Narrow on purpose: the real `SessionManager`,
 * `SnapshotManager` and `StateManager` satisfy these structurally, so index.ts
 * passes them through unchanged and a test supplies recorders.
 */
export interface TerminalRespawnDeps {
  addSnapshotSession(sessionId: PtySessionId, cols: number, rows: number): void
  seedTitleHistory(sessionId: PtySessionId, titles: string[]): void
  /** Shell titles recorded against the node, carried across the rebind. */
  titleHistoryOf(nodeId: NodeId): string[] | undefined
  /** Agent session ids recorded against the node, carried across the rebind. */
  agentSessionHistoryOf(nodeId: NodeId): unknown[]
  seedAgentSessionHistory(sessionId: PtySessionId, history: unknown[]): void
  rebindNode(nodeId: NodeId, sessionId: PtySessionId, cols: number, rows: number): void
}

/**
 * Obtain a pty via `spawn` and rebind `nodeId` to it, carrying the node's
 * shell titles and agent session history across.
 *
 * Whatever `spawn` does — create a pty, or adopt one the daemon still holds —
 * everything after it is identical, which is the point.
 */
export function respawnTerminal(
  nodeId: NodeId,
  spawn: () => SpawnedPty,
  deps: TerminalRespawnDeps
): SpawnedPty {
  const pty = spawn()
  deps.addSnapshotSession(pty.sessionId, pty.cols, pty.rows)

  // Read the node's history before rebinding — reincarnation opens a new
  // terminal session record, and seeding after it would file the old
  // surface's titles under the new one.
  const titles = deps.titleHistoryOf(nodeId)
  if (titles?.length) deps.seedTitleHistory(pty.sessionId, titles)

  deps.rebindNode(nodeId, pty.sessionId, pty.cols, pty.rows)

  // Agent session history is read *after* the rebind: the node keeps it across
  // reincarnation, and this ordering matches what the five call sites did.
  const agentHistory = deps.agentSessionHistoryOf(nodeId)
  if (agentHistory.length > 0) deps.seedAgentSessionHistory(pty.sessionId, agentHistory)

  return pty
}
