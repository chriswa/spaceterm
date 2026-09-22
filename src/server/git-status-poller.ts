import type { GitStatus, DirectoryNodeData } from '../shared/state'
import type { NodeId } from '../shared/ids'
import { RepoProbe, expandTilde } from './repo-probe'
import { WorktreeWatcher } from './worktree-watcher'

/**
 * How often every repo gets a full `git status` regardless of what the
 * filesystem said.
 *
 * This is a backstop, not the main mechanism. FSEvents coalesces and drops
 * events under load, and a watch can die with its directory, so a repo that
 * went quiet for the wrong reason still gets re-read — just not often enough to
 * cost anything.
 */
export const SWEEP_INTERVAL_MS = 30_000

/**
 * How often every repo's `.git` metadata mtimes get a look.
 *
 * Stat calls only, no subprocess, so this is cheap enough to run every second.
 * It covers the same ground as the watcher for branch switches, commits and
 * fetches, and earns its keep when a filesystem event goes missing: the repo is
 * caught in a second rather than at the next sweep.
 */
export const METADATA_INTERVAL_MS = 1_000

/**
 * The most often one repository will be asked for its status, however much its
 * files are churning. A build writing into a gitignored directory can produce
 * hundreds of events a second; this is what stops that from turning into
 * hundreds of `git status` runs.
 */
export const MIN_POLL_INTERVAL_MS = 1_000

/**
 * How long to let filesystem events settle before reading the repo.
 *
 * Saving one file produces several events, and an editor that writes to a
 * temporary file and renames produces them across two paths. Waiting a moment
 * turns that burst into a single `git status` — and reads the tree after the
 * write rather than during it — at a cost no one can perceive.
 */
export const WATCH_SETTLE_MS = 100

type GetDirectoryNodes = () => DirectoryNodeData[]
type OnGitStatus = (nodeId: NodeId, gitStatus: GitStatus | null) => void

/** Cancels a scheduled callback. Calling it after the callback ran is a no-op. */
export type CancelScheduled = () => void

/** The part of a `WorktreeWatcher` the poller drives. */
export interface DirectoryWatcher {
  sync(dirs: Set<string>): void
  dispose(): void
}

/**
 * What a poller needs beyond the node list: a way to interrogate one repo, a
 * way to watch directories, and timers. Injecting them lets the scheduling,
 * throttling and caching be tested without a repo on disk or a second of
 * wall-clock.
 */
export interface GitStatusPollerDeps {
  /** A probe for one already-tilde-expanded working directory. */
  createProbe(cwd: string): Pick<RepoProbe, 'status' | 'metadataMoved' | 'reset'>
  createWatcher(onChange: (cwd: string) => void): DirectoryWatcher
  scheduleInterval(fn: () => void, ms: number): CancelScheduled
  scheduleTimeout(fn: () => void, ms: number): CancelScheduled
}

export const REAL_GIT_STATUS_POLLER_DEPS: GitStatusPollerDeps = {
  createProbe: (cwd) => new RepoProbe(cwd),
  createWatcher: (onChange) => new WorktreeWatcher(onChange),
  scheduleInterval(fn, ms) {
    const timer = setInterval(fn, ms)
    return () => clearInterval(timer)
  },
  scheduleTimeout(fn, ms) {
    const timer = setTimeout(fn, ms)
    return () => clearTimeout(timer)
  }
}

/** A poll currently running for one cwd, and whether another was asked for meanwhile. */
interface ActivePoll {
  rerun: boolean
}

export class GitStatusPoller {
  private cancelSweep: CancelScheduled | null = null
  private cancelMetadataWatch: CancelScheduled | null = null
  /** Every timer this poller has armed, so dispose can cancel the lot. */
  private timers = new Set<CancelScheduled>()
  private cache = new Map<NodeId, string>() // nodeId → JSON.stringify(GitStatus)
  /** One probe per resolved cwd, so its cached facts survive between polls. */
  private probes = new Map<string, ReturnType<GitStatusPollerDeps['createProbe']>>()
  /** Resolved cwds with a poll in flight — a repo is never polled twice at once. */
  private active = new Map<string, ActivePoll>()
  /** cwds waiting out `WATCH_SETTLE_MS` before being polled. */
  private settling = new Map<string, CancelScheduled>()
  /** cwds polled within the last `MIN_POLL_INTERVAL_MS`. */
  private cooldown = new Map<string, CancelScheduled>()
  /** cwds that changed during their cooldown, to poll when it lifts. */
  private wanted = new Set<string>()
  private watcher: DirectoryWatcher
  private disposed = false
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
    this.watcher = this.deps.createWatcher((cwd) => this.requestPoll(cwd))
    this.cancelSweep = this.deps.scheduleInterval(() => this.sweep(), SWEEP_INTERVAL_MS)
    this.cancelMetadataWatch = this.deps.scheduleInterval(() => this.checkMetadata(), METADATA_INTERVAL_MS)
    // Poll all directories immediately on startup
    this.sweep()
  }

  removeNode(nodeId: NodeId): void {
    this.cache.delete(nodeId)
  }

  /**
   * Immediately poll a specific node (e.g. after its cwd changes).
   * Invalidates the cache so the result always fires the callback, and discards
   * the probe's cached answers, which described the directory it used to be.
   */
  pollNode(nodeId: NodeId): void {
    const node = this.getDirectoryNodes().find(n => n.id === nodeId)
    if (!node) return
    const cwd = expandTilde(node.cwd)
    this.cache.delete(nodeId)
    this.probeFor(cwd).reset()
    // Asked for by hand, so it jumps the throttle.
    this.pollCwd(cwd)
  }

  dispose(): void {
    this.disposed = true
    this.cancelSweep?.()
    this.cancelSweep = null
    this.cancelMetadataWatch?.()
    this.cancelMetadataWatch = null
    this.watcher.dispose()
    // Staggered sweep polls, settle delays and cooldowns would otherwise keep
    // firing — and keep the process alive — after dispose. Same shape as the
    // DaemonClient reconnect-after-dispose bug.
    for (const cancel of this.timers) cancel()
    this.timers.clear()
    this.settling.clear()
    this.cooldown.clear()
    this.wanted.clear()
  }

  /** Arm a timer that `dispose` knows about, and that forgets itself when it fires. */
  private later(fn: () => void, ms: number): CancelScheduled {
    // Holder rather than a `let` the callback closes over before assignment.
    const handle: { cancel?: CancelScheduled } = {}
    handle.cancel = this.deps.scheduleTimeout(() => {
      if (handle.cancel) this.timers.delete(handle.cancel)
      fn()
    }, ms)
    this.timers.add(handle.cancel)
    return handle.cancel
  }

  /** The resolved cwds currently on the canvas, deduplicated. */
  private uniqueCwds(): Set<string> {
    const cwds = new Set<string>()
    for (const node of this.getDirectoryNodes()) cwds.add(expandTilde(node.cwd))
    return cwds
  }

  private probeFor(cwd: string): ReturnType<GitStatusPollerDeps['createProbe']> {
    let probe = this.probes.get(cwd)
    if (!probe) {
      probe = this.deps.createProbe(cwd)
      this.probes.set(cwd, probe)
    }
    return probe
  }

  /**
   * A full `git status` for every repo, spread evenly across the sweep interval
   * so a dozen of them never run at once. Also the moment the watcher is
   * brought back in line with the canvas, and any dead watch re-armed.
   */
  private sweep(): void {
    const live = this.uniqueCwds()

    // Directories that have left the canvas keep no probe, and no cached facts.
    for (const cwd of [...this.probes.keys()]) {
      if (!live.has(cwd)) this.probes.delete(cwd)
    }
    this.watcher.sync(live)
    if (live.size === 0) return

    const cwds = [...live]
    const spacing = cwds.length > 1 ? SWEEP_INTERVAL_MS / cwds.length : 0
    for (let i = 0; i < cwds.length; i++) {
      const cwd = cwds[i]
      this.later(() => this.pollCwd(cwd), i * spacing)
    }
  }

  /**
   * Ask every repo whether its `.git` metadata moved, and poll the ones that
   * say yes. Repos already being polled are skipped — that poll will read the
   * new state anyway.
   */
  private checkMetadata(): void {
    for (const cwd of this.uniqueCwds()) {
      if (this.active.has(cwd)) continue
      this.probeFor(cwd).metadataMoved()
        .then((moved) => { if (moved) this.requestPoll(cwd) })
        .catch(() => { /* the sweep will read it regardless */ })
    }
  }

  /**
   * Something says this repo changed. Poll it once the event burst has settled,
   * and no more than once per `MIN_POLL_INTERVAL_MS` however much it churns.
   *
   * The throttle is built from timers rather than timestamps so it behaves
   * identically under a fake clock.
   */
  private requestPoll(cwd: string): void {
    if (this.disposed) return
    // Already queued, one way or another.
    if (this.settling.has(cwd) || this.wanted.has(cwd)) return
    if (this.cooldown.has(cwd)) {
      this.wanted.add(cwd)
      return
    }
    this.settling.set(cwd, this.later(() => {
      this.settling.delete(cwd)
      this.pollCwd(cwd)
    }, WATCH_SETTLE_MS))
  }

  /**
   * Poll one repo now, or — if it is already being polled — note that another
   * poll is wanted once that one lands. Without the second half, a poll
   * requested while a slow `git status` is in flight would simply be dropped.
   */
  private pollCwd(cwd: string): void {
    if (this.disposed) return
    const active = this.active.get(cwd)
    if (active) {
      active.rerun = true
      return
    }
    void this.runPoll(cwd)
  }

  private async runPoll(cwd: string): Promise<void> {
    const active: ActivePoll = { rerun: false }
    this.active.set(cwd, active)
    try {
      this.publish(cwd, await this.probeFor(cwd).status())
    } catch {
      // Ignore — the next sweep retries.
    } finally {
      this.active.delete(cwd)
    }
    if (this.disposed) return
    this.startCooldown(cwd)
    if (active.rerun) void this.runPoll(cwd)
  }

  /**
   * Hold this repo off for `MIN_POLL_INTERVAL_MS`, then poll it once more if
   * anything asked while it was held.
   */
  private startCooldown(cwd: string): void {
    this.cooldown.get(cwd)?.()
    this.cooldown.set(cwd, this.later(() => {
      this.cooldown.delete(cwd)
      if (this.wanted.delete(cwd)) this.pollCwd(cwd)
    }, MIN_POLL_INTERVAL_MS))
  }

  /**
   * Hand the result to every node pointing at this cwd whose last-seen status
   * differs. The node list is re-read here rather than captured before the
   * poll, so a node added or moved while git was running gets the right answer.
   */
  private publish(cwd: string, result: GitStatus | null): void {
    const json = JSON.stringify(result)
    for (const node of this.getDirectoryNodes()) {
      if (expandTilde(node.cwd) !== cwd) continue
      if (json === this.cache.get(node.id)) continue
      this.cache.set(node.id, json)
      this.onGitStatus(node.id, result)
    }
  }
}
