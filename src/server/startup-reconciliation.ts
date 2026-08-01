import type { ClaudeSessionId, PtySessionId } from '../shared/ids'

/**
 * What to do with each surface at startup.
 *
 * This is the highest-consequence decision in the codebase and it runs before
 * anyone is watching: for every terminal in the persisted state, the server
 * decides whether the pty survived and can be adopted, whether the agent
 * session can be resumed, or whether the surface has to be archived. Get it
 * wrong and the user opens the app to find their work gone — or, worse, to
 * find a surface that looks alive attached to nothing.
 *
 * The decision was inline in `startServer`, tangled with the daemon round-trip
 * and the pty spawn that carry it out. It is a pure function of four facts, so
 * it is here with tests; `index.ts` still owns the effects.
 */

export type SurfacePlan =
  /** The daemon still holds this pty. Adopt it — scrollback and all. */
  | { action: 'reattach'; sessionId: PtySessionId; cols: number; rows: number }
  /** Spawn a fresh pty, resuming `resumeSessionId` when there is one. */
  | { action: 'revive'; resumeSessionId?: ClaudeSessionId }
  /** Nothing can be brought back. Archive rather than launch something broken. */
  | { action: 'archive'; reason: 'no-resumable-session' }

export interface SurfaceFacts {
  /** This surface's pty as the daemon reports it, if the daemon still has it. */
  daemonSession?: { id: PtySessionId; alive: boolean; cols: number; rows: number }
  /** The agent session to resume, already resolved and verified. */
  resumeSessionId?: ClaudeSessionId
  /**
   * True for agents that cannot start as a fresh conversation — Claude resumes
   * a transcript or it has nothing to be. A shell or Cursor surface can come
   * back empty and still be useful.
   */
  requiresResumableSession: boolean
}

/**
 * Decide what to do with one surface.
 *
 * Order matters and each step is a separate claim:
 *
 * 1. **A live daemon pty wins outright.** It carries scrollback and a running
 *    process; respawning instead would throw both away even though the agent
 *    is still sitting there.
 * 2. **A dead daemon entry is not a pty.** The daemon reports exited sessions
 *    so the server can clean them up; treating one as adoptable attaches the
 *    surface to a corpse.
 * 3. **Archive only when there is genuinely nothing to come back to.** An agent
 *    that requires a resumable session and has none would launch into an empty
 *    conversation the user did not ask for, then be archived on its first exit
 *    anyway — so archive up front, where it is at least explicable.
 */
export function planSurfaceRecovery(facts: SurfaceFacts): SurfacePlan {
  const { daemonSession, resumeSessionId, requiresResumableSession } = facts

  if (daemonSession?.alive) {
    return {
      action: 'reattach',
      sessionId: daemonSession.id,
      cols: daemonSession.cols,
      rows: daemonSession.rows
    }
  }

  if (!resumeSessionId && requiresResumableSession) {
    return { action: 'archive', reason: 'no-resumable-session' }
  }

  return { action: 'revive', ...(resumeSessionId ? { resumeSessionId } : {}) }
}

/**
 * Daemon sessions that belong to no surface and are still running.
 *
 * These are ptys the server lost track of — a crash between spawning and
 * persisting, or a state file rolled back. Left alone they hold a process and a
 * megabyte of ring buffer forever, invisible to the user.
 *
 * Only live ones are returned: destroying an already-exited session is a no-op
 * the daemon has to answer, and doing it for every historical entry on every
 * boot is noise.
 */
export function orphanedDaemonSessions<T extends { id: PtySessionId; alive: boolean }>(
  daemonSessions: readonly T[],
  claimedSessionIds: ReadonlySet<string>
): T[] {
  return daemonSessions.filter((session) => session.alive && !claimedSessionIds.has(session.id))
}
