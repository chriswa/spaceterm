import type { ClaudeSessionId, NodeId, PtySessionId } from '../shared/ids'
import type { NodeData } from '../shared/state'
import { planSurfaceRecovery, orphanedDaemonSessions } from './startup-reconciliation'

/**
 * Running the startup recovery sequence.
 *
 * `startup-reconciliation.ts` decides what to do with one surface;
 * this runs the decision for every surface and carries it out. Splitting the
 * two is what makes the sequence testable at all — the decision is a pure
 * function, and everything the sequence needs from the outside world is behind
 * `StartupRecoveryDeps`, so a test can drive the whole thing against a fake
 * daemon with no Go binary and no socket.
 *
 * That matters more here than anywhere else in the server. This code decides,
 * per surface, whether the user's work comes back, and it runs once at boot
 * with nobody watching. Until now the only way to exercise it was to launch
 * the app.
 */

/** One surviving pty as the daemon reports it. */
export interface DaemonSessionInfo {
  id: PtySessionId
  cols: number
  rows: number
  alive: boolean
}

/** A terminal that needs to be brought back, as StateManager describes it. */
export interface RecoverableTerminal {
  nodeId: NodeId
  claudeSessionId?: ClaudeSessionId
  cwd?: string
  extraCliArgs?: string
}

/**
 * Everything the sequence touches outside itself.
 *
 * Grouped by what it is rather than by which singleton provides it, so the
 * list reads as "what recovery needs" instead of "what index.ts happens to
 * have".
 */
export interface StartupRecoveryDeps {
  // --- the daemon ---
  /** Every session the daemon still holds, live or exited. */
  listDaemonSessions(): Promise<DaemonSessionInfo[]>
  /** Adopt a surviving pty, resolving with its scrollback. Rejects if it cannot. */
  attachDaemonSession(sessionId: PtySessionId): Promise<string>
  /** Kill a pty no surface claimed. */
  destroyDaemonSession(sessionId: PtySessionId): void

  // --- persisted state ---
  /** Close out live sessions and return every terminal needing recovery. */
  takeRecoverableTerminals(): RecoverableTerminal[]
  getNode(nodeId: NodeId): NodeData | undefined
  archiveTerminal(nodeId: NodeId): void
  /**
   * Keep a freshly spawned pty from archiving its surface if it exits
   * immediately. Scoped to the pty and self-expiring, so it protects the launch
   * it was armed for and nothing later.
   */
  protectFromArchival(sessionId: PtySessionId): void

  // --- bringing a surface back ---
  /** Which agent session to resume for this node, already verified. */
  resolveResumeTarget(node: NodeData, recorded?: ClaudeSessionId): ClaudeSessionId | undefined
  /** True when this node's agent cannot start as a fresh conversation. */
  requiresResumableSession(node: NodeData | undefined): boolean
  /** Adopt a surviving pty for `nodeId`, seeding scrollback into the snapshot buffer. */
  reattachSurface(
    nodeId: NodeId,
    pty: { sessionId: PtySessionId; cols: number; rows: number },
    scrollback: string,
    cwd?: string
  ): void
  /** Spawn a fresh pty for `nodeId`, resuming `resumeSessionId` when given. */
  reviveSurface(terminal: RecoverableTerminal, resumeSessionId?: ClaudeSessionId): PtySessionId
  /** Start following the agent's transcript for a surface that came back. */
  watchTranscript(sessionId: PtySessionId, nodeId: NodeId, resumeSessionId: ClaudeSessionId): void

  log(line: string): void
}

/** What happened, for the log and for tests. */
export interface StartupRecoveryOutcome {
  reattached: PtySessionId[]
  /** Nodes given a fresh pty. */
  revived: NodeId[]
  archived: NodeId[]
  /** Daemon sessions destroyed because no surface claimed them. */
  orphansDestroyed: PtySessionId[]
}

/**
 * Bring every persisted terminal back, or archive it.
 *
 * Per surface: adopt the daemon's pty if it survived, else spawn a fresh one
 * resuming the agent session, else archive. A reattach that fails falls through
 * to revival rather than losing the surface — and un-claims its session id so
 * the pty it failed to adopt is cleaned up as an orphan rather than left
 * running forever.
 *
 * Every revived pty is handed to `protectFromArchival`, because one that exits
 * seconds after being spawned failed to launch and must not archive the surface
 * it was bringing back. The window expires on its own — nothing here, and
 * nothing in the caller, has to remember to disarm it.
 */
export async function recoverSurfaces(deps: StartupRecoveryDeps): Promise<StartupRecoveryOutcome> {
  const daemonSessions = await deps.listDaemonSessions()
  const daemonById = new Map(daemonSessions.map((s) => [s.id, s]))
  deps.log(`[startup] Daemon has ${daemonSessions.length} session(s)`)

  const terminals = deps.takeRecoverableTerminals()
  deps.log(`[startup] ${terminals.length} terminal(s) to process`)

  const outcome: StartupRecoveryOutcome = {
    reattached: [], revived: [], archived: [], orphansDestroyed: []
  }
  const claimed = new Set<string>()

  for (const terminal of terminals) {
    const node = deps.getNode(terminal.nodeId)
    const ptySessionId = node?.type === 'terminal' ? node.sessionId : undefined
    const daemonSession = ptySessionId ? daemonById.get(ptySessionId) : undefined
    const resumeSessionId = node ? deps.resolveResumeTarget(node, terminal.claudeSessionId) : undefined

    const plan = planSurfaceRecovery({
      daemonSession,
      resumeSessionId,
      requiresResumableSession: deps.requiresResumableSession(node)
    })

    if (plan.action === 'reattach') {
      claimed.add(plan.sessionId)
      try {
        const scrollback = await deps.attachDaemonSession(plan.sessionId)
        deps.reattachSurface(terminal.nodeId, plan, scrollback, terminal.cwd)
        if (resumeSessionId) deps.watchTranscript(plan.sessionId, terminal.nodeId, resumeSessionId)
        outcome.reattached.push(plan.sessionId)
        deps.log(`[startup] Re-attached ${plan.sessionId.slice(0, 8)} for terminal ${terminal.nodeId.slice(0, 8)}`)
        continue
      } catch (err: any) {
        // Un-claim: the pty we failed to adopt is an orphan now, and leaving it
        // claimed would leave it running forever with nothing attached.
        claimed.delete(plan.sessionId)
        deps.log(`[startup] Failed to re-attach ${plan.sessionId.slice(0, 8)}: ${err.message}; reviving instead`)
      }
    }

    if (plan.action === 'archive') {
      deps.archiveTerminal(terminal.nodeId)
      outcome.archived.push(terminal.nodeId)
      deps.log(`[startup] Archived terminal ${terminal.nodeId.slice(0, 8)} (${plan.reason})`)
      continue
    }

    // Revive — either planned, or fallen through from a failed reattach.
    try {
      const sessionId = deps.reviveSurface(terminal, resumeSessionId)
      deps.protectFromArchival(sessionId)
      if (resumeSessionId) deps.watchTranscript(sessionId, terminal.nodeId, resumeSessionId)
      outcome.revived.push(terminal.nodeId)
      deps.log(
        `[startup] Revived terminal ${terminal.nodeId.slice(0, 8)} with session ` +
        `${resumeSessionId ? resumeSessionId.slice(0, 8) : '(fresh)'}`
      )
    } catch (err: any) {
      // Nothing to disarm: protection is armed against a pty, and this one never
      // came into existence.
      deps.archiveTerminal(terminal.nodeId)
      outcome.archived.push(terminal.nodeId)
      deps.log(`[startup] Failed to revive terminal ${terminal.nodeId.slice(0, 8)}: ${err.message}`)
    }
  }

  for (const orphan of orphanedDaemonSessions(daemonSessions, claimed)) {
    deps.log(`[startup] Destroying orphaned daemon session ${orphan.id.slice(0, 8)}`)
    deps.destroyDaemonSession(orphan.id)
    outcome.orphansDestroyed.push(orphan.id)
  }

  return outcome
}
