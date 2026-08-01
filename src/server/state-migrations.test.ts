import { describe, it, expect } from 'vitest'
import { migrateState, emptyState, MIGRATIONS, CURRENT_STATE_VERSION } from './state-migrations'
import type { TerminalNodeData } from '../shared/state'

/** A version-1 terminal node, with only the fields that version actually had. */
function v1Terminal(id: string, startedAt: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    type: 'terminal',
    alive: true,
    sessionId: id,
    parentId: 'root',
    x: 0,
    y: 0,
    zIndex: 1,
    cols: 80,
    rows: 24,
    claudeState: 'stopped',
    terminalSessions: [{ sessionIndex: 0, startedAt, trigger: 'initial', shellTitleHistory: [] }],
    claudeSessionHistory: [],
    shellTitleHistory: [],
    archivedChildren: [],
    ...extra
  }
}

function migrate(doc: unknown): ReturnType<typeof migrateState> {
  return migrateState(JSON.parse(JSON.stringify(doc)))
}

describe('migration bookkeeping', () => {
  it('has a migration for every version step up to current', () => {
    const targets = MIGRATIONS.map((m) => m.to).sort((a, b) => a - b)
    const expected = Array.from({ length: CURRENT_STATE_VERSION - 1 }, (_, i) => i + 2)
    expect(targets).toEqual(expected)
  })

  it('produces a document already at the current version', () => {
    expect(emptyState().version).toBe(CURRENT_STATE_VERSION)
  })

  it('leaves a current-version document alone and reports no migration', () => {
    const result = migrate(emptyState())
    expect(result).toMatchObject({ status: 'ok', migratedFrom: null })
  })
})

describe('rejecting documents we cannot honour', () => {
  it('reports an absent document as empty', () => {
    expect(migrateState(null)).toEqual({ status: 'empty' })
    expect(migrateState(undefined)).toEqual({ status: 'empty' })
  })

  it('reports a non-object as corrupt', () => {
    expect(migrateState('nope')).toMatchObject({ status: 'corrupt' })
    expect(migrateState([1, 2, 3])).toMatchObject({ status: 'corrupt' })
  })

  it('reports a missing version as corrupt rather than assuming version 1', () => {
    expect(migrateState({ nodes: {} })).toMatchObject({ status: 'corrupt', reason: 'missing version' })
  })

  it('reports missing nodes as corrupt', () => {
    expect(migrateState({ version: 1 })).toMatchObject({ status: 'corrupt', reason: 'missing nodes' })
  })

  it('refuses a version from the future rather than silently dropping its fields', () => {
    expect(migrateState({ version: 99, nodes: {} })).toEqual({
      status: 'too-new',
      found: 99,
      supported: CURRENT_STATE_VERSION
    })
  })
})

describe('migration 1 → 2: fields that were backfilled on every boot', () => {
  it('adds the top-level collections added after version 1 shipped', () => {
    const result = migrate({ version: 1, nodes: {} })
    if (result.status !== 'ok') throw new Error(`expected ok, got ${result.status}`)

    expect(result.state.rootArchivedChildren).toEqual([])
    expect(result.state.undoBuffer).toEqual([])
    expect(result.state.undoCursor).toBe(0)
    expect(result.state.savedViewports).toEqual({})
    expect(result.state.nextZIndex).toBe(1)
    expect(result.state.version).toBe(CURRENT_STATE_VERSION)
  })

  it('sets undoCursor to the end of an existing undoBuffer', () => {
    const result = migrate({ version: 1, nodes: {}, undoBuffer: [{ a: 1 }, { b: 2 }, { c: 3 }] })
    if (result.status !== 'ok') throw new Error('expected ok')
    expect(result.state.undoCursor).toBe(3)
  })

  it('does not clobber values that are already present', () => {
    const result = migrate({
      version: 1,
      nodes: {},
      nextZIndex: 12,
      undoCursor: 1,
      undoBuffer: [{ a: 1 }, { b: 2 }],
      savedViewports: { '3': { minX: 0, minY: 0, maxX: 1, maxY: 1 } },
      rootArchivedChildren: [{ node: { id: 'x' } }]
    })
    if (result.status !== 'ok') throw new Error('expected ok')

    expect(result.state.nextZIndex).toBe(12)
    expect(result.state.undoCursor).toBe(1)
    expect(Object.keys(result.state.savedViewports)).toEqual(['3'])
    expect(result.state.rootArchivedChildren).toHaveLength(1)
  })

  it('drops the removed waitingForUser key', () => {
    const result = migrate({
      version: 1,
      nodes: { t1: v1Terminal('t1', '2024-01-01T00:00:00Z', { waitingForUser: true }) }
    })
    if (result.status !== 'ok') throw new Error('expected ok')
    expect('waitingForUser' in result.state.nodes.t1).toBe(false)
  })

  it('defaults the claude status flags', () => {
    const result = migrate({
      version: 1,
      nodes: { t1: v1Terminal('t1', '2024-01-01T00:00:00Z') }
    })
    if (result.status !== 'ok') throw new Error('expected ok')

    const node = result.state.nodes.t1 as TerminalNodeData
    expect(node.claudeStatusUnread).toBe(false)
    expect(node.claudeStatusAsleep).toBe(false)
  })

  it('preserves claude status flags that were already set', () => {
    const result = migrate({
      version: 1,
      nodes: { t1: v1Terminal('t1', '2024-01-01T00:00:00Z', { claudeStatusAsleep: true }) }
    })
    if (result.status !== 'ok') throw new Error('expected ok')
    expect((result.state.nodes.t1 as TerminalNodeData).claudeStatusAsleep).toBe(true)
  })
})

describe('migration 1 → 2: sortOrder backfill', () => {
  it('assigns sortOrder in first-session order, so the crab row keeps its arrangement', () => {
    const result = migrate({
      version: 1,
      nodes: {
        c: v1Terminal('c', '2024-03-01T00:00:00Z'),
        a: v1Terminal('a', '2024-01-01T00:00:00Z'),
        b: v1Terminal('b', '2024-02-01T00:00:00Z')
      }
    })
    if (result.status !== 'ok') throw new Error('expected ok')

    const order = (id: string): number => (result.state.nodes[id] as TerminalNodeData).sortOrder
    expect(order('a')).toBeLessThan(order('b'))
    expect(order('b')).toBeLessThan(order('c'))
  })

  it('does not reuse a sortOrder already taken by another terminal', () => {
    const result = migrate({
      version: 1,
      nodes: {
        pinned: v1Terminal('pinned', '2024-01-01T00:00:00Z', { sortOrder: 5 }),
        fresh: v1Terminal('fresh', '2024-02-01T00:00:00Z')
      }
    })
    if (result.status !== 'ok') throw new Error('expected ok')

    expect((result.state.nodes.pinned as TerminalNodeData).sortOrder).toBe(5)
    expect((result.state.nodes.fresh as TerminalNodeData).sortOrder).toBe(6)
  })

  it('tolerates a terminal with no session history', () => {
    const result = migrate({
      version: 1,
      nodes: { t1: v1Terminal('t1', '2024-01-01T00:00:00Z', { terminalSessions: [] }) }
    })
    if (result.status !== 'ok') throw new Error('expected ok')
    expect(typeof (result.state.nodes.t1 as TerminalNodeData).sortOrder).toBe('number')
  })

  it('ignores non-terminal nodes', () => {
    const result = migrate({
      version: 1,
      nodes: {
        md: { id: 'md', type: 'markdown', parentId: 'root', x: 0, y: 0, zIndex: 1, content: 'hi', archivedChildren: [] }
      }
    })
    if (result.status !== 'ok') throw new Error('expected ok')
    expect('sortOrder' in result.state.nodes.md).toBe(false)
  })
})

describe('migration 1 → 2: the one-time alert wipe', () => {
  // This used to be a `// TEMPORARY:` block that wiped alerts on every single
  // boot, because without a version number there was no way to express "once".
  it('clears alerts recorded before the ~ expansion fix', () => {
    const result = migrate({
      version: 1,
      nodes: {
        t1: v1Terminal('t1', '2024-01-01T00:00:00Z', {
          alerts: [{ type: 'cwd-mismatch', message: 'bogus', timestamp: 1 }],
          alertsReadTimestamp: 123
        })
      }
    })
    if (result.status !== 'ok') throw new Error('expected ok')

    expect(result.state.nodes.t1.alerts).toBeUndefined()
    expect(result.state.nodes.t1.alertsReadTimestamp).toBeUndefined()
  })

  it('does not run again once the document is at version 2', () => {
    const migrated = migrate({ version: 1, nodes: { t1: v1Terminal('t1', '2024-01-01T00:00:00Z') } })
    if (migrated.status !== 'ok') throw new Error('expected ok')

    // A genuine alert raised after the migration.
    migrated.state.nodes.t1.alerts = [{ type: 'cwd-mismatch', message: 'real', timestamp: 9 }]

    const reloaded = migrate(migrated.state)
    if (reloaded.status !== 'ok') throw new Error('expected ok')
    expect(reloaded.state.nodes.t1.alerts).toHaveLength(1)
    expect(reloaded.migratedFrom).toBeNull()
  })
})

describe('migration is idempotent', () => {
  it('running twice produces the same document', () => {
    const original = {
      version: 1,
      nodes: {
        b: v1Terminal('b', '2024-02-01T00:00:00Z'),
        a: v1Terminal('a', '2024-01-01T00:00:00Z')
      }
    }

    const once = migrate(original)
    if (once.status !== 'ok') throw new Error('expected ok')
    const twice = migrate(once.state)
    if (twice.status !== 'ok') throw new Error('expected ok')

    expect(twice.state).toEqual(once.state)
  })
})
