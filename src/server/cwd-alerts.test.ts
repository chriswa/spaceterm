import { describe, it, expect } from 'vitest'
import { homedir } from 'os'
import {
  normalizeCwd,
  abbreviateCwd,
  evaluateCwdMismatch,
  scanCwdMismatches,
  scanDescendantCwdMismatches
} from './cwd-alerts'
import { asNodeId } from '../shared/ids'
import type { NodeAlert, NodeData, TerminalNodeData } from '../shared/state'

const HOME = homedir()
const NOW = 1_700_000_000_000

function terminal(
  id: string,
  parentId: string,
  overrides: Partial<TerminalNodeData> = {}
): TerminalNodeData {
  return {
    id: asNodeId(id),
    type: 'terminal',
    parentId: asNodeId(parentId),
    alive: true,
    sessionId: id,
    x: 0,
    y: 0,
    zIndex: 1,
    cols: 80,
    rows: 24,
    claudeState: 'stopped',
    claudeStatusUnread: false,
    claudeStatusAsleep: false,
    sortOrder: 0,
    terminalSessions: [],
    // An agent surface by default — a plain shell has no session history and is
    // never alerted about.
    claudeSessionHistory: [{ claudeSessionId: 'sess-1', reason: 'startup', timestamp: '' }],
    shellTitleHistory: [],
    archivedChildren: [],
    ...overrides
  } as unknown as TerminalNodeData
}

function directory(id: string, parentId: string, cwd: string): NodeData {
  return {
    id: asNodeId(id),
    type: 'directory',
    parentId: asNodeId(parentId),
    x: 0,
    y: 0,
    zIndex: 1,
    cwd,
    archivedChildren: []
  } as unknown as NodeData
}

function graph(...nodes: NodeData[]): Record<string, NodeData> {
  return Object.fromEntries(nodes.map((n) => [n.id, n]))
}

const MISMATCH: NodeAlert = { type: 'cwd-mismatch', message: 'stale', timestamp: 1 }

describe('normalizeCwd', () => {
  it('expands a bare tilde', () => {
    expect(normalizeCwd('~')).toBe(HOME)
  })

  it('expands a tilde prefix', () => {
    expect(normalizeCwd('~/project')).toBe(`${HOME}/project`)
  })

  it('strips a trailing slash', () => {
    expect(normalizeCwd('/a/b/')).toBe('/a/b')
  })

  it('leaves the root slash alone', () => {
    expect(normalizeCwd('/')).toBe('/')
  })

  it('makes a tilde path and its expansion compare equal', () => {
    // This is the whole point. Before it existed, every surface stored with a
    // `~` cwd carried a permanent false alert.
    expect(normalizeCwd('~/project')).toBe(normalizeCwd(`${HOME}/project`))
  })

  it('does not expand a tilde in the middle of a path', () => {
    expect(normalizeCwd('/a/~/b')).toBe('/a/~/b')
  })
})

describe('abbreviateCwd', () => {
  it('abbreviates the home directory', () => {
    expect(abbreviateCwd(HOME)).toBe('~')
  })

  it('abbreviates a path under home', () => {
    expect(abbreviateCwd(`${HOME}/project`)).toBe('~/project')
  })

  it('leaves an unrelated path alone', () => {
    expect(abbreviateCwd('/var/log')).toBe('/var/log')
  })

  it('does not abbreviate a sibling directory that merely shares the prefix', () => {
    expect(abbreviateCwd(`${HOME}-backup/x`)).toBe(`${HOME}-backup/x`)
  })

  it('round-trips with normalizeCwd', () => {
    expect(normalizeCwd(abbreviateCwd(`${HOME}/a/b`))).toBe(`${HOME}/a/b`)
  })
})

describe('evaluateCwdMismatch', () => {
  it('raises an alert when the surface has wandered from its ancestor', () => {
    const dir = directory('d1', 'root', '/work/app')
    const term = terminal('t1', 'd1', { cwd: '/work/other' })
    const change = evaluateCwdMismatch(graph(dir, term), term, NOW)

    expect(change?.alerts).toHaveLength(1)
    expect(change?.alerts?.[0]).toMatchObject({ type: 'cwd-mismatch', timestamp: NOW })
    expect(change?.alerts?.[0].message).toContain('/work/other')
    expect(change?.alerts?.[0].message).toContain('/work/app')
  })

  it('reports no change when the cwds agree', () => {
    const dir = directory('d1', 'root', '/work/app')
    const term = terminal('t1', 'd1', { cwd: '/work/app' })
    expect(evaluateCwdMismatch(graph(dir, term), term, NOW)).toBeNull()
  })

  it('treats a tilde cwd and its expansion as agreeing', () => {
    const dir = directory('d1', 'root', '~/app')
    const term = terminal('t1', 'd1', { cwd: `${HOME}/app` })
    expect(evaluateCwdMismatch(graph(dir, term), term, NOW)).toBeNull()
  })

  it('ignores trailing-slash differences', () => {
    const dir = directory('d1', 'root', '/work/app/')
    const term = terminal('t1', 'd1', { cwd: '/work/app' })
    expect(evaluateCwdMismatch(graph(dir, term), term, NOW)).toBeNull()
  })

  it('does not raise a second alert when one is already present', () => {
    const dir = directory('d1', 'root', '/work/app')
    const term = terminal('t1', 'd1', { cwd: '/elsewhere', alerts: [MISMATCH] })
    expect(evaluateCwdMismatch(graph(dir, term), term, NOW)).toBeNull()
  })

  it('clears the alert when the surface comes back', () => {
    const dir = directory('d1', 'root', '/work/app')
    const term = terminal('t1', 'd1', { cwd: '/work/app', alerts: [MISMATCH] })
    const change = evaluateCwdMismatch(graph(dir, term), term, NOW)

    // undefined rather than [] — an empty array would persist a meaningless key.
    expect(change).toEqual({ alerts: undefined })
  })

  it('clears only the cwd alert, leaving others intact', () => {
    const other: NodeAlert = { type: 'something-else', message: 'keep me', timestamp: 5 }
    const dir = directory('d1', 'root', '/work/app')
    const term = terminal('t1', 'd1', { cwd: '/work/app', alerts: [MISMATCH, other] })

    expect(evaluateCwdMismatch(graph(dir, term), term, NOW)).toEqual({ alerts: [other] })
  })

  it('appends to existing alerts rather than replacing them', () => {
    const other: NodeAlert = { type: 'something-else', message: 'keep me', timestamp: 5 }
    const dir = directory('d1', 'root', '/work/app')
    const term = terminal('t1', 'd1', { cwd: '/elsewhere', alerts: [other] })

    const change = evaluateCwdMismatch(graph(dir, term), term, NOW)
    expect(change?.alerts?.map((a) => a.type)).toEqual(['something-else', 'cwd-mismatch'])
  })

  it('ignores a surface that is not running an agent', () => {
    // A plain shell has no inherited-cwd contract to violate.
    const dir = directory('d1', 'root', '/work/app')
    const term = terminal('t1', 'd1', { cwd: '/elsewhere', claudeSessionHistory: [] })
    expect(evaluateCwdMismatch(graph(dir, term), term, NOW)).toBeNull()
  })

  it('leaves an existing alert alone when the ancestor cwd is unknown', () => {
    // Clearing on incomplete information would flap the alert off and on as the
    // graph is rebuilt.
    const term = terminal('t1', 'root', { cwd: '/elsewhere', alerts: [MISMATCH] })
    expect(evaluateCwdMismatch(graph(term), term, NOW)).toBeNull()
  })

  it('does nothing when the surface has no cwd of its own', () => {
    const dir = directory('d1', 'root', '/work/app')
    const term = terminal('t1', 'd1', { cwd: undefined })
    expect(evaluateCwdMismatch(graph(dir, term), term, NOW)).toBeNull()
  })

  it('compares against the nearest ancestor with a cwd, skipping ones without', () => {
    const outer = directory('d1', 'root', '/outer')
    const inner = directory('d2', 'd1', '/inner')
    const term = terminal('t1', 'd2', { cwd: '/inner' })

    expect(evaluateCwdMismatch(graph(outer, inner, term), term, NOW)).toBeNull()
  })
})

describe('scanCwdMismatches', () => {
  it('finds every terminal needing a change', () => {
    const dir = directory('d1', 'root', '/work')
    const ok = terminal('t1', 'd1', { cwd: '/work' })
    const bad = terminal('t2', 'd1', { cwd: '/elsewhere' })
    const alsoBad = terminal('t3', 'd1', { cwd: '/nowhere' })

    const changes = scanCwdMismatches(graph(dir, ok, bad, alsoBad), NOW)
    expect(changes.map((c) => c.node.id).sort()).toEqual(['t2', 't3'])
  })

  it('returns nothing when every surface agrees', () => {
    const dir = directory('d1', 'root', '/work')
    const term = terminal('t1', 'd1', { cwd: '/work' })
    expect(scanCwdMismatches(graph(dir, term), NOW)).toEqual([])
  })

  it('skips non-terminal nodes', () => {
    const dir = directory('d1', 'root', '/work')
    expect(scanCwdMismatches(graph(dir), NOW)).toEqual([])
  })
})

describe('scanDescendantCwdMismatches', () => {
  it('covers the starting node itself', () => {
    const dir = directory('d1', 'root', '/work')
    const term = terminal('t1', 'd1', { cwd: '/elsewhere' })

    const changes = scanDescendantCwdMismatches(graph(dir, term), asNodeId('t1'), NOW)
    expect(changes.map((c) => c.node.id)).toEqual(['t1'])
  })

  it('reaches terminals nested several levels down', () => {
    const outer = directory('d1', 'root', '/work')
    const title = { id: asNodeId('ti1'), type: 'title', parentId: asNodeId('d1'), x: 0, y: 0, zIndex: 1, text: 't', archivedChildren: [] } as unknown as NodeData
    const term = terminal('t1', 'ti1', { cwd: '/elsewhere' })

    const changes = scanDescendantCwdMismatches(graph(outer, title, term), asNodeId('d1'), NOW)
    expect(changes.map((c) => c.node.id)).toEqual(['t1'])
  })

  it('does not touch terminals outside the subtree', () => {
    const a = directory('d1', 'root', '/a')
    const b = directory('d2', 'root', '/b')
    const inA = terminal('t1', 'd1', { cwd: '/elsewhere' })
    const inB = terminal('t2', 'd2', { cwd: '/elsewhere' })

    const changes = scanDescendantCwdMismatches(graph(a, b, inA, inB), asNodeId('d1'), NOW)
    expect(changes.map((c) => c.node.id)).toEqual(['t1'])
  })

  it('terminates on a parent cycle instead of looping forever', () => {
    const a = terminal('t1', 't2', { cwd: '/x' })
    const b = terminal('t2', 't1', { cwd: '/y' })
    expect(() => scanDescendantCwdMismatches(graph(a, b), asNodeId('t1'), NOW)).not.toThrow()
  })

  it('tolerates an unknown starting node', () => {
    expect(scanDescendantCwdMismatches(graph(), asNodeId('ghost'), NOW)).toEqual([])
  })
})
