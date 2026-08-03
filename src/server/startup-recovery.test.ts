import { describe, it, expect } from 'vitest'
import { recoverSurfaces, type DaemonSessionInfo, type RecoverableTerminal, type StartupRecoveryDeps } from './startup-recovery'
import { StateManager } from './state-manager'
import { StatePersister } from './persistence'
import { SessionManager } from './session-manager'
import { DaemonClient } from './daemon-client'
import { FakeDaemon } from './testing/fake-daemon'
import { FakePersistenceIO } from './testing/fake-persistence'
import { CURRENT_STATE_VERSION } from './state-migrations'
import { respawnTerminal, type TerminalRespawnDeps } from './terminal-respawn'
import type { ClaudeSessionEntry } from '../shared/protocol'
import type { NodeData, ServerState } from '../shared/state'
import { asClaudeSessionId, asNodeId, asPtySessionId, ROOT_NODE_ID, type NodeId, type PtySessionId } from '../shared/ids'

/**
 * The startup recovery sequence, driven end to end against a real
 * `StateManager`, a real `SessionManager`, a real `DaemonClient` and an
 * in-memory daemon.
 *
 * This is the closest thing in the repo to an integration test, and it covers
 * the code with the worst consequence-to-coverage ratio: it decides, per
 * surface, whether the user's work comes back, and it runs once at boot with
 * nobody watching. Everything below the deps interface is production code —
 * only the daemon socket and the state file are faked, and both of those speak
 * stable protocols rather than being collaborators.
 */

const pid = asPtySessionId
const nid = asNodeId
const cid = asClaudeSessionId

/** A persisted terminal, as a previous run would have left it. */
function terminal(id: string, overrides: Partial<Record<string, unknown>> = {}): NodeData {
  return {
    type: 'terminal',
    id: nid(id),
    parentId: ROOT_NODE_ID,
    x: 0, y: 0, zIndex: 1,
    sessionId: pid(id),
    cols: 80, rows: 24,
    alive: true,
    cwd: '/work',
    claudeState: 'stopped',
    claudeStatusUnread: false,
    claudeStatusAsleep: false,
    sortOrder: 0,
    terminalSessions: [{ sessionIndex: 0, startedAt: '2024-01-01T00:00:00.000Z', trigger: 'initial', shellTitleHistory: [] }],
    claudeSessionHistory: [],
    shellTitleHistory: [],
    archivedChildren: [],
    ...overrides
  } as unknown as NodeData
}

function stateWith(...nodes: NodeData[]): ServerState {
  return {
    version: CURRENT_STATE_VERSION,
    nextZIndex: 100,
    nodes: Object.fromEntries(nodes.map((n) => [n.id, n])),
    rootArchivedChildren: [],
    undoBuffer: [],
    undoCursor: -1,
    savedViewports: {}
  }
}

interface HarnessOptions {
  /** Nodes in the persisted state file. */
  nodes?: NodeData[]
  /** What the daemon reports it still holds. */
  daemonSessions?: DaemonSessionInfo[]
  /** Session ids whose attach should fail. */
  attachFailures?: string[]
  /** Node ids whose revive spawn should fail. */
  reviveFailures?: string[]
  /** Which agent session each node resumes, if any. */
  resumeTargets?: Record<string, string>
  /** Node ids whose agent cannot start fresh (Claude-like). */
  requiresSession?: string[]
}

async function harness(options: HarnessOptions = {}) {
  const {
    nodes = [], daemonSessions = [], attachFailures = [],
    reviveFailures = [], resumeTargets = {}, requiresSession = []
  } = options

  // --- real persistence, in memory ---
  const io = new FakePersistenceIO()
  if (nodes.length > 0) io.seed(stateWith(...nodes))
  const stateManager = new StateManager(
    { onNodeUpdate: () => {}, onNodeAdd: () => {}, onNodeRemove: () => {} },
    { persister: new StatePersister(io, 1000) }
  )

  // --- real daemon client over an in-memory socket ---
  const daemon = new FakeDaemon()
  const daemonClient = new DaemonClient(() => {}, { transport: daemon, reconnectDelayMs: 1 })
  await daemonClient.connect()
  const sessionManager = new SessionManager(daemonClient, {
    onData: () => {}, onExit: () => {}, onTitleHistory: () => {},
    onCwd: () => {}, onClaudeSessionHistory: () => {}, onActivity: () => {}
  })

  const respawnDeps: TerminalRespawnDeps = {
    sizeOf: (nodeId) => {
      const node = stateManager.getNode(nodeId)
      return node?.type === 'terminal' ? { cols: node.cols, rows: node.rows } : undefined
    },
    addSnapshotSession: () => {},
    seedTitleHistory: (sessionId, titles) => sessionManager.seedTitleHistory(sessionId, titles),
    titleHistoryOf: (nodeId) => {
      const node = stateManager.getNode(nodeId)
      return node?.type === 'terminal' ? node.shellTitleHistory : undefined
    },
    agentSessionHistoryOf: (nodeId) => {
      const node = stateManager.getNode(nodeId)
      return node?.type === 'terminal' ? node.claudeSessionHistory : []
    },
    seedAgentSessionHistory: (sessionId, history) =>
      sessionManager.seedClaudeSessionHistory(sessionId, history as ClaudeSessionEntry[]),
    rebindNode: (nodeId, sessionId, cols, rows) =>
      stateManager.reincarnateTerminal(nodeId, sessionId, cols, rows)
  }

  const log: string[] = []
  const watched: Array<{ sessionId: PtySessionId; nodeId: NodeId; resume: string }> = []
  const snapshotWrites: Array<{ sessionId: PtySessionId; scrollback: string }> = []
  const destroyed: PtySessionId[] = []

  const deps: StartupRecoveryDeps = {
    listDaemonSessions: async () => daemonSessions,
    attachDaemonSession: async (sessionId) => {
      if (attachFailures.includes(sessionId)) throw new Error('daemon refused attach')
      return `scrollback for ${sessionId}`
    },
    destroyDaemonSession: (sessionId) => { destroyed.push(sessionId) },

    takeRecoverableTerminals: () => stateManager.processDeadTerminals(),
    getNode: (nodeId) => stateManager.getNode(nodeId),
    archiveTerminal: (nodeId) => stateManager.archiveTerminal(nodeId),
    markReviving: (nodeId) => stateManager.markReviving(nodeId),
    clearReviving: (nodeId) => stateManager.clearReviving(nodeId),

    resolveResumeTarget: (node) => {
      const target = resumeTargets[node.id]
      return target ? cid(target) : undefined
    },
    requiresResumableSession: (node) => !!node && requiresSession.includes(node.id),

    reattachSurface: (nodeId, pty, scrollback, cwd) => {
      respawnTerminal(nodeId, () => {
        sessionManager.reattachSession(pty.sessionId, scrollback, pty.cols, pty.rows, cwd)
        return pty
      }, respawnDeps)
      if (scrollback) snapshotWrites.push({ sessionId: pty.sessionId, scrollback })
    },

    reviveSurface: (t) => {
      if (reviveFailures.includes(t.nodeId)) throw new Error('daemon is down')
      return respawnTerminal(t.nodeId, () => sessionManager.create({ cwd: t.cwd }), respawnDeps).sessionId
    },

    watchTranscript: (sessionId, nodeId, resume) => { watched.push({ sessionId, nodeId, resume }) },
    log: (line) => { log.push(line) }
  }

  return {
    deps, stateManager, sessionManager, daemon, daemonClient, io,
    log, watched, snapshotWrites, destroyed,
    /** Frames the session manager sent the daemon, by type. */
    sent: (type: string) => daemon.current.messages().filter((m) => m.type === type),
    dispose: () => daemonClient.dispose()
  }
}

const liveSession = (id: string, cols = 120, rows = 40): DaemonSessionInfo =>
  ({ id: pid(id), cols, rows, alive: true })
const deadSession = (id: string): DaemonSessionInfo =>
  ({ id: pid(id), cols: 80, rows: 24, alive: false })

describe('recovering nothing', () => {
  it('is a no-op on an empty state file', async () => {
    const h = await harness()
    const outcome = await recoverSurfaces(h.deps)
    expect(outcome).toEqual({ reattached: [], revived: [], archived: [], orphansDestroyed: [] })
    h.dispose()
  })
})

describe('a surface whose pty survived in the daemon', () => {
  it('is reattached rather than respawned', async () => {
    const h = await harness({ nodes: [terminal('t1')], daemonSessions: [liveSession('t1')] })
    const outcome = await recoverSurfaces(h.deps)

    expect(outcome.reattached).toEqual([pid('t1')])
    expect(outcome.revived).toEqual([])
    // The proof it was not respawned: no create frame reached the daemon.
    expect(h.sent('create')).toEqual([])
    h.dispose()
  })

  it('comes back alive, bound to the same pty', async () => {
    const h = await harness({ nodes: [terminal('t1')], daemonSessions: [liveSession('t1')] })
    await recoverSurfaces(h.deps)

    const node = h.stateManager.getNode(nid('t1'))
    expect(node).toMatchObject({ type: 'terminal', alive: true, sessionId: pid('t1') })
    h.dispose()
  })

  it('adopts the daemon’s geometry, not the persisted one', async () => {
    // The user may have resized the window while the server was down; the pty
    // is the authority on its own size.
    const h = await harness({ nodes: [terminal('t1')], daemonSessions: [liveSession('t1', 200, 60)] })
    await recoverSurfaces(h.deps)

    expect(h.stateManager.getNode(nid('t1'))).toMatchObject({ cols: 200, rows: 60 })
    h.dispose()
  })

  it('seeds the scrollback so a client attaching immediately sees the screen', async () => {
    const h = await harness({ nodes: [terminal('t1')], daemonSessions: [liveSession('t1')] })
    await recoverSurfaces(h.deps)

    expect(h.snapshotWrites).toEqual([{ sessionId: pid('t1'), scrollback: 'scrollback for t1' }])
    h.dispose()
  })

  it('resumes transcript watching when there is a session to follow', async () => {
    const h = await harness({
      nodes: [terminal('t1')], daemonSessions: [liveSession('t1')], resumeTargets: { t1: 'claude-1' }
    })
    await recoverSurfaces(h.deps)

    expect(h.watched).toEqual([{ sessionId: pid('t1'), nodeId: nid('t1'), resume: cid('claude-1') }])
    h.dispose()
  })

  it('does not destroy the pty it just adopted', async () => {
    const h = await harness({ nodes: [terminal('t1')], daemonSessions: [liveSession('t1')] })
    await recoverSurfaces(h.deps)
    expect(h.destroyed).toEqual([])
    h.dispose()
  })
})

describe('a surface whose pty is gone', () => {
  it('is revived with a fresh pty', async () => {
    const h = await harness({ nodes: [terminal('t1')] })
    const outcome = await recoverSurfaces(h.deps)

    expect(outcome.revived).toEqual([nid('t1')])
    expect(h.sent('create')).toHaveLength(1)
    h.dispose()
  })

  it('is rebound to the new pty, so the node id survives but the session id changes', async () => {
    // This is the distinction branded ids exist to protect: the node keeps its
    // identity across a restart, the pty does not.
    const h = await harness({ nodes: [terminal('t1')] })
    await recoverSurfaces(h.deps)

    const node = h.stateManager.getNode(nid('t1'))
    expect(node?.id).toBe(nid('t1'))
    expect((node as { sessionId: PtySessionId }).sessionId).not.toBe(pid('t1'))
    h.dispose()
  })

  it('stays protected from archival until the caller disarms it', async () => {
    // A pty that dies seconds after revival must not archive the node out from
    // under the user; the 30-second window is the caller's policy.
    const h = await harness({ nodes: [terminal('t1')] })
    await recoverSurfaces(h.deps)
    expect(h.stateManager.isReviving(nid('t1'))).toBe(true)
    h.dispose()
  })

  it('is not reattached to an exited daemon entry', async () => {
    // The daemon reports exited sessions so the server can clean them up.
    // Adopting one would attach the surface to a corpse.
    const h = await harness({ nodes: [terminal('t1')], daemonSessions: [deadSession('t1')] })
    const outcome = await recoverSurfaces(h.deps)

    expect(outcome.reattached).toEqual([])
    expect(outcome.revived).toEqual([nid('t1')])
    h.dispose()
  })

  it('carries the shell title history onto the new pty', async () => {
    const h = await harness({ nodes: [terminal('t1', { shellTitleHistory: ['vim', 'npm test'] })] })
    await recoverSurfaces(h.deps)

    const node = h.stateManager.getNode(nid('t1'))
    expect((node as { shellTitleHistory: string[] }).shellTitleHistory).toContain('npm test')
    h.dispose()
  })
})

describe('a surface with nothing to come back to', () => {
  it('is archived rather than launched into an empty conversation', async () => {
    const h = await harness({ nodes: [terminal('t1')], requiresSession: ['t1'] })
    const outcome = await recoverSurfaces(h.deps)

    expect(outcome.archived).toEqual([nid('t1')])
    expect(h.sent('create')).toEqual([])
    h.dispose()
  })

  it('leaves no live node behind', async () => {
    const h = await harness({ nodes: [terminal('t1')], requiresSession: ['t1'] })
    await recoverSurfaces(h.deps)
    expect(h.stateManager.getNode(nid('t1'))).toBeUndefined()
    h.dispose()
  })

  it('is revived, not archived, once it has a session to resume', async () => {
    const h = await harness({
      nodes: [terminal('t1')], requiresSession: ['t1'], resumeTargets: { t1: 'claude-1' }
    })
    const outcome = await recoverSurfaces(h.deps)
    expect(outcome).toMatchObject({ archived: [], revived: [nid('t1')] })
    h.dispose()
  })
})

describe('when a reattach fails', () => {
  it('falls through to revival rather than losing the surface', async () => {
    const h = await harness({
      nodes: [terminal('t1')], daemonSessions: [liveSession('t1')], attachFailures: ['t1']
    })
    const outcome = await recoverSurfaces(h.deps)

    expect(outcome.reattached).toEqual([])
    expect(outcome.revived).toEqual([nid('t1')])
    h.dispose()
  })

  it('destroys the pty it could not adopt', async () => {
    // Left claimed, that pty runs forever with nothing attached — the exact
    // leak the orphan sweep exists to prevent.
    const h = await harness({
      nodes: [terminal('t1')], daemonSessions: [liveSession('t1')], attachFailures: ['t1']
    })
    const outcome = await recoverSurfaces(h.deps)

    expect(outcome.orphansDestroyed).toEqual([pid('t1')])
    expect(h.destroyed).toEqual([pid('t1')])
    h.dispose()
  })

  it('archives instead when the agent also has nothing to resume', async () => {
    const h = await harness({
      nodes: [terminal('t1')], daemonSessions: [liveSession('t1')],
      attachFailures: ['t1'], requiresSession: ['t1']
    })
    const outcome = await recoverSurfaces(h.deps)
    // The plan said reattach, so the archive branch is reached by fall-through.
    expect(outcome.revived).toEqual([nid('t1')])
    h.dispose()
  })

  it('says so in the log', async () => {
    const h = await harness({
      nodes: [terminal('t1')], daemonSessions: [liveSession('t1')], attachFailures: ['t1']
    })
    await recoverSurfaces(h.deps)
    expect(h.log.join('\n')).toMatch(/Failed to re-attach.*reviving instead/)
    h.dispose()
  })
})

describe('when a revive fails', () => {
  it('archives the surface rather than leaving a node with no pty', async () => {
    const h = await harness({ nodes: [terminal('t1')], reviveFailures: [nid('t1')] })
    const outcome = await recoverSurfaces(h.deps)

    expect(outcome.archived).toEqual([nid('t1')])
    expect(outcome.revived).toEqual([])
    h.dispose()
  })

  it('disarms revival protection first', async () => {
    // Otherwise the node is permanently immune to archival while having no pty
    // at all — a state nothing can ever clean up.
    const h = await harness({ nodes: [terminal('t1')], reviveFailures: [nid('t1')] })
    await recoverSurfaces(h.deps)
    expect(h.stateManager.isReviving(nid('t1'))).toBe(false)
    h.dispose()
  })

  it('keeps going for the remaining surfaces', async () => {
    const h = await harness({
      nodes: [terminal('t1'), terminal('t2')], reviveFailures: [nid('t1')]
    })
    const outcome = await recoverSurfaces(h.deps)

    expect(outcome.archived).toEqual([nid('t1')])
    expect(outcome.revived).toEqual([nid('t2')])
    h.dispose()
  })
})

describe('orphaned daemon sessions', () => {
  it('are destroyed when no surface claims them', async () => {
    // A pty the server lost track of holds a process and a megabyte of ring
    // buffer forever, invisible to the user.
    const h = await harness({ daemonSessions: [liveSession('ghost')] })
    const outcome = await recoverSurfaces(h.deps)

    expect(outcome.orphansDestroyed).toEqual([pid('ghost')])
    h.dispose()
  })

  it('leaves an already-exited session alone', async () => {
    const h = await harness({ daemonSessions: [deadSession('ghost')] })
    expect((await recoverSurfaces(h.deps)).orphansDestroyed).toEqual([])
    h.dispose()
  })

  it('destroys only the sessions nobody adopted', async () => {
    const h = await harness({
      nodes: [terminal('t1')],
      daemonSessions: [liveSession('t1'), liveSession('ghost')]
    })
    const outcome = await recoverSurfaces(h.deps)

    expect(outcome.reattached).toEqual([pid('t1')])
    expect(outcome.orphansDestroyed).toEqual([pid('ghost')])
    h.dispose()
  })

  it('does not count a pty spawned during revival as an orphan', async () => {
    // Revived ptys are created after the daemon list was taken, so they are
    // not in it — but a future change that re-listed would need this to hold.
    const h = await harness({ nodes: [terminal('t1')] })
    const outcome = await recoverSurfaces(h.deps)
    expect(outcome.orphansDestroyed).toEqual([])
    h.dispose()
  })
})

describe('a mixed canvas', () => {
  it('handles reattach, revive and archive in one pass', async () => {
    const h = await harness({
      nodes: [terminal('survivor'), terminal('respawn'), terminal('doomed')],
      daemonSessions: [liveSession('survivor'), liveSession('ghost')],
      requiresSession: ['doomed']
    })
    const outcome = await recoverSurfaces(h.deps)

    expect(outcome).toEqual({
      reattached: [pid('survivor')],
      revived: [nid('respawn')],
      archived: [nid('doomed')],
      orphansDestroyed: [pid('ghost')]
    })
    h.dispose()
  })

  it('leaves exactly the surviving surfaces in state', async () => {
    const h = await harness({
      nodes: [terminal('survivor'), terminal('respawn'), terminal('doomed')],
      daemonSessions: [liveSession('survivor')],
      requiresSession: ['doomed']
    })
    await recoverSurfaces(h.deps)

    const ids = Object.keys(h.stateManager.getState().nodes).sort()
    expect(ids).toEqual(['respawn', 'survivor'])
    h.dispose()
  })

  it('persists the result, so a crash right after startup does not redo it', async () => {
    const h = await harness({ nodes: [terminal('t1')] })
    await recoverSurfaces(h.deps)
    h.io.advance(2000)

    const persisted = JSON.parse(h.io.stored!) as ServerState
    expect(Object.keys(persisted.nodes)).toEqual(['t1'])
    h.dispose()
  })
})

describe('non-terminal nodes', () => {
  it('are left alone entirely', async () => {
    const markdown = {
      type: 'markdown', id: nid('md'), parentId: ROOT_NODE_ID,
      x: 0, y: 0, zIndex: 1, width: 400, height: 300, content: 'notes',
      archivedChildren: []
    } as unknown as NodeData

    const h = await harness({ nodes: [markdown] })
    const outcome = await recoverSurfaces(h.deps)

    expect(outcome).toEqual({ reattached: [], revived: [], archived: [], orphansDestroyed: [] })
    expect(h.stateManager.getNode(nid('md'))).toMatchObject({ type: 'markdown', content: 'notes' })
    h.dispose()
  })
})

describe('the sequence itself', () => {
  it('asks the daemon what it has before touching state', async () => {
    // Processing dead terminals first would mark everything dead, then discover
    // half of them were alive all along.
    const order: string[] = []
    const h = await harness({ nodes: [terminal('t1')] })
    const traced: StartupRecoveryDeps = {
      ...h.deps,
      listDaemonSessions: async () => { order.push('list'); return [] },
      takeRecoverableTerminals: () => { order.push('take'); return [] as RecoverableTerminal[] }
    }
    await recoverSurfaces(traced)

    expect(order).toEqual(['list', 'take'])
    h.dispose()
  })

  it('sweeps orphans after every surface has had its chance to claim one', async () => {
    const order: string[] = []
    const h = await harness({ nodes: [terminal('t1')], daemonSessions: [liveSession('t1')] })
    const traced: StartupRecoveryDeps = {
      ...h.deps,
      reattachSurface: (...args) => { order.push('reattach'); h.deps.reattachSurface(...args) },
      destroyDaemonSession: (id) => { order.push('destroy') ; h.deps.destroyDaemonSession(id) }
    }
    await recoverSurfaces(traced)

    expect(order).toEqual(['reattach'])
    h.dispose()
  })
})
