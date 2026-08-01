import type { NodeId, PtySessionId } from '../shared/ids'

/**
 * Undoing a restart whose new CLI arguments turned out to be unlaunchable.
 *
 * Changing a surface's Extra CLI arguments restarts it. If the arguments are
 * bad the agent exits immediately, and without this the surface would simply
 * be archived — leaving the user with a dead terminal, no explanation, and the
 * bad arguments still saved. So a restart is recorded, and a pty that dies
 * quickly enough is taken as evidence the arguments were the problem: the
 * previous arguments are restored and the surface relaunched once.
 *
 * Three rules, and each exists because of a way this can go wrong:
 *
 * - **Only the pty this restart spawned counts.** A surface can exit for a
 *   dozen reasons; recovering on an unrelated exit would silently revert
 *   arguments the user deliberately set.
 * - **Recover once, never twice.** If the reverted arguments also fail, the
 *   problem is not the arguments, and looping would spawn ptys forever.
 * - **Fast, or not at all.** An agent that ran for a minute and then exited
 *   did not fail to launch.
 *
 * The wall-clock window is deliberate and is *not* the `Date.now()`-tie
 * pattern this codebase has fixed three times: "did it die within ten seconds
 * of starting" is genuinely a duration, not an ordering. `now` is injectable
 * so it can be tested rather than waited out.
 */

/** How quickly a restarted pty must die to be read as a launch failure. */
export const RECOVERY_WINDOW_MS = 10_000

export interface RestartAttempt {
  /** The pty this restart spawned. Only its exit is evidence. */
  sessionId: PtySessionId
  /** Arguments to restore if it fails. */
  previousExtraCliArgs: string
  startedAt: number
  /** True when this attempt is itself the product of a recovery. */
  isRetry: boolean
}

export type RecoveryDecision =
  /** Revert to `previousExtraCliArgs` and relaunch. */
  | { kind: 'recover'; previousExtraCliArgs: string; elapsedMs: number }
  /** Nothing to do — this exit is not evidence about any restart. */
  | { kind: 'ignore' }
  /**
   * A tracked restart, but not recoverable. The entry has been forgotten;
   * the exit proceeds normally (the surface gets archived).
   */
  | { kind: 'give-up'; reason: 'window-elapsed' | 'already-retried'; elapsedMs: number }

export class RestartRecoveryLedger {
  private readonly attempts = new Map<NodeId, RestartAttempt>()

  /** Restarts currently being watched. For tests and diagnostics. */
  get size(): number {
    return this.attempts.size
  }

  /** Begin watching a restart. Replaces any previous attempt for this node. */
  record(nodeId: NodeId, attempt: RestartAttempt): void {
    this.attempts.set(nodeId, attempt)
  }

  /** Stop watching, e.g. because the relaunch itself failed to spawn. */
  forget(nodeId: NodeId): void {
    this.attempts.delete(nodeId)
  }

  /**
   * Decide what a pty exit means for the restart being watched on `nodeId`.
   *
   * Mutates: a decision other than `ignore` consumes the attempt, so the same
   * exit cannot be acted on twice. `ignore` deliberately leaves the entry
   * alone — an unrelated pty exiting is not news about the restart, and
   * dropping the entry would disarm recovery for the pty still being watched.
   */
  onExit(nodeId: NodeId, sessionId: PtySessionId, now: number): RecoveryDecision {
    const attempt = this.attempts.get(nodeId)
    if (!attempt || attempt.sessionId !== sessionId) return { kind: 'ignore' }

    const elapsedMs = now - attempt.startedAt
    this.attempts.delete(nodeId)

    if (attempt.isRetry) return { kind: 'give-up', reason: 'already-retried', elapsedMs }
    if (elapsedMs >= RECOVERY_WINDOW_MS) return { kind: 'give-up', reason: 'window-elapsed', elapsedMs }
    return { kind: 'recover', previousExtraCliArgs: attempt.previousExtraCliArgs, elapsedMs }
  }

  /**
   * Watch the relaunch that a `recover` decision produced.
   *
   * Marked `isRetry` so a second failure gives up rather than looping. The
   * previous arguments are carried forward only for symmetry — a retry never
   * recovers again, so they are never read back.
   */
  recordRetry(nodeId: NodeId, sessionId: PtySessionId, previousExtraCliArgs: string, now: number): void {
    this.record(nodeId, { sessionId, previousExtraCliArgs, startedAt: now, isRetry: true })
  }
}
