import { execFile } from 'child_process'
import { stat } from 'fs/promises'
import { promisify } from 'util'
import { join, resolve as pathResolve } from 'path'
import { homedir } from 'os'
import type { GitStatus, DirectoryNodeData } from '../shared/state'
import type { NodeId } from '../shared/ids'

const execFileAsync = promisify(execFile)

const POLL_INTERVAL_MS = 60_000
const EXEC_TIMEOUT_MS = 5_000

type GetDirectoryNodes = () => DirectoryNodeData[]
type OnGitStatus = (nodeId: NodeId, gitStatus: GitStatus | null) => void

/** Cancels a scheduled callback. Calling it after the callback ran is a no-op. */
export type CancelScheduled = () => void

/**
 * The three things the poller reaches outside itself: git, the filesystem, and
 * timers. Injecting them lets the dedup/caching/spreading logic be tested
 * without a repo on disk or a minute of wall-clock.
 */
export interface GitStatusPollerDeps {
  /** `git status --porcelain=v2 --branch` output for `cwd`, or null if not a repo. */
  gitStatus(cwd: string): Promise<GitStatus | null>
  scheduleInterval(fn: () => void, ms: number): CancelScheduled
  scheduleTimeout(fn: () => void, ms: number): CancelScheduled
}

export const REAL_GIT_STATUS_POLLER_DEPS: GitStatusPollerDeps = {
  gitStatus: runGitStatus,
  scheduleInterval(fn, ms) {
    const timer = setInterval(fn, ms)
    return () => clearInterval(timer)
  },
  scheduleTimeout(fn, ms) {
    const timer = setTimeout(fn, ms)
    return () => clearTimeout(timer)
  }
}

/**
 * The parts of a `GitStatus` that `git status` does not report — each one its
 * own command against the repo. Grouped so the assembly of a `GitStatus` has a
 * single shape, and so a new fact cannot be added without every construction
 * site being told about it.
 */
export interface RepoFacts {
  lastFetchTimestamp: number | null
  defaultBranch: string | null
  hasRemote: boolean
}

/** What a repo we could not interrogate beyond `git status` looks like. */
export const UNKNOWN_REPO_FACTS: RepoFacts = {
  lastFetchTimestamp: null,
  defaultBranch: null,
  hasRemote: false,
}

/** Parse `git status --porcelain=v2 --branch` output, and fold in `facts`. */
export function parseGitStatus(stdout: string, facts: RepoFacts): GitStatus {
  return { ...parsePorcelain(stdout), ...facts }
}

/** The subset of a `GitStatus` that `git status --porcelain=v2 --branch` reports. */
function parsePorcelain(stdout: string): Omit<GitStatus, keyof RepoFacts> {
  let branch: string | null = null
  let upstream: string | null = null
  let ahead = 0
  let behind = 0
  let conflicts = 0
  let staged = 0
  let unstaged = 0
  let untracked = 0

  for (const line of stdout.split('\n')) {
    if (line.startsWith('# branch.head ')) {
      const val = line.slice('# branch.head '.length)
      branch = val === '(detached)' ? null : val
    } else if (line.startsWith('# branch.upstream ')) {
      upstream = line.slice('# branch.upstream '.length)
    } else if (line.startsWith('# branch.ab ')) {
      const match = line.match(/\+(\d+) -(\d+)/)
      if (match) {
        ahead = parseInt(match[1], 10)
        behind = parseInt(match[2], 10)
      }
    } else if (line.startsWith('u ')) {
      // Unmerged (conflict) entry
      conflicts++
    } else if (line.startsWith('1 ') || line.startsWith('2 ')) {
      // Changed entry: "1 XY ..." or "2 XY ..."
      const xy = line.split(' ')[1]
      if (xy && xy.length >= 2) {
        const x = xy[0] // staged
        const y = xy[1] // unstaged
        if (x !== '.') staged++
        if (y !== '.') unstaged++
      }
    } else if (line.startsWith('? ')) {
      untracked++
    }
  }

  return { branch, upstream, ahead, behind, conflicts, staged, unstaged, untracked }
}

/**
 * Resolve a path that may start with `~`.
 */
function expandTilde(p: string): string {
  if (p.startsWith('~')) {
    return join(homedir(), p.slice(1))
  }
  return p
}

/** Runs a git command in one repo, resolving to its stdout. */
type GitRunner = (args: string[]) => Promise<string>

/**
 * Where a repo's default branch is looked for, best answer first.
 *
 * `refs/remotes/<remote>/HEAD` is the repo's own recorded answer — a symbolic
 * ref that `git clone` sets from what the server advertises, and that
 * `git remote set-head` refreshes. Everything after it is the main/master
 * convention, tried on the remote before the local branches so a checkout that
 * only has a feature branch locally still resolves.
 */
function defaultBranchRefs(remote: string): string[] {
  return [
    `refs/remotes/${remote}/HEAD`,
    `refs/remotes/${remote}/main`,
    `refs/remotes/${remote}/master`,
    'refs/heads/main',
    'refs/heads/master',
  ]
}

/**
 * A full or `:short` ref reduced to a bare branch name, or null if it does not
 * name one. Handles the three spellings `defaultBranchRefs` can yield a hit in:
 * `refs/heads/main`, `refs/remotes/origin/main`, and the `origin/main` that
 * `%(symref:short)` prints.
 */
function branchNameFromRef(ref: string, remote: string): string | null {
  for (const prefix of [`refs/remotes/${remote}/`, 'refs/heads/', `${remote}/`]) {
    if (ref.startsWith(prefix)) {
      const name = ref.slice(prefix.length)
      // A bare HEAD is the pointer, not the branch it failed to resolve to.
      return name === '' || name === 'HEAD' ? null : name
    }
  }
  return null
}

/**
 * The branch this repo treats as its default, or null if it never recorded one
 * and has no main/master to fall back on.
 *
 * One `for-each-ref` covering every candidate, rather than a command per
 * candidate: refs that do not exist are simply absent from the output, so the
 * priority order is applied here against what came back.
 */
async function readDefaultBranch(git: GitRunner, remote: string): Promise<string | null> {
  const candidates = defaultBranchRefs(remote)
  let stdout: string
  try {
    stdout = await git(['for-each-ref', '--format=%(refname)%09%(symref:short)', ...candidates])
  } catch {
    return null
  }

  const symrefByName = new Map<string, string>()
  for (const line of stdout.split('\n')) {
    if (line === '') continue
    const [refname, symref = ''] = line.split('\t')
    symrefByName.set(refname, symref)
  }

  for (const candidate of candidates) {
    const symref = symrefByName.get(candidate)
    if (symref === undefined) continue
    // `refs/remotes/<remote>/HEAD` is symbolic — its target is the answer.
    // The rest are ordinary refs, and name the branch themselves.
    const name = branchNameFromRef(symref !== '' ? symref : candidate, remote)
    if (name !== null) return name
  }
  return null
}

/** Whether the repo has any remote configured. */
async function readHasRemote(git: GitRunner): Promise<boolean> {
  try {
    return (await git(['remote'])).trim() !== ''
  } catch {
    return false
  }
}

/**
 * When this repo last fetched, from `FETCH_HEAD`'s mtime.
 *
 * Read out of `--git-common-dir` rather than `--git-dir`, so a worktree reports
 * the fetch its main checkout ran — remote-tracking refs are shared between
 * them, so a per-worktree answer would be wrong.
 */
async function readLastFetchTimestamp(git: GitRunner, resolvedCwd: string): Promise<number | null> {
  try {
    const commonDir = pathResolve(resolvedCwd, (await git(['rev-parse', '--git-common-dir'])).trim())
    return (await stat(join(commonDir, 'FETCH_HEAD'))).mtimeMs
  } catch {
    // No FETCH_HEAD: cloned and never fetched since, or not a repo at all.
    return null
  }
}

/**
 * Collect a directory's git status. Returns null if it is not a git repo.
 *
 * `git status` runs first because its upstream line names the remote the rest
 * of the questions are asked against; the three that follow are independent of
 * each other and run together.
 */
async function runGitStatus(cwd: string): Promise<GitStatus | null> {
  const resolvedCwd = expandTilde(cwd)
  const git: GitRunner = async (args) =>
    (await execFileAsync('git', args, { cwd: resolvedCwd, timeout: EXEC_TIMEOUT_MS })).stdout

  let statusOut: string
  try {
    statusOut = await git(['status', '--porcelain=v2', '--branch'])
  } catch {
    // Not a git repo, or git is not available.
    return null
  }

  const porcelain = parsePorcelain(statusOut)
  // The remote the default branch is read from: the one this branch tracks if
  // it tracks anything, else the conventional `origin`.
  const remote = porcelain.upstream?.split('/')[0] ?? 'origin'

  const [lastFetchTimestamp, defaultBranch, hasRemote] = await Promise.all([
    readLastFetchTimestamp(git, resolvedCwd),
    readDefaultBranch(git, remote),
    readHasRemote(git),
  ])

  return { ...porcelain, lastFetchTimestamp, defaultBranch, hasRemote }
}

export class GitStatusPoller {
  private cancelInterval: CancelScheduled | null = null
  /** Staggered per-cwd polls from the current cycle, cancelled on dispose. */
  private pendingPolls = new Set<CancelScheduled>()
  private cache = new Map<NodeId, string>() // nodeId → JSON.stringify(GitStatus)
  private getDirectoryNodes: GetDirectoryNodes
  private onGitStatus: OnGitStatus
  private deps: GitStatusPollerDeps

  constructor(
    getDirectoryNodes: GetDirectoryNodes,
    onGitStatus: OnGitStatus,
    deps: GitStatusPollerDeps = REAL_GIT_STATUS_POLLER_DEPS
  ) {
    this.getDirectoryNodes = getDirectoryNodes
    this.onGitStatus = onGitStatus
    this.deps = deps
    this.cancelInterval = this.deps.scheduleInterval(() => this.pollAll(), POLL_INTERVAL_MS)
    // Poll all directories immediately on startup
    this.pollAll()
  }

  removeNode(nodeId: NodeId): void {
    this.cache.delete(nodeId)
  }

  /**
   * Immediately poll a specific node (e.g. after its cwd changes).
   * Invalidates the cache so the result always fires the callback.
   */
  pollNode(nodeId: NodeId): void {
    const nodes = this.getDirectoryNodes()
    const node = nodes.find(n => n.id === nodeId)
    if (!node) return
    this.cache.delete(nodeId)
    this.deps.gitStatus(node.cwd).then((result) => {
      const json = JSON.stringify(result)
      this.cache.set(nodeId, json)
      this.onGitStatus(nodeId, result)
    }).catch(() => {
      // Ignore — will retry on next cycle
    })
  }

  dispose(): void {
    this.cancelInterval?.()
    this.cancelInterval = null
    // Staggered polls from the current cycle would otherwise keep firing —
    // and keep the process alive — for up to a full poll interval after
    // dispose. Same shape as the DaemonClient reconnect-after-dispose bug.
    for (const cancel of this.pendingPolls) cancel()
    this.pendingPolls.clear()
  }

  private pollAll(): void {
    const nodes = this.getDirectoryNodes()
    if (nodes.length === 0) return

    // Group node IDs by resolved cwd to deduplicate
    const cwdToNodeIds = new Map<string, NodeId[]>()
    for (const node of nodes) {
      const resolved = expandTilde(node.cwd)
      const existing = cwdToNodeIds.get(resolved)
      if (existing) {
        existing.push(node.id)
      } else {
        cwdToNodeIds.set(resolved, [node.id])
      }
    }

    const uniqueCwds = [...cwdToNodeIds.entries()]
    // Spread checks evenly across the poll interval
    const spacing = uniqueCwds.length > 1
      ? POLL_INTERVAL_MS / uniqueCwds.length
      : 0

    for (let i = 0; i < uniqueCwds.length; i++) {
      const [cwd, nodeIds] = uniqueCwds[i]
      // Holder rather than a `let` the callback closes over before assignment.
      const handle: { cancel?: CancelScheduled } = {}
      handle.cancel = this.deps.scheduleTimeout(() => {
        if (handle.cancel) this.pendingPolls.delete(handle.cancel)
        this.deps.gitStatus(cwd).then((result) => {
          const json = JSON.stringify(result)
          for (const nodeId of nodeIds) {
            if (json !== this.cache.get(nodeId)) {
              this.cache.set(nodeId, json)
              this.onGitStatus(nodeId, result)
            }
          }
        }).catch(() => { /* retry next cycle */ })
      }, i * spacing)
      this.pendingPolls.add(handle.cancel)
    }
  }
}
