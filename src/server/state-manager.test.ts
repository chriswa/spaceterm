import { describe, it, expect } from 'vitest'
import { StateManager, type StateManagerDeps } from './state-manager'
import { StatePersister } from './persistence'
import { FakePersistenceIO } from './testing/fake-persistence'
import type { NodeData, ServerState, TerminalNodeData } from '../shared/state'

const DEBOUNCE = 1000

interface Harness {
  sm: StateManager
  io: FakePersistenceIO
  updates: Array<{ nodeId: string; fields: Partial<NodeData> }>
  adds: NodeData[]
  removes: string[]
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
  const removes: string[] = []

  const deps: StateManagerDeps = {
    onNodeUpdate: (nodeId, fields) => updates.push({ nodeId, fields }),
    onNodeAdd: (node) => adds.push(node),
    onNodeRemove: (nodeId) => removes.push(nodeId)
  }

  const sm = new StateManager(deps, { persister: new StatePersister(io, DEBOUNCE) })
  return { sm, io, updates, adds, removes }
}

function createTerminal(sm: StateManager, sessionId: string, parentId = 'root'): TerminalNodeData {
  return sm.createTerminal(sessionId, parentId, 0, 0, 80, 24)
}

describe('StateManager construction', () => {
  it('starts from an empty state when nothing is persisted', () => {
    const { sm } = harness()
    const state = sm.getState()

    expect(state.version).toBe(1)
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
        } as TerminalNodeData
      }
    }

    const { sm } = harness(persisted)
    expect(sm.getNode('t1')?.type).toBe('terminal')
    expect(sm.getState().nextZIndex).toBe(5)
  })

  it('backfills fields absent from older persisted documents', () => {
    // A state file written before rootArchivedChildren / undoBuffer / savedViewports existed.
    const { sm } = harness({ version: 1, nextZIndex: 1, nodes: {} })
    const state = sm.getState()

    expect(state.rootArchivedChildren).toEqual([])
    expect(state.undoBuffer).toEqual([])
    expect(state.undoCursor).toBe(0)
    expect(state.savedViewports).toEqual({})
  })
})

describe('StateManager persistence', () => {
  it('debounces writes rather than writing on every mutation', () => {
    const { sm, io } = harness()

    createTerminal(sm, 't1')
    sm.moveNode('t1', 5, 5)
    sm.moveNode('t1', 6, 6)
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
    sm.renameNode('t1', 'my terminal')
    sm.persistImmediate()

    // Reload from the same store, as a server restart would.
    const reloaded = new StateManager(
      { onNodeUpdate: () => {}, onNodeAdd: () => {}, onNodeRemove: () => {} },
      { persister: new StatePersister(io, DEBOUNCE) }
    )
    expect(reloaded.getNode('t1')?.name).toBe('my terminal')
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

    expect(a.sm.getNode('b1')).toBeUndefined()
    expect(b.sm.getNode('a1')).toBeUndefined()
  })
})

describe('createTerminal', () => {
  it('announces the new node and registers its session mapping', () => {
    const { sm, adds } = harness()
    const node = createTerminal(sm, 't1')

    expect(adds).toHaveLength(1)
    expect(adds[0].id).toBe('t1')
    expect(node.alive).toBe(true)
    expect(sm.getNodeIdForSession('t1')).toBe('t1')
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

    const b = sm.createTerminal('t2', 'root', 0, 0, 80, 24, undefined, undefined, undefined, 't1')

    const after = sm.getNode('t3') as TerminalNodeData
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
    expect(sm.getNodeIdForSession('t1')).toBe('t1')
  })

  it('diverge after reincarnation, and the old session id stops resolving', () => {
    const { sm } = harness()
    createTerminal(sm, 't1')

    sm.markReviving('t1')
    sm.terminalExited('t1', 1)
    sm.reincarnateTerminal('t1', 'pty-2', 100, 40)

    expect(sm.getNodeIdForSession('pty-2')).toBe('t1')
    expect(sm.getNodeIdForSession('t1')).toBeUndefined()

    const node = sm.getNode('t1') as TerminalNodeData
    expect(node.alive).toBe(true)
    expect(node.sessionId).toBe('pty-2')
    expect(node.cols).toBe(100)
    expect(node.terminalSessions).toHaveLength(2)
    expect(node.terminalSessions[1].trigger).toBe('reincarnation')
  })

  it('routes updates addressed by session id to the node id', () => {
    const { sm, updates } = harness()
    createTerminal(sm, 't1')
    sm.markReviving('t1')
    sm.terminalExited('t1', 0)
    sm.reincarnateTerminal('t1', 'pty-2', 80, 24)

    updates.length = 0
    sm.updateCwd('pty-2', '/tmp/work')

    expect(updates.map((u) => u.nodeId)).toContain('t1')
    expect((sm.getNode('t1') as TerminalNodeData).cwd).toBe('/tmp/work')
  })
})

describe('terminalExited', () => {
  it('archives the node by default', () => {
    const { sm, removes } = harness()
    createTerminal(sm, 't1')

    sm.terminalExited('t1', 0)

    expect(removes).toContain('t1')
    expect(sm.getNode('t1')).toBeUndefined()
  })

  it('keeps a revived terminal as a dead remnant instead of archiving it', () => {
    const { sm, removes } = harness()
    createTerminal(sm, 't1')
    sm.markReviving('t1')

    sm.terminalExited('t1', 127)

    expect(removes).not.toContain('t1')
    const node = sm.getNode('t1') as TerminalNodeData
    expect(node.alive).toBe(false)
    expect(node.exitCode).toBe(127)
  })

  it('skips archival while a node is mid-restart', () => {
    const { sm, removes } = harness()
    createTerminal(sm, 't1')
    sm.markRestarting('t1')

    sm.terminalExited('t1', 0)

    expect(removes).not.toContain('t1')
    expect(sm.getNode('t1')).toBeDefined()
    // The mid-restart flag is one-shot: the next exit archives normally.
    sm.reincarnateTerminal('t1', 'pty-2', 80, 24)
    sm.terminalExited('pty-2', 0)
    expect(removes).toContain('t1')
  })

  it('ignores an unknown session id', () => {
    const { sm, removes } = harness()
    expect(() => sm.terminalExited('nope', 0)).not.toThrow()
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
    expect((revived.getNode('t1') as TerminalNodeData).alive).toBe(false)
  })

  it('downgrades working_background to stopped, since the ledger backing it is gone', () => {
    const { sm, io } = harness()
    createTerminal(sm, 't1')
    sm.updateClaudeState('t1', 'working_background')
    sm.persistImmediate()

    const revived = new StateManager(
      { onNodeUpdate: () => {}, onNodeAdd: () => {}, onNodeRemove: () => {} },
      { persister: new StatePersister(io, DEBOUNCE) }
    )
    revived.processDeadTerminals()

    expect((revived.getNode('t1') as TerminalNodeData).claudeState).toBe('stopped')
  })

  it('preserves other claude states across a restart', () => {
    const { sm, io } = harness()
    createTerminal(sm, 't1')
    sm.updateClaudeState('t1', 'waiting_permission')
    sm.persistImmediate()

    const revived = new StateManager(
      { onNodeUpdate: () => {}, onNodeAdd: () => {}, onNodeRemove: () => {} },
      { persister: new StatePersister(io, DEBOUNCE) }
    )
    revived.processDeadTerminals()

    expect((revived.getNode('t1') as TerminalNodeData).claudeState).toBe('waiting_permission')
  })
})

describe('archive and unarchive', () => {
  it('round-trips a node through its parent archive', () => {
    const { sm } = harness()
    createTerminal(sm, 'parent')
    const child = sm.createMarkdown('parent', 10, 10, 'hello')

    sm.archiveNode(child.id)
    expect(sm.getNode(child.id)).toBeUndefined()
    expect(sm.peekArchivedNode('parent', child.id)?.id).toBe(child.id)

    sm.unarchiveNode('parent', child.id)
    expect(sm.getNode(child.id)?.id).toBe(child.id)
    expect(sm.peekArchivedNode('parent', child.id)).toBeUndefined()
  })

  it('restores at an override position when one is given', () => {
    const { sm } = harness()
    createTerminal(sm, 'parent')
    const child = sm.createMarkdown('parent', 10, 10, 'hello')

    sm.archiveNode(child.id)
    sm.unarchiveNode('parent', child.id, { x: 77, y: 88 })

    const restored = sm.getNode(child.id)
    expect(restored?.x).toBe(77)
    expect(restored?.y).toBe(88)
  })

  it('deleteArchivedNode removes it permanently', () => {
    const { sm } = harness()
    createTerminal(sm, 'parent')
    const child = sm.createMarkdown('parent', 10, 10, 'hello')

    sm.archiveNode(child.id)
    sm.deleteArchivedNode('parent', child.id)

    expect(sm.peekArchivedNode('parent', child.id)).toBeUndefined()
    sm.unarchiveNode('parent', child.id)
    expect(sm.getNode(child.id)).toBeUndefined()
  })
})

describe('node mutations broadcast their change', () => {
  it('moveNode reports the new coordinates', () => {
    const { sm, updates } = harness()
    createTerminal(sm, 't1')
    updates.length = 0

    sm.moveNode('t1', 42, 43)

    expect(updates).toEqual([{ nodeId: 't1', fields: { x: 42, y: 43 } }])
  })

  it('batchMoveNodes reports one update per node', () => {
    const { sm, updates } = harness()
    createTerminal(sm, 't1')
    createTerminal(sm, 't2')
    updates.length = 0

    sm.batchMoveNodes([
      { nodeId: 't1', x: 1, y: 2 },
      { nodeId: 't2', x: 3, y: 4 }
    ])

    expect(updates).toHaveLength(2)
    expect(sm.getNode('t2')).toMatchObject({ x: 3, y: 4 })
  })

  it('mutations on an unknown node are silently ignored', () => {
    const { sm, updates } = harness()
    sm.moveNode('ghost', 1, 1)
    sm.renameNode('ghost', 'x')
    sm.setNodeColor('ghost', 'red')

    expect(updates).toHaveLength(0)
  })
})

describe('getNearestTerminalAncestor', () => {
  it('skips intermediate non-terminal nodes', () => {
    const { sm } = harness()
    createTerminal(sm, 'term')
    const title = sm.createTitle('term', 0, 0, 'a title')
    const md = sm.createMarkdown(title.id, 0, 0, 'body')

    expect(sm.getNearestTerminalAncestor(md.id)).toBe('term')
  })

  it('returns undefined when the chain reaches the root without a terminal', () => {
    const { sm } = harness()
    const md = sm.createMarkdown('root', 0, 0, 'body')
    expect(sm.getNearestTerminalAncestor(md.id)).toBeUndefined()
  })

  it('does not count the node itself', () => {
    const { sm } = harness()
    createTerminal(sm, 'term')
    expect(sm.getNearestTerminalAncestor('term')).toBeUndefined()
  })
})
