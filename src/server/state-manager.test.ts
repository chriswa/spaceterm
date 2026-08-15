import { describe, it, expect } from 'vitest'
import { StateManager, ARCHIVAL_PROTECTION_MS, type StateManagerDeps } from './state-manager'
import { StatePersister } from './persistence'
import { CURRENT_STATE_VERSION } from './state-migrations'
import { FakePersistenceIO } from './testing/fake-persistence'
import type { NodeData, ServerState, TerminalNodeData } from '../shared/state'
import { asNodeId as nid, asPtySessionId as pid, asClaudeSessionId as cid, ROOT_NODE_ID } from '../shared/ids'
import type { NodeId } from '../shared/ids'

const DEBOUNCE = 1000

interface Harness {
  sm: StateManager
  io: FakePersistenceIO
  updates: Array<{ nodeId: NodeId; fields: Partial<NodeData> }>
  adds: NodeData[]
  removes: NodeId[]
}

/**
 * Build a StateManager backed by in-memory persistence.
 *
 * This is the thing that was impossible before `StatePersister` existed: the
 * debounce timer was module-scoped, so constructing a StateManager in a test
 * meant scheduling a real write to the developer's real state file.
 */
function harness(seed?: unknown): Harness {
  const io = new FakePersistenceIO()
  if (seed !== undefined) io.seed(seed)

  const updates: Harness['updates'] = []
  const adds: NodeData[] = []
  const removes: Harness['removes'] = []

  const deps: StateManagerDeps = {
    onNodeUpdate: (nodeId, fields) => updates.push({ nodeId, fields }),
    onNodeAdd: (node) => adds.push(node),
    onNodeRemove: (nodeId) => removes.push(nodeId)
  }

  const sm = new StateManager(deps, { persister: new StatePersister(io, DEBOUNCE) })
  return { sm, io, updates, adds, removes }
}

function createTerminal(sm: StateManager, sessionId: string, parentId = ROOT_NODE_ID): TerminalNodeData {
  return sm.createTerminal({ sessionId: pid(sessionId), parentId, x: 0, y: 0, cols: 80, rows: 24 })
}

describe('StateManager construction', () => {
  it('starts from an empty state when nothing is persisted', () => {
    const { sm } = harness()
    const state = sm.getState()

    expect(state.version).toBe(CURRENT_STATE_VERSION)
    expect(state.nodes).toEqual({})
    expect(state.rootArchivedChildren).toEqual([])
    expect(state.undoBuffer).toEqual([])
    expect(state.savedViewports).toEqual({})
  })

  it('falls back to empty state when the persisted document is unreadable', () => {
    const { sm } = harness('{ truncated')
    expect(sm.getState().nodes).toEqual({})
  })

  it('restores nodes from a persisted document', () => {
    const persisted: Partial<ServerState> = {
      version: 1,
      nextZIndex: 5,
      nodes: {
        t1: {
          id: 't1',
          type: 'terminal',
          alive: true,
          sessionId: 't1',
          parentId: 'root',
          x: 10,
          y: 20,
          zIndex: 1,
          cols: 80,
          rows: 24,
          claudeState: 'stopped',
          claudeStatusUnread: false,
          claudeStatusAsleep: false,
          sortOrder: 0,
          terminalSessions: [{ sessionIndex: 0, startedAt: '2024-01-01T00:00:00Z', trigger: 'initial', shellTitleHistory: [] }],
          claudeSessionHistory: [],
          shellTitleHistory: [],
          archivedChildren: [],
          colorPresetId: 'inherit'
        } as unknown as TerminalNodeData
      }
    }

    const { sm } = harness(persisted)
    expect(sm.getNode(nid('t1'))?.type).toBe('terminal')
    expect(sm.getState().nextZIndex).toBe(5)
  })

  it('migrates an older persisted document on the way in', () => {
    // A state file written before rootArchivedChildren / undoBuffer / savedViewports
    // existed. StateManager no longer backfills these itself — state-migrations.ts
    // does, once, and stamps the new version.
    const { sm } = harness({ version: 1, nextZIndex: 1, nodes: {} })
    const state = sm.getState()

    expect(state.version).toBe(CURRENT_STATE_VERSION)
    expect(state.rootArchivedChildren).toEqual([])
    expect(state.undoBuffer).toEqual([])
    expect(state.undoCursor).toBe(0)
    expect(state.savedViewports).toEqual({})
  })

  it('persists the migrated version, so the migration runs only once', () => {
    const { sm, io } = harness({ version: 1, nextZIndex: 1, nodes: {} })
    sm.persistImmediate()

    expect(io.lastWritten<{ version: number }>().version).toBe(CURRENT_STATE_VERSION)

    io.archived.length = 0
    new StateManager(
      { onNodeUpdate: () => {}, onNodeAdd: () => {}, onNodeRemove: () => {} },
      { persister: new StatePersister(io, DEBOUNCE) }
    )
    expect(io.archived).toHaveLength(0)
  })
})

describe('StateManager persistence', () => {
  it('debounces writes rather than writing on every mutation', () => {
    const { sm, io } = harness()

    createTerminal(sm, 't1')
    sm.moveNode(nid('t1'), 5, 5)
    sm.moveNode(nid('t1'), 6, 6)
    expect(io.writes).toHaveLength(0)

    io.advance(DEBOUNCE)
    expect(io.writes).toHaveLength(1)
  })

  it('writes immediately on persistImmediate', () => {
    const { sm, io } = harness()

    createTerminal(sm, 't1')
    sm.persistImmediate()

    expect(io.writes).toHaveLength(1)
    expect(io.lastWritten<ServerState>().nodes.t1).toBeDefined()
  })

  it('persists what a reload would see', () => {
    const { sm, io } = harness()
    createTerminal(sm, 't1')
    sm.renameNode(nid('t1'), 'my terminal')
    sm.persistImmediate()

    // Reload from the same store, as a server restart would.
    const reloaded = new StateManager(
      { onNodeUpdate: () => {}, onNodeAdd: () => {}, onNodeRemove: () => {} },
      { persister: new StatePersister(io, DEBOUNCE) }
    )
    expect(reloaded.getNode(nid('t1'))?.name).toBe('my terminal')
  })
})

describe('two StateManagers in one process', () => {
  // The regression this whole refactor exists to prevent. With a module-scoped
  // debounce timer, B's mutation cancelled A's pending write and A's state was
  // silently lost.
  it('do not cancel each other pending writes', () => {
    const a = harness()
    const b = harness()

    createTerminal(a.sm, 'a1')
    createTerminal(b.sm, 'b1')

    a.io.advance(DEBOUNCE)
    b.io.advance(DEBOUNCE)

    expect(a.io.lastWritten<ServerState>().nodes.a1).toBeDefined()
    expect(b.io.lastWritten<ServerState>().nodes.b1).toBeDefined()
  })

  it('keep their node graphs separate', () => {
    const a = harness()
    const b = harness()

    createTerminal(a.sm, 'a1')
    createTerminal(b.sm, 'b1')

    expect(a.sm.getNode(nid('b1'))).toBeUndefined()
    expect(b.sm.getNode(nid('a1'))).toBeUndefined()
  })
})

describe('createTerminal', () => {
  it('announces the new node and registers its session mapping', () => {
    const { sm, adds } = harness()
    const node = createTerminal(sm, 't1')

    expect(adds).toHaveLength(1)
    expect(adds[0].id).toBe('t1')
    expect(node.alive).toBe(true)
    expect(sm.getNodeIdForSession(pid('t1'))).toBe('t1')
  })

  it('assigns increasing sortOrder to successive terminals', () => {
    const { sm } = harness()
    const a = createTerminal(sm, 't1')
    const b = createTerminal(sm, 't2')
    const c = createTerminal(sm, 't3')

    expect(b.sortOrder).toBeGreaterThan(a.sortOrder)
    expect(c.sortOrder).toBeGreaterThan(b.sortOrder)
  })

  it('inserts after a named node by shifting later terminals down', () => {
    const { sm } = harness()
    const a = createTerminal(sm, 't1')
    const cSortOrderBefore = createTerminal(sm, 't3').sortOrder

    const b = sm.createTerminal({ sessionId: pid('t2'), parentId: nid('root'), x: 0, y: 0, cols: 80, rows: 24, insertAfterNodeId: nid('t1') })

    const after = sm.getNode(nid('t3')) as TerminalNodeData
    expect(b.sortOrder).toBe(a.sortOrder + 1)
    expect(after.sortOrder).toBeGreaterThan(b.sortOrder)
    expect(after.sortOrder).toBe(cSortOrderBefore + 1)
  })
})

describe('session id vs node id', () => {
  // protocol.ts documents that a PTY session id and a node id coincide only at
  // first launch and diverge after a restart. These pin that behaviour.
  it('coincide at first launch', () => {
    const { sm } = harness()
    createTerminal(sm, 't1')
    expect(sm.getNodeIdForSession(pid('t1'))).toBe('t1')
  })

  it('diverge after reincarnation, and the old session id stops resolving', () => {
    const { sm } = harness()
    createTerminal(sm, 't1')

    sm.protectFromArchival(pid('t1'))
    sm.terminalExited(pid('t1'), 1)
    sm.reincarnateTerminal(nid('t1'), pid('pty-2'), 100, 40)

    expect(sm.getNodeIdForSession(pid('pty-2'))).toBe('t1')
    expect(sm.getNodeIdForSession(pid('t1'))).toBeUndefined()

    const node = sm.getNode(nid('t1')) as TerminalNodeData
    expect(node.alive).toBe(true)
    expect(node.sessionId).toBe('pty-2')
    expect(node.cols).toBe(100)
    expect(node.terminalSessions).toHaveLength(2)
    expect(node.terminalSessions[1].trigger).toBe('reincarnation')
  })

  it('routes updates addressed by session id to the node id', () => {
    const { sm, updates } = harness()
    createTerminal(sm, 't1')
    sm.protectFromArchival(pid('t1'))
    sm.terminalExited(pid('t1'), 0)
    sm.reincarnateTerminal(nid('t1'), pid('pty-2'), 80, 24)

    updates.length = 0
    sm.updateCwd(pid('pty-2'), '/tmp/work')

    expect(updates.map((u) => u.nodeId)).toContain('t1')
    expect((sm.getNode(nid('t1')) as TerminalNodeData).cwd).toBe('/tmp/work')
  })
})

describe('resolveNodeIdForPtySession', () => {
  // The map-miss path. Callers used to write `getNodeIdForSession(id) ?? id`,
  // which resolves only while node id and pty session id still coincide.
  it('uses the session map when it has the answer', () => {
    const { sm } = harness()
    createTerminal(sm, 't1')
    expect(sm.resolveNodeIdForPtySession(pid('t1'))).toBe('t1')
  })

  it('falls back to node data for a restarted terminal the map has forgotten', () => {
    const { sm, io } = harness()
    createTerminal(sm, 't1')
    sm.protectFromArchival(pid('t1'))
    sm.terminalExited(pid('t1'), 0)
    sm.reincarnateTerminal(nid('t1'), pid('pty-2'), 80, 24)
    sm.persistImmediate()

    // A fresh StateManager, as after a server restart: node data is loaded from
    // disk but the session map is empty until ptys re-register.
    const restarted = new StateManager(
      { onNodeUpdate: () => {}, onNodeAdd: () => {}, onNodeRemove: () => {} },
      { persister: new StatePersister(io, DEBOUNCE) }
    )

    expect(restarted.getNodeIdForSession(pid('pty-2'))).toBeUndefined()
    expect(restarted.resolveNodeIdForPtySession(pid('pty-2'))).toBe('t1')
    // The old `?? surfaceId` fallback would have answered 't1' here only by
    // accident, and nothing at all for the reincarnated session id above.
    expect(restarted.resolveNodeIdForPtySession(pid('t1'))).toBeUndefined()
  })

  it('returns undefined for a session no node claims', () => {
    const { sm } = harness()
    createTerminal(sm, 't1')
    expect(sm.resolveNodeIdForPtySession(pid('nobody'))).toBeUndefined()
  })
})

describe('resolveNodeIdForFocus', () => {
  // What a `spaceterm-surface://<id>` deep link resolves against. The id is
  // opaque — a surface id and an agent session id are both UUIDs — so these
  // pin the order the two readings are tried in, and that a miss is a miss
  // rather than a wrong card raised.
  function recordAgentSession(sm: StateManager, ptySessionId: string, agentSessionId: string): void {
    sm.updateClaudeSessionHistory(pid(ptySessionId), [
      { claudeSessionId: cid(agentSessionId), reason: 'startup', timestamp: '2026-01-01T00:00:00.000Z' }
    ])
  }

  it('resolves a surface id', () => {
    const { sm } = harness()
    createTerminal(sm, 't1')
    expect(sm.resolveNodeIdForFocus('t1')).toEqual({ nodeId: 't1', matchedAs: 'surface' })
  })

  it('falls back to the agent session reading when no surface owns the id', () => {
    const { sm } = harness()
    createTerminal(sm, 't1')
    recordAgentSession(sm, 't1', 'agent-abc')

    expect(sm.resolveNodeIdForFocus('agent-abc')).toEqual({ nodeId: 't1', matchedAs: 'agent-session' })
  })

  it('prefers the surface reading when both would match', () => {
    const { sm } = harness()
    createTerminal(sm, 'shared-id')
    createTerminal(sm, 't2')
    recordAgentSession(sm, 't2', 'shared-id')

    expect(sm.resolveNodeIdForFocus('shared-id')).toEqual({ nodeId: 'shared-id', matchedAs: 'surface' })
  })

  it('still finds an agent session after its terminal restarted onto a new pty', () => {
    // The case the surface-only lookup could never serve: an agent session id
    // outlives the pty session id a link was built from.
    const { sm } = harness()
    createTerminal(sm, 't1')
    recordAgentSession(sm, 't1', 'agent-abc')
    sm.protectFromArchival(pid('t1'))
    sm.terminalExited(pid('t1'), 0)
    sm.reincarnateTerminal(nid('t1'), pid('pty-2'), 80, 24)

    expect(sm.resolveNodeIdForFocus('t1')).toBeUndefined()
    expect(sm.resolveNodeIdForFocus('agent-abc')).toEqual({ nodeId: 't1', matchedAs: 'agent-session' })
  })

  it('does not care which agent CLI recorded the session', () => {
    // Claude, Codex and Cursor all write their conversation id to the same
    // node fields, so this needs no per-agent branching — and must not grow any.
    const { sm } = harness()
    for (const agentType of ['claude', 'codex', 'cursor'] as const) {
      sm.createTerminal({
        sessionId: pid(`pty-${agentType}`),
        parentId: ROOT_NODE_ID,
        x: 0,
        y: 0,
        cols: 80,
        rows: 24,
        agentType
      })
      recordAgentSession(sm, `pty-${agentType}`, `chat-${agentType}`)
    }

    for (const agentType of ['claude', 'codex', 'cursor'] as const) {
      expect(sm.resolveNodeIdForFocus(`chat-${agentType}`)).toEqual({
        nodeId: `pty-${agentType}`,
        matchedAs: 'agent-session'
      })
    }
  })

  it('resolves a remnant, whose card is still on the canvas', () => {
    const { sm } = harness()
    createTerminal(sm, 't1')
    recordAgentSession(sm, 't1', 'agent-abc')
    sm.protectFromArchival(pid('t1'))
    sm.terminalExited(pid('t1'), 0)

    expect(sm.resolveNodeIdForFocus('agent-abc')).toEqual({ nodeId: 't1', matchedAs: 'agent-session' })
  })

  it('prefers a live node over a remnant hosting the same agent session', () => {
    // A session id reaches two nodes via a fork or a resume. The one the user
    // can still type into wins.
    const { sm } = harness()
    createTerminal(sm, 'dead')
    recordAgentSession(sm, 'dead', 'agent-abc')
    sm.protectFromArchival(pid('dead'))
    sm.terminalExited(pid('dead'), 0)

    createTerminal(sm, 'live')
    recordAgentSession(sm, 'live', 'agent-abc')

    expect(sm.resolveNodeIdForFocus('agent-abc')).toEqual({ nodeId: 'live', matchedAs: 'agent-session' })
  })

  it('ignores an archived node, so the link is a no-op rather than a resurrection', () => {
    const { sm } = harness()
    createTerminal(sm, 't1')
    recordAgentSession(sm, 't1', 'agent-abc')
    sm.archiveNode(nid('t1'))

    expect(sm.resolveNodeIdForFocus('t1')).toBeUndefined()
    expect(sm.resolveNodeIdForFocus('agent-abc')).toBeUndefined()
  })

  it('returns undefined for an id neither reading claims', () => {
    const { sm } = harness()
    createTerminal(sm, 't1')
    expect(sm.resolveNodeIdForFocus('nobody')).toBeUndefined()
  })
})

describe('terminalExited', () => {
  it('archives the node by default', () => {
    const { sm, removes } = harness()
    createTerminal(sm, 't1')

    sm.terminalExited(pid('t1'), 0)

    expect(removes).toContain('t1')
    expect(sm.getNode(nid('t1'))).toBeUndefined()
  })

  it('keeps a pty that dies inside its launch window as a dead remnant', () => {
    const { sm, removes } = harness()
    createTerminal(sm, 't1')
    sm.protectFromArchival(pid('t1'), 1000)

    sm.terminalExited(pid('t1'), 127, 1000 + ARCHIVAL_PROTECTION_MS - 1)

    expect(removes).not.toContain('t1')
    const node = sm.getNode(nid('t1')) as TerminalNodeData
    expect(node.alive).toBe(false)
    expect(node.exitCode).toBe(127)
  })

  it('archives a restored surface that exits long after it came back', () => {
    // The bug: protection was armed per node with no expiry, so unarchiving a
    // surface made it immune to archival for the rest of the server's life —
    // Ctrl-D hours later left a dead card on the canvas instead of archiving it.
    const { sm, removes } = harness()
    createTerminal(sm, 't1')
    sm.protectFromArchival(pid('t1'), 1000)

    sm.terminalExited(pid('t1'), 0, 1000 + ARCHIVAL_PROTECTION_MS)

    expect(removes).toContain('t1')
    expect(sm.getNode(nid('t1'))).toBeUndefined()
  })

  it('skips archival for the pty a restart is replacing', () => {
    const { sm, removes } = harness()
    createTerminal(sm, 't1')
    sm.suppressArchivalForRestart(pid('t1'))

    sm.terminalExited(pid('t1'), 0)

    expect(removes).not.toContain('t1')
    expect(sm.getNode(nid('t1'))).toBeDefined()
    // Scoped to that one pty: the replacement archives normally.
    sm.reincarnateTerminal(nid('t1'), pid('pty-2'), 80, 24)
    sm.terminalExited(pid('pty-2'), 0)
    expect(removes).toContain('t1')
  })

  it('archives the replacement pty even when the outgoing one never reports an exit', () => {
    // Restarting a dead remnant destroys no pty, so the suppression armed for the
    // outgoing session is never consumed. Keyed by node it would have been spent
    // on the *new* pty's exit, leaving the surface un-archivable.
    const { sm, removes } = harness()
    createTerminal(sm, 't1')
    sm.suppressArchivalForRestart(pid('t1'))
    sm.reincarnateTerminal(nid('t1'), pid('pty-2'), 80, 24)

    sm.terminalExited(pid('pty-2'), 0)

    expect(removes).toContain('t1')
  })

  it('ignores an unknown session id', () => {
    const { sm, removes } = harness()
    expect(() => sm.terminalExited(pid('nope'), 0)).not.toThrow()
    expect(removes).toHaveLength(0)
  })
})

describe('processDeadTerminals', () => {
  it('marks every terminal dead and returns it for revival', () => {
    const { sm, io } = harness()
    createTerminal(sm, 't1')
    createTerminal(sm, 't2')
    sm.persistImmediate()

    const revived = new StateManager(
      { onNodeUpdate: () => {}, onNodeAdd: () => {}, onNodeRemove: () => {} },
      { persister: new StatePersister(io, DEBOUNCE) }
    )
    const dead = revived.processDeadTerminals()

    expect(dead.map((d) => d.nodeId).sort()).toEqual(['t1', 't2'])
    expect((revived.getNode(nid('t1')) as TerminalNodeData).alive).toBe(false)
  })

  it('downgrades working_background to stopped, since the ledger backing it is gone', () => {
    const { sm, io } = harness()
    createTerminal(sm, 't1')
    sm.updateClaudeState(pid('t1'), 'working_background')
    sm.persistImmediate()

    const revived = new StateManager(
      { onNodeUpdate: () => {}, onNodeAdd: () => {}, onNodeRemove: () => {} },
      { persister: new StatePersister(io, DEBOUNCE) }
    )
    revived.processDeadTerminals()

    expect((revived.getNode(nid('t1')) as TerminalNodeData).claudeState).toBe('stopped')
  })

  it('preserves other claude states across a restart', () => {
    const { sm, io } = harness()
    createTerminal(sm, 't1')
    sm.updateClaudeState(pid('t1'), 'waiting_permission')
    sm.persistImmediate()

    const revived = new StateManager(
      { onNodeUpdate: () => {}, onNodeAdd: () => {}, onNodeRemove: () => {} },
      { persister: new StatePersister(io, DEBOUNCE) }
    )
    revived.processDeadTerminals()

    expect((revived.getNode(nid('t1')) as TerminalNodeData).claudeState).toBe('waiting_permission')
  })
})

describe('archive and unarchive', () => {
  it('round-trips a node through its parent archive', () => {
    const { sm } = harness()
    createTerminal(sm, 'parent')
    const child = sm.createMarkdown(nid('parent'), 10, 10, 'hello')

    sm.archiveNode(child.id)
    expect(sm.getNode(child.id)).toBeUndefined()
    expect(sm.peekArchivedNode(nid('parent'), child.id)?.id).toBe(child.id)

    sm.unarchiveNode(nid('parent'), child.id)
    expect(sm.getNode(child.id)?.id).toBe(child.id)
    expect(sm.peekArchivedNode(nid('parent'), child.id)).toBeUndefined()
  })

  it('restores at an override position when one is given', () => {
    const { sm } = harness()
    createTerminal(sm, 'parent')
    const child = sm.createMarkdown(nid('parent'), 10, 10, 'hello')

    sm.archiveNode(child.id)
    sm.unarchiveNode(nid('parent'), child.id, { x: 77, y: 88 })

    const restored = sm.getNode(child.id)
    expect(restored?.x).toBe(77)
    expect(restored?.y).toBe(88)
  })

  it('deleteArchivedNode removes it permanently', () => {
    const { sm } = harness()
    createTerminal(sm, 'parent')
    const child = sm.createMarkdown(nid('parent'), 10, 10, 'hello')

    sm.archiveNode(child.id)
    sm.deleteArchivedNode(nid('parent'), child.id)

    expect(sm.peekArchivedNode(nid('parent'), child.id)).toBeUndefined()
    sm.unarchiveNode(nid('parent'), child.id)
    expect(sm.getNode(child.id)).toBeUndefined()
  })
})

describe('node mutations broadcast their change', () => {
  it('moveNode reports the new coordinates', () => {
    const { sm, updates } = harness()
    createTerminal(sm, 't1')
    updates.length = 0

    sm.moveNode(nid('t1'), 42, 43)

    expect(updates).toEqual([{ nodeId: 't1', fields: { x: 42, y: 43 } }])
  })

  it('batchMoveNodes reports one update per node', () => {
    const { sm, updates } = harness()
    createTerminal(sm, 't1')
    createTerminal(sm, 't2')
    updates.length = 0

    sm.batchMoveNodes([
      { nodeId: nid('t1'), x: 1, y: 2 },
      { nodeId: nid('t2'), x: 3, y: 4 }
    ])

    expect(updates).toHaveLength(2)
    expect(sm.getNode(nid('t2'))).toMatchObject({ x: 3, y: 4 })
  })

  it('mutations on an unknown node are silently ignored', () => {
    const { sm, updates } = harness()
    sm.moveNode(nid('ghost'), 1, 1)
    sm.renameNode(nid('ghost'), 'x')
    sm.setNodeColor(nid('ghost'), 'red')

    expect(updates).toHaveLength(0)
  })
})

describe('getNearestTerminalAncestor', () => {
  it('skips intermediate non-terminal nodes', () => {
    const { sm } = harness()
    createTerminal(sm, 'term')
    const title = sm.createTitle(nid('term'), 0, 0, 'a title')
    const md = sm.createMarkdown(title.id, 0, 0, 'body')

    expect(sm.getNearestTerminalAncestor(md.id)).toBe('term')
  })

  it('returns undefined when the chain reaches the root without a terminal', () => {
    const { sm } = harness()
    const md = sm.createMarkdown(nid('root'), 0, 0, 'body')
    expect(sm.getNearestTerminalAncestor(md.id)).toBeUndefined()
  })

  it('does not count the node itself', () => {
    const { sm } = harness()
    createTerminal(sm, 'term')
    expect(sm.getNearestTerminalAncestor(nid('term'))).toBeUndefined()
  })
})

describe('patched fields are broadcast exactly as applied', () => {
  // The mutate → broadcast pair used to be written by hand at ~30 sites, each
  // with an `as Partial<X>` cast that switched off excess-property checking —
  // so a typo'd field name compiled, broadcast a key no client reads, and
  // silently did nothing. These pin that the two halves cannot drift.
  function patchedFields(h: Harness, nodeId: NodeId): Array<Record<string, unknown>> {
    return h.updates.filter((u) => u.nodeId === nodeId).map((u) => u.fields as Record<string, unknown>)
  }

  it('broadcasts the same value it stored, for a terminal field', () => {
    const h = harness()
    createTerminal(h.sm, 't1')
    h.updates.length = 0

    h.sm.updateClaudeState(pid('t1'), 'waiting_permission')

    expect(patchedFields(h, nid('t1'))).toEqual([{ claudeState: 'waiting_permission' }])
    expect((h.sm.getNode(nid('t1')) as TerminalNodeData).claudeState).toBe('waiting_permission')
  })

  it('broadcasts only the fields that changed', () => {
    const h = harness()
    createTerminal(h.sm, 't1')
    h.updates.length = 0

    h.sm.updateTerminalSize(pid('t1'), 120, 40)

    expect(patchedFields(h, nid('t1'))).toEqual([{ cols: 120, rows: 40 }])
  })

  it('carries an explicit undefined through, so a cleared field is cleared', () => {
    // reincarnate clears exitCode. Dropping it from the broadcast would leave a
    // stale exit code on the client while the server showed none.
    const h = harness()
    createTerminal(h.sm, 't1')
    h.sm.protectFromArchival(pid('t1'))
    h.sm.terminalExited(pid('t1'), 3)
    h.updates.length = 0

    h.sm.reincarnateTerminal(nid('t1'), pid('pty-2'), 80, 24)

    const fields = patchedFields(h, nid('t1'))[0]
    expect('exitCode' in fields).toBe(true)
    expect(fields.exitCode).toBeUndefined()
    expect((h.sm.getNode(nid('t1')) as TerminalNodeData).exitCode).toBeUndefined()
  })

  it('applies markdown fields to the node it broadcasts about', () => {
    const h = harness()
    createTerminal(h.sm, 'parent')
    const md = h.sm.createMarkdown(nid('parent'), 0, 0, 'body')
    h.updates.length = 0

    h.sm.resizeMarkdown(md.id, 300, 200)

    expect(patchedFields(h, md.id)).toEqual([{ width: 300, height: 200 }])
    expect(h.sm.getNode(md.id)).toMatchObject({ width: 300, height: 200 })
  })

  it('records lastInteractedAt even on the ticks it does not broadcast', () => {
    // The broadcast is throttled to once a minute, but the persisted value must
    // stay current — the two used to be written separately.
    const h = harness()
    createTerminal(h.sm, 't1')
    h.sm.updateLastInteracted(pid('t1'), 60_000)
    h.updates.length = 0

    h.sm.updateLastInteracted(pid('t1'), 60_001)

    expect(h.updates).toHaveLength(0)
    expect((h.sm.getNode(nid('t1')) as TerminalNodeData).lastInteractedAt).toBe(60_001)
  })

  it('broadcasts again once the displayed minute changes', () => {
    const h = harness()
    createTerminal(h.sm, 't1')
    h.sm.updateLastInteracted(pid('t1'), 60_000)
    h.updates.length = 0

    h.sm.updateLastInteracted(pid('t1'), 120_000)

    expect(patchedFields(h, nid('t1'))).toEqual([{ lastInteractedAt: 120_000 }])
  })

  it('reorderCrabs broadcasts one sortOrder per moved terminal', () => {
    const h = harness()
    createTerminal(h.sm, 't1')
    createTerminal(h.sm, 't2')
    createTerminal(h.sm, 't3')
    h.updates.length = 0

    h.sm.reorderCrabs([nid('t3'), nid('t1'), nid('t2')])

    const order = (id: string): number => (h.sm.getNode(nid(id)) as TerminalNodeData).sortOrder
    expect(order('t3')).toBe(0)
    expect(order('t1')).toBe(1)
    expect(order('t2')).toBe(2)
    // Every broadcast value matches what was stored.
    for (const u of h.updates) {
      expect((h.sm.getNode(u.nodeId) as TerminalNodeData).sortOrder)
        .toBe((u.fields as { sortOrder: number }).sortOrder)
    }
  })
})

describe('live agent state has one owner', () => {
  // These five fields used to be mirrored in SessionManager's in-memory session
  // as well as on the node: written to both at every call site, and read with a
  // `session ?? node` fallback. The session copy was always the weaker one — a
  // server restart cleared it and reincarnation reset it — which is what the
  // fallbacks were for. These pin that reads follow the node.
  it('reports the state that was last written', () => {
    const h = harness()
    createTerminal(h.sm, 't1')

    h.sm.updateClaudeState(pid('t1'), 'waiting_plan')
    expect(h.sm.getClaudeState(pid('t1'))).toBe('waiting_plan')
  })

  it('defaults to stopped for an unknown session', () => {
    const h = harness()
    expect(h.sm.getClaudeState(pid('nobody'))).toBe('stopped')
    expect(h.sm.getClaudeStatusUnread(pid('nobody'))).toBe(false)
    expect(h.sm.getClaudeStatusAsleep(pid('nobody'))).toBe(false)
  })

  it('keeps the asleep flag across a reincarnation', () => {
    // The divergence the old code documented and worked around: the session
    // copy was reset to false by initLocalSession while the node kept true, so
    // whichever copy you read gave a different answer.
    const h = harness()
    createTerminal(h.sm, 't1')
    h.sm.updateClaudeStatusAsleep(pid('t1'), true)

    h.sm.protectFromArchival(pid('t1'))
    h.sm.terminalExited(pid('t1'), 0)
    h.sm.reincarnateTerminal(nid('t1'), pid('pty-2'), 80, 24)

    expect(h.sm.getClaudeStatusAsleep(pid('pty-2'))).toBe(true)
  })

  it('resolves an asleep toggle on a dead remnant, whose session id still maps', () => {
    // terminalExited deliberately preserves sessionToNodeId for revived
    // surfaces so this keeps working.
    const h = harness()
    createTerminal(h.sm, 't1')
    h.sm.protectFromArchival(pid('t1'))
    h.sm.terminalExited(pid('t1'), 1)

    h.sm.updateClaudeStatusAsleep(pid('t1'), true)
    expect(h.sm.getClaudeStatusAsleep(pid('t1'))).toBe(true)
  })

  it('survives a server restart, because the node is persisted', () => {
    const h = harness()
    createTerminal(h.sm, 't1')
    h.sm.updateClaudeContextPercent(pid('t1'), 42)
    h.sm.updateClaudeSessionLineCount(pid('t1'), 1234)
    h.sm.persistImmediate()

    // The real restart flow: load state, revive the terminal onto a fresh pty,
    // and only then does anything read by session id. The session-side copy was
    // in-memory only and did not make this trip, which is why every reader used
    // to fall back to the node.
    const restarted = new StateManager(
      { onNodeUpdate: () => {}, onNodeAdd: () => {}, onNodeRemove: () => {} },
      { persister: new StatePersister(h.io, DEBOUNCE) }
    )
    restarted.processDeadTerminals()
    restarted.reincarnateTerminal(nid('t1'), pid('pty-after-restart'), 80, 24)

    expect(restarted.getClaudeContextPercent(pid('pty-after-restart'))).toBe(42)
    expect(restarted.getClaudeSessionLineCount(pid('pty-after-restart'))).toBe(1234)
  })

  it('a restart resets the fields that describe a live pty, and keeps the rest', () => {
    const h = harness()
    createTerminal(h.sm, 't1')
    h.sm.updateClaudeState(pid('t1'), 'waiting_permission')
    h.sm.updateClaudeStatusUnread(pid('t1'), true)
    h.sm.updateClaudeStatusAsleep(pid('t1'), true)
    h.sm.updateClaudeContextPercent(pid('t1'), 42)
    h.sm.persistImmediate()

    const restarted = new StateManager(
      { onNodeUpdate: () => {}, onNodeAdd: () => {}, onNodeRemove: () => {} },
      { persister: new StatePersister(h.io, DEBOUNCE) }
    )
    restarted.processDeadTerminals()
    restarted.reincarnateTerminal(nid('t1'), pid('pty-2'), 80, 24)

    // A fresh pty has done nothing yet, so state and unread start clean...
    expect(restarted.getClaudeState(pid('pty-2'))).toBe('stopped')
    expect(restarted.getClaudeStatusUnread(pid('pty-2'))).toBe(false)
    // ...but the user's asleep choice and the last known context are not facts
    // about the pty, and outlive it.
    expect(restarted.getClaudeStatusAsleep(pid('pty-2'))).toBe(true)
    expect(restarted.getClaudeContextPercent(pid('pty-2'))).toBe(42)
  })

  describe('dedup', () => {
    it('does not broadcast an unchanged state', () => {
      const h = harness()
      createTerminal(h.sm, 't1')
      h.sm.updateClaudeState(pid('t1'), 'working')
      h.updates.length = 0

      h.sm.updateClaudeState(pid('t1'), 'working')
      expect(h.updates).toEqual([])
    })

    it('does not broadcast an unchanged unread flag', () => {
      const h = harness()
      createTerminal(h.sm, 't1')
      h.sm.updateClaudeStatusUnread(pid('t1'), true)
      h.updates.length = 0

      h.sm.updateClaudeStatusUnread(pid('t1'), true)
      expect(h.updates).toEqual([])
    })

    it('does not broadcast an unchanged asleep flag', () => {
      const h = harness()
      createTerminal(h.sm, 't1')
      h.sm.updateClaudeStatusAsleep(pid('t1'), true)
      h.updates.length = 0

      h.sm.updateClaudeStatusAsleep(pid('t1'), true)
      expect(h.updates).toEqual([])
    })

    it('reports whether the telemetry values changed, so callers can gate a broadcast', () => {
      const h = harness()
      createTerminal(h.sm, 't1')

      expect(h.sm.updateClaudeContextPercent(pid('t1'), 50)).toBe(true)
      expect(h.sm.updateClaudeContextPercent(pid('t1'), 50)).toBe(false)
      expect(h.sm.updateClaudeSessionLineCount(pid('t1'), 10)).toBe(true)
      expect(h.sm.updateClaudeSessionLineCount(pid('t1'), 10)).toBe(false)
    })

    it('reports no change for an unknown session', () => {
      const h = harness()
      expect(h.sm.updateClaudeContextPercent(pid('nobody'), 50)).toBe(false)
      expect(h.sm.updateClaudeSessionLineCount(pid('nobody'), 10)).toBe(false)
    })
  })
})

describe('setAlert', () => {
  // Alerts now have more than one producer — the cwd-mismatch scan and launch
  // failures — so the invariant that matters is that each replaces only its own
  // kind.

  function withTerminal() {
    const h = harness()
    const node = createTerminal(h.sm, 't1')
    h.updates.length = 0
    return { ...h, node }
  }

  it('raises an alert of the given kind', () => {
    const h = withTerminal()
    h.sm.setAlert(h.node.id, 'launch-failed', 'Restart failed: boom', 1000)

    expect(h.sm.getNode(h.node.id)?.alerts).toEqual([
      { type: 'launch-failed', message: 'Restart failed: boom', timestamp: 1000 }
    ])
  })

  it('broadcasts the change', () => {
    const h = withTerminal()
    h.sm.setAlert(h.node.id, 'launch-failed', 'boom', 1000)
    expect(h.updates.at(-1)).toMatchObject({ nodeId: h.node.id })
    expect(h.updates.at(-1)?.fields.alerts).toHaveLength(1)
  })

  it('leaves alerts of other kinds alone', () => {
    const h = withTerminal()
    h.sm.setAlert(h.node.id, 'cwd-mismatch', 'moved', 1000)
    h.sm.setAlert(h.node.id, 'launch-failed', 'boom', 2000)

    expect(h.sm.getNode(h.node.id)?.alerts?.map((a) => a.type).sort())
      .toEqual(['cwd-mismatch', 'launch-failed'])
  })

  it('clears only the named kind', () => {
    const h = withTerminal()
    h.sm.setAlert(h.node.id, 'cwd-mismatch', 'moved', 1000)
    h.sm.setAlert(h.node.id, 'launch-failed', 'boom', 2000)
    h.sm.setAlert(h.node.id, 'launch-failed', null)

    expect(h.sm.getNode(h.node.id)?.alerts).toEqual([
      { type: 'cwd-mismatch', message: 'moved', timestamp: 1000 }
    ])
  })

  it('keeps the first-detected timestamp when the message changes', () => {
    // The unread badge compares against this timestamp. Refreshing it would
    // make an alert the user already dismissed pop back as unread.
    const h = withTerminal()
    h.sm.setAlert(h.node.id, 'launch-failed', 'first reason', 1000)
    h.sm.setAlert(h.node.id, 'launch-failed', 'second reason', 5000)

    expect(h.sm.getNode(h.node.id)?.alerts).toEqual([
      { type: 'launch-failed', message: 'second reason', timestamp: 1000 }
    ])
  })

  it('is a no-op when re-raising the identical alert', () => {
    const h = withTerminal()
    h.sm.setAlert(h.node.id, 'launch-failed', 'boom', 1000)
    const after = h.updates.length
    h.sm.setAlert(h.node.id, 'launch-failed', 'boom', 9999)
    expect(h.updates.length).toBe(after)
  })

  it('is a no-op when clearing something that is not there', () => {
    const h = withTerminal()
    h.sm.setAlert(h.node.id, 'launch-failed', null)
    expect(h.updates).toEqual([])
  })

  it('broadcasts an empty array rather than undefined when the last alert clears', () => {
    // An absent key leaves the previous list on screen; [] reads as "none".
    const h = withTerminal()
    h.sm.setAlert(h.node.id, 'launch-failed', 'boom', 1000)
    h.sm.setAlert(h.node.id, 'launch-failed', null)

    expect(h.updates.at(-1)?.fields.alerts).toEqual([])
    // Stored as undefined, so an empty key is not persisted.
    expect(h.sm.getNode(h.node.id)?.alerts).toBeUndefined()
  })

  it('ignores an unknown node', () => {
    const h = withTerminal()
    expect(() => h.sm.setAlert(nid('ghost'), 'launch-failed', 'boom', 1000)).not.toThrow()
    expect(h.updates).toEqual([])
  })

  it('works on non-terminal nodes too', () => {
    // Alerts live on BaseNodeData; nothing about them is terminal-specific.
    const h = harness()
    const md = h.sm.createMarkdown(ROOT_NODE_ID, 0, 0, 'hi')
    h.sm.setAlert(md.id, 'launch-failed', 'boom', 1000)
    expect(h.sm.getNode(md.id)?.alerts).toHaveLength(1)
  })
})
