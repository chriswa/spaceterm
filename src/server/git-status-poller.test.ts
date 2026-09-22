import { describe, it, expect } from 'vitest'
import {
  GitStatusPoller,
  SWEEP_INTERVAL_MS,
  METADATA_INTERVAL_MS,
  MIN_POLL_INTERVAL_MS,
  WATCH_SETTLE_MS,
  type GitStatusPollerDeps,
  type CancelScheduled
} from './git-status-poller'
import { asNodeId } from '../shared/ids'
import type { NodeId } from '../shared/ids'
import type { DirectoryNodeData, GitStatus } from '../shared/state'

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
    defaultBranch: 'main',
    upstream: null,
    hasRemote: false,
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

/** Manually-advanced timers, so a poll cycle costs no wall-clock. */
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
  /** cwds a full `git status` was run for, in order. */
  statusCalls: string[]
  /** cwds whose `.git` mtimes were checked, in order. */
  metadataChecks: string[]
  updates: Array<{ nodeId: NodeId; gitStatus: GitStatus | null }>
  setNodes(nodes: DirectoryNodeData[]): void
  /** Say that this cwd's `.git` metadata has moved, until its next status. */
  markMoved(cwd: string): void
  /** Report a filesystem change under this cwd, as the watcher would. */
  fileChanged(cwd: string): void
  /** The directories the watcher was last told to watch. */
  watched(): string[]
  resets: string[]
  /** Let the promise chain inside a poll settle. */
  settle(): Promise<void>
}

function harness(options: {
  nodes?: DirectoryNodeData[]
  gitStatus?: (cwd: string) => GitStatus | null | Promise<GitStatus | null>
} = {}): Harness {
  const clock = new FakeClock()
  const statusCalls: string[] = []
  const metadataChecks: string[] = []
  const resets: string[] = []
  const moved = new Set<string>()
  const updates: Harness['updates'] = []
  let nodes = options.nodes ?? []
  let watched: string[] = []
  let notifyChange: (cwd: string) => void = () => {}

  const deps: GitStatusPollerDeps = {
    createProbe: (cwd) => ({
      status: async () => {
        statusCalls.push(cwd)
        moved.delete(cwd)
        return options.gitStatus ? options.gitStatus(cwd) : status()
      },
      metadataMoved: async () => {
        metadataChecks.push(cwd)
        return moved.has(cwd)
      },
      reset: () => { resets.push(cwd) },
    }),
    createWatcher: (onChange) => {
      notifyChange = onChange
      return {
        sync: (dirs) => { watched = [...dirs] },
        dispose: () => { watched = [] },
      }
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
    statusCalls,
    metadataChecks,
    resets,
    updates,
    setNodes: (next) => { nodes = next },
    markMoved: (cwd) => { moved.add(cwd) },
    fileChanged: (cwd) => notifyChange(cwd),
    watched: () => watched,
    settle: async () => { for (let i = 0; i < 10; i++) await Promise.resolve() }
  }
}

/**
 * Advance the clock in small steps, letting each poll land before the next
 * timer fires — `advance` is synchronous, so a single large jump would run
 * every timer while the first `git status` was still pending.
 */
async function tick(h: Harness, ms: number, step = 50): Promise<void> {
  for (let t = 0; t < ms; t += step) {
    h.clock.advance(step)
    await h.settle()
  }
}

describe('startup', () => {
  it('polls immediately rather than waiting a full interval', async () => {
    const h = harness({ nodes: [dir('d1', '/repo')] })
    h.clock.advance(0)
    await h.settle()

    expect(h.statusCalls).toEqual(['/repo'])
    expect(h.updates).toEqual([{ nodeId: 'd1', gitStatus: status() }])
  })

  it('does nothing when there are no directory nodes', async () => {
    const h = harness({ nodes: [] })
    h.clock.advance(SWEEP_INTERVAL_MS)
    await h.settle()

    expect(h.statusCalls).toEqual([])
    expect(h.updates).toEqual([])
  })
})

describe('deduplication', () => {
  it('runs git once per cwd, however many nodes point at it', async () => {
    const h = harness({
      nodes: [dir('d1', '/repo'), dir('d2', '/repo'), dir('d3', '/other')]
    })
    // Just short of the next sweep: every staggered poll of this one has run.
    h.clock.advance(SWEEP_INTERVAL_MS - 1)
    await h.settle()

    expect(h.statusCalls.filter((c) => c === '/repo')).toHaveLength(1)
    expect(h.statusCalls.filter((c) => c === '/other')).toHaveLength(1)
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

    expect(h.statusCalls).toHaveLength(1)
  })
})

describe('change detection', () => {
  it('does not re-notify when the status is unchanged', async () => {
    const h = harness({ nodes: [dir('d1', '/repo')] })
    h.clock.advance(0)
    await h.settle()
    expect(h.updates).toHaveLength(1)

    h.clock.advance(SWEEP_INTERVAL_MS)
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
    h.clock.advance(SWEEP_INTERVAL_MS)
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
    h.clock.advance(SWEEP_INTERVAL_MS)
    await h.settle()
    expect(h.statusCalls.length).toBeGreaterThan(1)
  })

  it('answers a node added while git was still running', async () => {
    let release: (s: GitStatus) => void = () => {}
    const h = harness({
      nodes: [dir('d1', '/repo')],
      gitStatus: () => new Promise<GitStatus>((resolve) => { release = resolve })
    })
    h.clock.advance(0)
    await h.settle()

    h.setNodes([dir('d1', '/repo'), dir('d2', '/repo')])
    release(status())
    await h.settle()

    expect(h.updates.map((u) => u.nodeId).sort()).toEqual(['d1', 'd2'])
  })
})

describe('metadata watch', () => {
  it('checks the .git mtimes far more often than it runs git', async () => {
    const h = harness({ nodes: [dir('d1', '/repo')] })
    h.clock.advance(0)
    await h.settle()
    h.statusCalls.length = 0
    h.metadataChecks.length = 0

    await tick(h, SWEEP_INTERVAL_MS, METADATA_INTERVAL_MS)

    expect(h.metadataChecks).toHaveLength(SWEEP_INTERVAL_MS / METADATA_INTERVAL_MS)
    expect(h.statusCalls).toHaveLength(1)
  })

  it('polls about a second after the repo moves', async () => {
    let branch = 'main'
    const h = harness({ nodes: [dir('d1', '/repo')], gitStatus: () => status({ branch }) })
    h.clock.advance(0)
    await h.settle()

    branch = 'feature'
    h.markMoved('/repo')
    await tick(h, METADATA_INTERVAL_MS + MIN_POLL_INTERVAL_MS + WATCH_SETTLE_MS)

    expect(h.updates.map((u) => u.gitStatus?.branch)).toEqual(['main', 'feature'])
  })

  it('does not run git when nothing under .git moved', async () => {
    const h = harness({ nodes: [dir('d1', '/repo')] })
    h.clock.advance(0)
    await h.settle()
    h.statusCalls.length = 0

    h.clock.advance(METADATA_INTERVAL_MS * 4)
    await h.settle()

    expect(h.statusCalls).toEqual([])
  })
})

describe('filesystem watch', () => {
  it('watches every directory on the canvas', async () => {
    const h = harness({ nodes: [dir('d1', '/repo'), dir('d2', '/other'), dir('d3', '/repo')] })
    h.clock.advance(0)
    await h.settle()

    expect(h.watched().sort()).toEqual(['/other', '/repo'])
  })

  it('stops watching a directory that has left the canvas', async () => {
    const h = harness({ nodes: [dir('d1', '/repo'), dir('d2', '/other')] })
    h.clock.advance(0)
    await h.settle()

    h.setNodes([dir('d1', '/repo')])
    await tick(h, SWEEP_INTERVAL_MS)

    expect(h.watched()).toEqual(['/repo'])
  })

  it('polls once the event burst has settled', async () => {
    let branch = 'main'
    const h = harness({ nodes: [dir('d1', '/repo')], gitStatus: () => status({ branch }) })
    await tick(h, MIN_POLL_INTERVAL_MS)
    h.statusCalls.length = 0

    branch = 'feature'
    h.fileChanged('/repo')
    await tick(h, WATCH_SETTLE_MS * 2)

    expect(h.statusCalls).toEqual(['/repo'])
    expect(h.updates.map((u) => u.gitStatus?.branch)).toEqual(['main', 'feature'])
  })

  it('collapses a burst of events into one status', async () => {
    const h = harness({ nodes: [dir('d1', '/repo')] })
    await tick(h, MIN_POLL_INTERVAL_MS)
    h.statusCalls.length = 0

    for (let i = 0; i < 50; i++) h.fileChanged('/repo')
    await tick(h, WATCH_SETTLE_MS * 2)

    expect(h.statusCalls).toEqual(['/repo'])
  })

  it('runs git at most once per repo per minimum interval, however hard files churn', async () => {
    const h = harness({ nodes: [dir('d1', '/repo')] })
    await tick(h, MIN_POLL_INTERVAL_MS)
    h.statusCalls.length = 0

    // A build writing into the tree for ten seconds.
    const CHURN_MS = 10 * MIN_POLL_INTERVAL_MS
    for (let t = 0; t < CHURN_MS; t += 25) {
      h.fileChanged('/repo')
      h.clock.advance(25)
      await h.settle()
    }

    const allowed = CHURN_MS / MIN_POLL_INTERVAL_MS
    // Throttled, not silenced: roughly one poll per second of churn, not one
    // per event and not one for the whole burst.
    expect(h.statusCalls.length).toBeLessThanOrEqual(allowed + 1)
    expect(h.statusCalls.length).toBeGreaterThanOrEqual(allowed - 1)
  })

  it('does not lose a change that arrived during the cooldown', async () => {
    let branch = 'main'
    const h = harness({ nodes: [dir('d1', '/repo')], gitStatus: () => status({ branch }) })
    await tick(h, MIN_POLL_INTERVAL_MS)
    h.statusCalls.length = 0

    h.fileChanged('/repo')
    await tick(h, WATCH_SETTLE_MS * 2)
    // Second change lands while the repo is still held off.
    branch = 'feature'
    h.fileChanged('/repo')
    await tick(h, MIN_POLL_INTERVAL_MS * 2)

    expect(h.updates.map((u) => u.gitStatus?.branch)).toEqual(['main', 'feature'])
  })

  it('leaves other repos alone', async () => {
    const h = harness({ nodes: [dir('d1', '/repo'), dir('d2', '/other')] })
    await tick(h, MIN_POLL_INTERVAL_MS)
    h.statusCalls.length = 0

    h.fileChanged('/repo')
    await tick(h, WATCH_SETTLE_MS * 2)

    expect(h.statusCalls).toEqual(['/repo'])
  })
})

describe('overlapping polls', () => {
  it('does not start a second git while one is still running', async () => {
    const releases: Array<(s: GitStatus) => void> = []
    const h = harness({
      nodes: [dir('d1', '/repo')],
      gitStatus: () => new Promise<GitStatus>((resolve) => releases.push(resolve))
    })
    h.clock.advance(0)
    await h.settle()
    expect(releases).toHaveLength(1)

    // Four metadata ticks and a sweep, all while the first status hangs.
    h.markMoved('/repo')
    h.clock.advance(SWEEP_INTERVAL_MS)
    await h.settle()

    expect(releases).toHaveLength(1)
  })

  it('runs the poll it had to defer once the slow one lands', async () => {
    const releases: Array<(s: GitStatus) => void> = []
    const h = harness({
      nodes: [dir('d1', '/repo')],
      gitStatus: () => new Promise<GitStatus>((resolve) => releases.push(resolve))
    })
    h.clock.advance(0)
    await h.settle()

    h.clock.advance(SWEEP_INTERVAL_MS)
    await h.settle()
    releases[0](status())
    await h.settle()

    expect(releases).toHaveLength(2)
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

  it('discards the probe cache, which described the old directory', async () => {
    const h = harness({ nodes: [dir('d1', '/repo')] })
    h.clock.advance(0)
    await h.settle()

    h.poller.pollNode(asNodeId('d1'))
    await h.settle()

    expect(h.resets).toEqual(['/repo'])
  })

  it('jumps the throttle, however recently the repo was polled', async () => {
    const h = harness({ nodes: [dir('d1', '/repo')] })
    h.clock.advance(0)
    await h.settle()
    h.statusCalls.length = 0

    // Still inside the cooldown from the startup poll.
    h.poller.pollNode(asNodeId('d1'))
    await h.settle()

    expect(h.statusCalls).toEqual(['/repo'])
  })

  it('ignores an unknown node', async () => {
    const h = harness({ nodes: [dir('d1', '/repo')] })
    h.statusCalls.length = 0

    h.poller.pollNode(asNodeId('nope'))
    await h.settle()

    expect(h.statusCalls).toEqual([])
  })
})

describe('removeNode', () => {
  it('drops the cached status so the node reports again when it returns', async () => {
    const h = harness({ nodes: [dir('d1', '/repo')] })
    h.clock.advance(0)
    await h.settle()

    h.poller.removeNode(asNodeId('d1'))
    h.clock.advance(SWEEP_INTERVAL_MS)
    await h.settle()

    expect(h.updates).toHaveLength(2)
  })
})

describe('dispose', () => {
  it('stops the poll cycle', async () => {
    const h = harness({ nodes: [dir('d1', '/repo')] })
    h.clock.advance(0)
    await h.settle()
    h.statusCalls.length = 0

    h.poller.dispose()
    h.clock.advance(SWEEP_INTERVAL_MS * 3)
    await h.settle()

    expect(h.statusCalls).toEqual([])
  })

  it('cancels staggered polls already queued from the current sweep', async () => {
    // Same shape as the DaemonClient reconnect-after-dispose bug: without this,
    // work scheduled before dispose keeps firing — and keeps the process alive
    // — for up to a full sweep interval afterwards.
    const h = harness({
      nodes: [dir('d1', '/a'), dir('d2', '/b'), dir('d3', '/c'), dir('d4', '/d')]
    })
    h.statusCalls.length = 0

    h.poller.dispose()
    h.clock.advance(SWEEP_INTERVAL_MS)
    await h.settle()

    expect(h.statusCalls).toEqual([])
    expect(h.clock.armed).toBe(0)
  })

  it('stops watching the filesystem', async () => {
    const h = harness({ nodes: [dir('d1', '/repo')] })
    h.clock.advance(0)
    await h.settle()

    h.poller.dispose()

    expect(h.watched()).toEqual([])
  })

  it('ignores a filesystem event that arrives after dispose', async () => {
    const h = harness({ nodes: [dir('d1', '/repo')] })
    h.clock.advance(0)
    await h.settle()
    h.statusCalls.length = 0

    h.poller.dispose()
    h.fileChanged('/repo')
    await tick(h, MIN_POLL_INTERVAL_MS * 2)

    expect(h.statusCalls).toEqual([])
  })
})
