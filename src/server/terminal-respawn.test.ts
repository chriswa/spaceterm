import { describe, it, expect } from 'vitest'
import { respawnTerminal, type SpawnedPty, type TerminalRespawnDeps } from './terminal-respawn'
import { asNodeId, asPtySessionId, type NodeId, type PtySessionId } from '../shared/ids'

const NODE = asNodeId('node-1')
const NEW_PTY = asPtySessionId('pty-new')

function pty(sessionId: PtySessionId = NEW_PTY, cols = 100, rows = 30): SpawnedPty {
  return { sessionId, cols, rows }
}

/**
 * Records every call in order.
 *
 * Order is the whole contract here — the six paths this replaced each wrote
 * the sequence by hand, and the two ordering constraints are invisible unless
 * something checks them.
 */
class Recorder implements TerminalRespawnDeps {
  readonly calls: string[] = []
  titles: string[] | undefined = ['old title']
  agentHistory: unknown[] = [{ claudeSessionId: 'abc' }]

  addSnapshotSession(sessionId: PtySessionId, cols: number, rows: number): void {
    this.calls.push(`addSnapshot(${sessionId},${cols},${rows})`)
  }
  seedTitleHistory(sessionId: PtySessionId, titles: string[]): void {
    this.calls.push(`seedTitles(${sessionId},[${titles.join('|')}])`)
  }
  titleHistoryOf(nodeId: NodeId): string[] | undefined {
    this.calls.push(`readTitles(${nodeId})`)
    return this.titles
  }
  agentSessionHistoryOf(nodeId: NodeId): unknown[] {
    this.calls.push(`readAgentHistory(${nodeId})`)
    return this.agentHistory
  }
  seedAgentSessionHistory(sessionId: PtySessionId, history: unknown[]): void {
    this.calls.push(`seedAgentHistory(${sessionId},${history.length})`)
  }
  rebindNode(nodeId: NodeId, sessionId: PtySessionId, cols: number, rows: number): void {
    this.calls.push(`rebind(${nodeId},${sessionId},${cols},${rows})`)
  }

  /** Index of the first call whose text contains `needle`, or -1. */
  at(needle: string): number {
    return this.calls.findIndex((c) => c.includes(needle))
  }
}

function run(configure: (r: Recorder) => void = () => {}, spawn: () => SpawnedPty = () => pty()) {
  const deps = new Recorder()
  configure(deps)
  const result = respawnTerminal(NODE, spawn, deps)
  return { deps, result }
}

describe('respawnTerminal', () => {
  it('returns the pty the spawn produced', () => {
    const { result } = run(() => {}, () => pty(asPtySessionId('pty-x'), 120, 40))
    expect(result).toEqual({ sessionId: 'pty-x', cols: 120, rows: 40 })
  })

  it('registers the snapshot session with the new pty geometry', () => {
    const { deps } = run(() => {}, () => pty(NEW_PTY, 120, 40))
    expect(deps.calls).toContain(`addSnapshot(${NEW_PTY},120,40)`)
  })

  it('rebinds the node to the new pty', () => {
    const { deps } = run(() => {}, () => pty(NEW_PTY, 120, 40))
    expect(deps.calls).toContain(`rebind(${NODE},${NEW_PTY},120,40)`)
  })

  it('carries the node’s shell titles across', () => {
    const { deps } = run((r) => { r.titles = ['npm test', 'vim'] })
    expect(deps.calls).toContain(`seedTitles(${NEW_PTY},[npm test|vim])`)
  })

  it('carries the agent session history across', () => {
    const { deps } = run((r) => { r.agentHistory = [{ a: 1 }, { b: 2 }] })
    expect(deps.calls).toContain(`seedAgentHistory(${NEW_PTY},2)`)
  })

  describe('ordering, which is the reason this is one function', () => {
    it('registers the snapshot before rebinding the node', () => {
      // Output arriving in the gap would otherwise land in no snapshot buffer.
      const { deps } = run()
      expect(deps.at('addSnapshot')).toBeLessThan(deps.at('rebind'))
    })

    it('reads and seeds shell titles before rebinding', () => {
      // rebindNode opens a new terminal session record; seeding after it files
      // the previous surface's titles under the new session.
      const { deps } = run()
      expect(deps.at('readTitles')).toBeLessThan(deps.at('rebind'))
      expect(deps.at('seedTitles')).toBeLessThan(deps.at('rebind'))
    })

    it('reads agent session history after rebinding', () => {
      // The node keeps its history across reincarnation, and this matches what
      // all six call sites did.
      const { deps } = run()
      expect(deps.at('readAgentHistory')).toBeGreaterThan(deps.at('rebind'))
    })

    it('spawns before touching anything else', () => {
      const order: string[] = []
      const deps = new Recorder()
      const spawnFirst = () => { order.push('spawn'); return pty() }
      respawnTerminal(NODE, spawnFirst, {
        ...deps,
        addSnapshotSession: () => order.push('addSnapshot'),
        titleHistoryOf: () => { order.push('readTitles'); return undefined },
        agentSessionHistoryOf: () => { order.push('readAgentHistory'); return [] },
        rebindNode: () => order.push('rebind'),
        seedTitleHistory: () => order.push('seedTitles'),
        seedAgentSessionHistory: () => order.push('seedAgentHistory')
      })
      expect(order[0]).toBe('spawn')
    })
  })

  describe('when the node has nothing to carry across', () => {
    it('does not seed empty shell titles', () => {
      const { deps } = run((r) => { r.titles = [] })
      expect(deps.at('seedTitles')).toBe(-1)
    })

    it('tolerates a node with no shell title history at all', () => {
      const { deps } = run((r) => { r.titles = undefined })
      expect(deps.at('seedTitles')).toBe(-1)
      // Everything else still happens — a titleless surface still respawns.
      expect(deps.at('rebind')).toBeGreaterThanOrEqual(0)
    })

    it('does not seed an empty agent session history', () => {
      const { deps } = run((r) => { r.agentHistory = [] })
      expect(deps.at('seedAgentHistory')).toBe(-1)
    })
  })

  it('adopts a pty the caller already has, rather than requiring a fresh one', () => {
    // Startup reattach hands over a pty the daemon still holds. Everything
    // after the spawn is identical, which is why the pty is a thunk.
    const existing = asPtySessionId('pty-from-daemon')
    const { deps, result } = run(() => {}, () => pty(existing, 80, 24))
    expect(result.sessionId).toBe(existing)
    expect(deps.calls).toContain(`rebind(${NODE},${existing},80,24)`)
  })

  it('propagates a spawn failure instead of half-rebinding the node', () => {
    // A node rebound to a pty that does not exist is worse than one that
    // stayed dead: it looks alive and swallows input.
    const deps = new Recorder()
    expect(() => respawnTerminal(NODE, () => { throw new Error('daemon down') }, deps)).toThrow('daemon down')
    expect(deps.calls).toEqual([])
  })
})
