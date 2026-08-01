import { describe, it, expect } from 'vitest'
import {
  GitStatusPoller,
  parseGitStatus,
  type GitStatusPollerDeps,
  type CancelScheduled
} from './git-status-poller'
import { asNodeId } from '../shared/ids'
import type { NodeId } from '../shared/ids'
import type { DirectoryNodeData, GitStatus } from '../shared/state'

const POLL_INTERVAL_MS = 60_000

function dir(id: string, cwd: string): DirectoryNodeData {
  return {
    id: asNodeId(id),
    type: 'directory',
    parentId: asNodeId('root'),
    x: 0,
    y: 0,
    zIndex: 1,
    cwd,
    archivedChildren: []
  } as DirectoryNodeData
}

function status(overrides: Partial<GitStatus> = {}): GitStatus {
  return {
    branch: 'main',
    upstream: null,
    ahead: 0,
    behind: 0,
    conflicts: 0,
    staged: 0,
    unstaged: 0,
    untracked: 0,
    lastFetchTimestamp: null,
    ...overrides
  }
}

/** Manually-advanced timers, so a 60s poll cycle costs no wall-clock. */
class FakeClock {
  private pending: Array<{ fn: () => void; dueAt: number; repeatMs?: number; cancelled: boolean }> = []
  private now = 0

  interval(fn: () => void, ms: number): CancelScheduled {
    const entry = { fn, dueAt: this.now + ms, repeatMs: ms, cancelled: false }
    this.pending.push(entry)
    return () => { entry.cancelled = true }
  }

  timeout(fn: () => void, ms: number): CancelScheduled {
    const entry = { fn, dueAt: this.now + ms, cancelled: false }
    this.pending.push(entry)
    return () => { entry.cancelled = true }
  }

  advance(ms: number): void {
    const target = this.now + ms
    // Fire in due order so a callback that schedules more work is handled.
    for (;;) {
      const next = this.pending
        .filter((p) => !p.cancelled && p.dueAt <= target)
        .sort((a, b) => a.dueAt - b.dueAt)[0]
      if (!next) break
      this.now = next.dueAt
      if (next.repeatMs === undefined) {
        this.pending = this.pending.filter((p) => p !== next)
      } else {
        next.dueAt += next.repeatMs
      }
      next.fn()
    }
    this.now = target
  }

  get armed(): number {
    return this.pending.filter((p) => !p.cancelled).length
  }
}

interface Harness {
  poller: GitStatusPoller
  clock: FakeClock
  /** cwds passed to git, in order. */
  gitCalls: string[]
  updates: Array<{ nodeId: NodeId; gitStatus: GitStatus | null }>
  setNodes(nodes: DirectoryNodeData[]): void
  /** Let the promise chain inside a poll settle. */
  settle(): Promise<void>
}

function harness(options: {
  nodes?: DirectoryNodeData[]
  gitStatus?: (cwd: string) => GitStatus | null | Promise<GitStatus | null>
} = {}): Harness {
  const clock = new FakeClock()
  const gitCalls: string[] = []
  const updates: Harness['updates'] = []
  let nodes = options.nodes ?? []

  const deps: GitStatusPollerDeps = {
    gitStatus: async (cwd) => {
      gitCalls.push(cwd)
      return options.gitStatus ? options.gitStatus(cwd) : status()
    },
    scheduleInterval: (fn, ms) => clock.interval(fn, ms),
    scheduleTimeout: (fn, ms) => clock.timeout(fn, ms)
  }

  const poller = new GitStatusPoller(
    () => nodes,
    (nodeId, gitStatus) => updates.push({ nodeId, gitStatus }),
    deps
  )

  return {
    poller,
    clock,
    gitCalls,
    updates,
    setNodes: (next) => { nodes = next },
    settle: async () => { for (let i = 0; i < 5; i++) await Promise.resolve() }
  }
}

describe('startup', () => {
  it('polls immediately rather than waiting a full interval', async () => {
    const h = harness({ nodes: [dir('d1', '/repo')] })
    h.clock.advance(0)
    await h.settle()

    expect(h.gitCalls).toEqual(['/repo'])
    expect(h.updates).toEqual([{ nodeId: 'd1', gitStatus: status() }])
  })

  it('does nothing when there are no directory nodes', async () => {
    const h = harness({ nodes: [] })
    h.clock.advance(POLL_INTERVAL_MS)
    await h.settle()

    expect(h.gitCalls).toEqual([])
    expect(h.updates).toEqual([])
  })
})

describe('deduplication', () => {
  it('runs git once per cwd, however many nodes point at it', async () => {
    const h = harness({
      nodes: [dir('d1', '/repo'), dir('d2', '/repo'), dir('d3', '/other')]
    })
    // Just short of the next cycle: every staggered poll of this cycle has run.
    h.clock.advance(POLL_INTERVAL_MS - 1)
    await h.settle()

    expect(h.gitCalls.filter((c) => c === '/repo')).toHaveLength(1)
    expect(h.gitCalls.filter((c) => c === '/other')).toHaveLength(1)
  })

  it('still notifies every node sharing that cwd', async () => {
    const h = harness({ nodes: [dir('d1', '/repo'), dir('d2', '/repo')] })
    h.clock.advance(0)
    await h.settle()

    expect(h.updates.map((u) => u.nodeId).sort()).toEqual(['d1', 'd2'])
  })

  it('treats ~ and its expansion as the same repository', async () => {
    const h = harness({ nodes: [dir('d1', '~'), dir('d2', process.env.HOME ?? '~')] })
    h.clock.advance(0)
    await h.settle()

    expect(h.gitCalls).toHaveLength(1)
  })
})

describe('change detection', () => {
  it('does not re-notify when the status is unchanged', async () => {
    const h = harness({ nodes: [dir('d1', '/repo')] })
    h.clock.advance(0)
    await h.settle()
    expect(h.updates).toHaveLength(1)

    h.clock.advance(POLL_INTERVAL_MS)
    await h.settle()
    expect(h.updates).toHaveLength(1)
  })

  it('notifies when the status changes', async () => {
    let branch = 'main'
    const h = harness({
      nodes: [dir('d1', '/repo')],
      gitStatus: () => status({ branch })
    })
    h.clock.advance(0)
    await h.settle()

    branch = 'feature'
    h.clock.advance(POLL_INTERVAL_MS)
    await h.settle()

    expect(h.updates.map((u) => u.gitStatus?.branch)).toEqual(['main', 'feature'])
  })

  it('reports null for a directory that is not a git repo', async () => {
    const h = harness({ nodes: [dir('d1', '/not-a-repo')], gitStatus: () => null })
    h.clock.advance(0)
    await h.settle()

    expect(h.updates).toEqual([{ nodeId: 'd1', gitStatus: null }])
  })

  it('survives a git invocation that rejects', async () => {
    const h = harness({
      nodes: [dir('d1', '/repo')],
      gitStatus: () => Promise.reject(new Error('git exploded'))
    })
    h.clock.advance(0)
    await h.settle()

    expect(h.updates).toEqual([])
    // And the cycle keeps running.
    h.clock.advance(POLL_INTERVAL_MS)
    await h.settle()
    expect(h.gitCalls.length).toBeGreaterThan(1)
  })
})

describe('pollNode', () => {
  it('fires the callback even when the status has not changed', async () => {
    const h = harness({ nodes: [dir('d1', '/repo')] })
    h.clock.advance(0)
    await h.settle()
    expect(h.updates).toHaveLength(1)

    h.poller.pollNode(asNodeId('d1'))
    await h.settle()

    // The cwd may have changed under it, so a cached-equal result still matters.
    expect(h.updates).toHaveLength(2)
  })

  it('ignores an unknown node', async () => {
    const h = harness({ nodes: [dir('d1', '/repo')] })
    h.gitCalls.length = 0

    h.poller.pollNode(asNodeId('nope'))
    await h.settle()

    expect(h.gitCalls).toEqual([])
  })
})

describe('removeNode', () => {
  it('drops the cached status so the node reports again when it returns', async () => {
    const h = harness({ nodes: [dir('d1', '/repo')] })
    h.clock.advance(0)
    await h.settle()

    h.poller.removeNode(asNodeId('d1'))
    h.clock.advance(POLL_INTERVAL_MS)
    await h.settle()

    expect(h.updates).toHaveLength(2)
  })
})

describe('dispose', () => {
  it('stops the poll cycle', async () => {
    const h = harness({ nodes: [dir('d1', '/repo')] })
    h.clock.advance(0)
    await h.settle()
    h.gitCalls.length = 0

    h.poller.dispose()
    h.clock.advance(POLL_INTERVAL_MS * 3)
    await h.settle()

    expect(h.gitCalls).toEqual([])
  })

  it('cancels staggered polls already queued from the current cycle', async () => {
    // Same shape as the DaemonClient reconnect-after-dispose bug: without this,
    // work scheduled before dispose keeps firing — and keeps the process alive
    // — for up to a full poll interval afterwards.
    const h = harness({
      nodes: [dir('d1', '/a'), dir('d2', '/b'), dir('d3', '/c'), dir('d4', '/d')]
    })
    h.gitCalls.length = 0

    h.poller.dispose()
    h.clock.advance(POLL_INTERVAL_MS)
    await h.settle()

    expect(h.gitCalls).toEqual([])
    expect(h.clock.armed).toBe(0)
  })
})

describe('parseGitStatus', () => {
  it('reads the branch and upstream', () => {
    const out = ['# branch.head main', '# branch.upstream origin/main'].join('\n')
    expect(parseGitStatus(out, null)).toMatchObject({ branch: 'main', upstream: 'origin/main' })
  })

  it('reports a detached HEAD as no branch', () => {
    expect(parseGitStatus('# branch.head (detached)', null).branch).toBeNull()
  })

  it('reads ahead/behind counts', () => {
    expect(parseGitStatus('# branch.ab +3 -5', null)).toMatchObject({ ahead: 3, behind: 5 })
  })

  it('counts staged and unstaged changes from the XY field', () => {
    const out = [
      '1 M. N... 100644 100644 100644 aaa bbb staged-only.ts',
      '1 .M N... 100644 100644 100644 aaa bbb unstaged-only.ts',
      '1 MM N... 100644 100644 100644 aaa bbb both.ts'
    ].join('\n')

    expect(parseGitStatus(out, null)).toMatchObject({ staged: 2, unstaged: 2 })
  })

  it('counts renames, which use the 2 prefix', () => {
    expect(parseGitStatus('2 R. N... 100644 100644 100644 aaa bbb R100 new.ts\told.ts', null))
      .toMatchObject({ staged: 1 })
  })

  it('counts conflicts and untracked files', () => {
    const out = ['u UU N... 100644 100644 100644 100644 a b c d conflicted.ts', '? new-file.ts'].join('\n')
    expect(parseGitStatus(out, null)).toMatchObject({ conflicts: 1, untracked: 1 })
  })

  it('carries the FETCH_HEAD timestamp through', () => {
    expect(parseGitStatus('# branch.head main', 1_700_000_000_000).lastFetchTimestamp).toBe(1_700_000_000_000)
  })

  it('returns a clean status for empty output', () => {
    expect(parseGitStatus('', null)).toEqual(status({ branch: null }))
  })
})
