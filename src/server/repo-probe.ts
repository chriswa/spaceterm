import { execFile } from 'child_process'
import { stat } from 'fs/promises'
import { promisify } from 'util'
import { join, resolve as pathResolve } from 'path'
import { homedir } from 'os'
import type { GitStatus } from '../shared/state'

const execFileAsync = promisify(execFile)

const EXEC_TIMEOUT_MS = 5_000

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
export type Porcelain = Omit<GitStatus, keyof RepoFacts>

/** The subset of a `GitStatus` that `git status --porcelain=v2 --branch` reports. */
export function parsePorcelain(stdout: string): Porcelain {
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

/** Resolve a path that may start with `~`. */
export function expandTilde(p: string): string {
  if (p.startsWith('~')) {
    return join(homedir(), p.slice(1))
  }
  return p
}

/**
 * The two things a probe reaches outside itself: git, and file mtimes.
 * Injecting them lets the caching and fingerprinting be tested against a
 * scripted repo instead of one on disk.
 */
export interface RepoProbeDeps {
  /** Run git in `cwd`, resolving to stdout. Rejects if git does. */
  git(cwd: string, args: string[]): Promise<string>
  /** A path's modification time in ms, or null if it does not exist. */
  mtimeMs(path: string): Promise<number | null>
}

export const REAL_REPO_PROBE_DEPS: RepoProbeDeps = {
  async git(cwd, args) {
    return (await execFileAsync('git', args, { cwd, timeout: EXEC_TIMEOUT_MS })).stdout
  },
  async mtimeMs(path) {
    try {
      return (await stat(path)).mtimeMs
    } catch {
      return null
    }
  },
}

/** Runs a git command in one repo, resolving to its stdout. */
type GitRunner = (args: string[]) => Promise<string>

/**
 * Where a repo's git metadata lives. The two differ for a linked worktree:
 * `gitDir` is that worktree's own directory, `commonDir` the one it shares with
 * the main checkout. Remote-tracking refs, config and fetch state live in the
 * shared one; HEAD, the index and the HEAD reflog are per-worktree.
 */
interface GitDirs {
  gitDir: string
  commonDir: string
}

/**
 * Per-worktree metadata whose mtime moves when HEAD, the index, or the HEAD
 * reflog does — a branch switch, a commit, a stage, a reset.
 */
const PER_WORKTREE_METADATA = ['HEAD', 'index', 'logs/HEAD']

/**
 * Shared metadata whose mtime moves when refs, remotes or fetch state do.
 *
 * The two `refs/` entries are directories: their mtime moves when a ref is
 * created or deleted, not when an existing one is rewritten in place. That gap
 * is covered by `logs/HEAD` for local movement and `FETCH_HEAD` for fetches,
 * and in any case the fingerprint only decides how *soon* a change is noticed —
 * the periodic sweep re-reads everything regardless.
 */
const SHARED_METADATA = ['packed-refs', 'FETCH_HEAD', 'config', 'refs/heads', 'refs/remotes']

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
 * One repository, interrogated repeatedly.
 *
 * Holding this per cwd rather than re-deriving it every poll is what makes a
 * frequent cadence affordable: the git directory layout is resolved once, and
 * the three seldom-changing `RepoFacts` are re-read only when the repo's
 * metadata mtimes say something moved. A routine poll of an idle repo is a
 * single `git status` plus a handful of `stat` calls.
 */
export class RepoProbe {
  private readonly cwd: string
  private readonly deps: RepoProbeDeps
  private readonly git: GitRunner

  private dirs: GitDirs | null = null
  /** The metadata fingerprint as of the last completed `status()`. */
  private lastFingerprint: string | null = null
  private facts: RepoFacts | null = null
  /** The remote `facts` was read against — a different one invalidates them. */
  private factsRemote: string | null = null
  /** False once `git status` has told us this directory is not a repository. */
  private isRepo = true

  constructor(cwd: string, deps: RepoProbeDeps = REAL_REPO_PROBE_DEPS) {
    this.cwd = expandTilde(cwd)
    this.deps = deps
    this.git = (args) => this.deps.git(this.cwd, args)
  }

  /**
   * Whether the repo's git metadata moved since the last `status()` — a branch
   * switch, commit, stage or fetch. Stat calls only, no subprocess, so this is
   * cheap enough to ask about every second.
   *
   * It says nothing about the working tree: editing a tracked file or adding an
   * untracked one touches nothing under `.git`, so those changes are found by
   * the periodic sweep instead. A `false` here means "no cheap evidence of a
   * change", not "nothing changed".
   */
  async metadataMoved(): Promise<boolean> {
    if (!this.isRepo) return false
    const fingerprint = await this.fingerprint()
    if (fingerprint === null) return false
    return fingerprint !== this.lastFingerprint
  }

  /**
   * Collect this repo's status, or null if it is not a git repository.
   *
   * `git status` runs first because its upstream line names the remote the
   * facts are read against. It runs with `--no-optional-locks` so it never
   * takes `.git/index.lock` to save its refreshed stat cache — that write is
   * worth nothing to a poller, and while it is held a concurrent `git add` or
   * `git commit` in a terminal fails outright.
   */
  async status(): Promise<GitStatus | null> {
    let statusOut: string
    try {
      statusOut = await this.git(['--no-optional-locks', 'status', '--porcelain=v2', '--branch'])
    } catch {
      // Not a git repo, or git is not available.
      this.isRepo = false
      this.reset()
      return null
    }
    this.isRepo = true

    const porcelain = parsePorcelain(statusOut)
    // The remote the facts are read against: the one this branch tracks if it
    // tracks anything, else the conventional `origin`.
    const remote = porcelain.upstream?.split('/')[0] ?? 'origin'

    const fingerprint = await this.fingerprint()
    if (this.facts === null || remote !== this.factsRemote || fingerprint !== this.lastFingerprint) {
      this.facts = await this.readFacts(remote)
      this.factsRemote = remote
    }
    this.lastFingerprint = fingerprint

    return { ...porcelain, ...this.facts }
  }

  /** Drop every cached answer, so the next `status()` re-reads the repo whole. */
  reset(): void {
    this.dirs = null
    this.lastFingerprint = null
    this.facts = null
    this.factsRemote = null
    this.isRepo = true
  }

  /**
   * A digest of the mtimes of the repo metadata worth watching, or null if the
   * git directory layout could not be resolved.
   */
  private async fingerprint(): Promise<string | null> {
    const dirs = await this.gitDirs()
    if (dirs === null) return null

    const paths = [
      ...PER_WORKTREE_METADATA.map((p) => join(dirs.gitDir, p)),
      ...SHARED_METADATA.map((p) => join(dirs.commonDir, p)),
    ]
    const mtimes = await Promise.all(paths.map((p) => this.deps.mtimeMs(p)))
    return mtimes.join(',')
  }

  /**
   * Where this repo keeps its metadata, resolved once and remembered.
   *
   * Left uncached on failure so a directory that later becomes a repository —
   * `git init`, or a checkout that had not been cloned yet — is picked up by
   * the next sweep rather than being written off permanently.
   */
  private async gitDirs(): Promise<GitDirs | null> {
    if (this.dirs !== null) return this.dirs
    try {
      const [gitDir, commonDir] = (await this.git(['rev-parse', '--git-dir', '--git-common-dir']))
        .trim()
        .split('\n')
      if (!gitDir || !commonDir) return null
      this.dirs = {
        gitDir: pathResolve(this.cwd, gitDir),
        commonDir: pathResolve(this.cwd, commonDir),
      }
      return this.dirs
    } catch {
      return null
    }
  }

  /**
   * The three facts `git status` does not report. Independent of each other, so
   * they run together.
   *
   * `lastFetchTimestamp` comes from the shared git directory rather than this
   * worktree's, so a linked worktree reports the fetch its main checkout ran —
   * remote-tracking refs are shared between them, so a per-worktree answer
   * would be wrong.
   */
  private async readFacts(remote: string): Promise<RepoFacts> {
    const dirs = await this.gitDirs()
    const [lastFetchTimestamp, defaultBranch, hasRemote] = await Promise.all([
      dirs === null ? Promise.resolve(null) : this.deps.mtimeMs(join(dirs.commonDir, 'FETCH_HEAD')),
      readDefaultBranch(this.git, remote),
      readHasRemote(this.git),
    ])
    return { lastFetchTimestamp, defaultBranch, hasRemote }
  }
}
