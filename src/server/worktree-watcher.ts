import { watch } from 'fs'
import { serverLog } from './server-log'

/** Stops one directory watch. Calling it twice is a no-op. */
export type StopWatching = () => void

/**
 * The filesystem watch itself, injected so the lifecycle — which directories
 * are watched, when they are re-armed — can be tested without touching disk.
 */
export interface WorktreeWatcherDeps {
  /**
   * Watch a directory tree, calling `onChange` for any change anywhere beneath
   * it and `onError` if the watch dies. Throws if the tree cannot be watched
   * at all.
   */
  watch(dir: string, onChange: () => void, onError: (err: Error) => void): StopWatching
}

export const REAL_WORKTREE_WATCHER_DEPS: WorktreeWatcherDeps = {
  watch(dir, onChange, onError) {
    // Recursive watching is FSEvents on macOS: one kernel stream per tree
    // rather than a descriptor per file, so a large repo costs no more to
    // watch than a small one. `persistent: false` keeps these watches from
    // holding the process open on their own.
    const watcher = watch(dir, { recursive: true, persistent: false }, () => onChange())
    watcher.on('error', (err) => {
      watcher.close()
      onError(err instanceof Error ? err : new Error(String(err)))
    })
    return () => watcher.close()
  },
}

/**
 * Watches each repository's working tree, so a change is noticed when it
 * happens rather than when the next poll comes round.
 *
 * One recursive watch per directory covers both the working tree and the
 * `.git` inside it, so an edit, a commit and a branch switch all arrive the
 * same way. FSEvents coalesces heavily and drops events under load, so this is
 * a latency improvement and never a correctness guarantee — whoever consumes
 * `onChange` still needs a periodic sweep behind it.
 */
export class WorktreeWatcher {
  private watches = new Map<string, StopWatching>()
  private onChange: (dir: string) => void
  private deps: WorktreeWatcherDeps
  private disposed = false

  constructor(onChange: (dir: string) => void, deps: WorktreeWatcherDeps = REAL_WORKTREE_WATCHER_DEPS) {
    this.onChange = onChange
    this.deps = deps
  }

  /**
   * Watch exactly `dirs` — arming the ones that are new, dropping the ones that
   * have gone, and re-arming any whose watch died since the last call.
   *
   * Called periodically rather than only on change, so a directory that could
   * not be watched when it first appeared (not yet created, briefly replaced by
   * a checkout) is retried instead of being given up on.
   */
  sync(dirs: Set<string>): void {
    if (this.disposed) return

    for (const [dir, stop] of this.watches) {
      if (!dirs.has(dir)) {
        stop()
        this.watches.delete(dir)
      }
    }

    for (const dir of dirs) {
      if (this.watches.has(dir)) continue
      try {
        this.watches.set(dir, this.deps.watch(
          dir,
          () => { if (!this.disposed) this.onChange(dir) },
          (err) => this.onWatchError(dir, err)
        ))
      } catch {
        // Unwatchable for now — the next sync retries. Not logged: a directory
        // node can point at a path that does not exist yet, which is ordinary.
      }
    }
  }

  /** The directories currently being watched. */
  get watched(): string[] {
    return [...this.watches.keys()]
  }

  dispose(): void {
    this.disposed = true
    for (const stop of this.watches.values()) stop()
    this.watches.clear()
  }

  /**
   * Forget a dead watch so the next `sync` re-arms it. Until then the periodic
   * sweep is what keeps that repository up to date.
   */
  private onWatchError(dir: string, err: Error): void {
    this.watches.delete(dir)
    serverLog(`worktree-watcher: watch on ${dir} failed, falling back to polling until re-armed: ${err.message}`)
  }
}
