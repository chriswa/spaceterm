import { writeFileSync, readFileSync, renameSync, existsSync, openSync, fsyncSync, closeSync, mkdirSync } from 'fs'
import { dirname, join } from 'path'
import type { ServerState } from '../shared/state'
import { SOCKET_DIR } from '../shared/protocol'

const STATE_FILE = join(SOCKET_DIR, 'state.json')
const STATE_TMP = STATE_FILE + '.tmp'
const DEBOUNCE_MS = 1000

/** Cancels a scheduled callback. Calling it after the callback ran is a no-op. */
export type CancelScheduled = () => void

/**
 * The two collaborators persistence needs: a place to put bytes, and a clock.
 * `REAL_PERSISTENCE_IO` is the production implementation; tests supply a fake so
 * they never touch `~/.spaceterm` or wait on a real timer.
 */
export interface PersistenceIO {
  /** Read the persisted document, or null if it does not exist / cannot be read. */
  read(): string | null
  /** Replace the persisted document atomically. May throw. */
  write(data: string): void
  /** Run `fn` after `ms` milliseconds. Returns a cancel function. */
  schedule(fn: () => void, ms: number): CancelScheduled
}

export const REAL_PERSISTENCE_IO: PersistenceIO = {
  read(): string | null {
    if (!existsSync(STATE_FILE)) return null
    try {
      return readFileSync(STATE_FILE, 'utf-8')
    } catch {
      return null
    }
  },

  /** Atomically write state to disk: write to .tmp → fsync → rename */
  write(data: string): void {
    mkdirSync(dirname(STATE_FILE), { recursive: true })
    writeFileSync(STATE_TMP, data, 'utf-8')
    const fd = openSync(STATE_TMP, 'r')
    try {
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(STATE_TMP, STATE_FILE)
  },

  schedule(fn: () => void, ms: number): CancelScheduled {
    const timer = setTimeout(fn, ms)
    return () => clearTimeout(timer)
  }
}

/**
 * Strip ephemeral fields (e.g. gitStatus) from state before persisting.
 * Returns a JSON string ready to write. Uses a replacer to avoid deep-cloning.
 */
export function serializeState(state: ServerState): string {
  return JSON.stringify(state, (key, value) => {
    if (key === 'gitStatus') return undefined
    return value
  }, 2)
}

/**
 * Owns the debounced write-to-disk cycle for one `ServerState`.
 *
 * This used to be a set of module-level functions sharing one module-scoped
 * timer, which meant two `StateManager`s in a single process would cancel each
 * other's writes — and made `StateManager` untestable, since a test could not
 * avoid writing to the real `~/.spaceterm/state.json`. Instances own their own
 * timer, so both problems go away.
 */
export class StatePersister {
  private cancelPending: CancelScheduled | null = null

  constructor(
    private readonly io: PersistenceIO = REAL_PERSISTENCE_IO,
    private readonly debounceMs: number = DEBOUNCE_MS
  ) {}

  /**
   * Schedule a debounced write. Resets the timer on each call, so state is
   * written after `debounceMs` of inactivity.
   */
  schedule(state: ServerState): void {
    this.cancel()
    this.cancelPending = this.io.schedule(() => {
      this.cancelPending = null
      this.io.write(serializeState(state))
    }, this.debounceMs)
  }

  /**
   * Immediately persist state (used on shutdown, PTY exit).
   * Also cancels any pending debounced write.
   */
  flush(state: ServerState): void {
    this.cancel()
    this.io.write(serializeState(state))
  }

  /** Drop any pending write without performing it. */
  cancel(): void {
    if (this.cancelPending !== null) {
      this.cancelPending()
      this.cancelPending = null
    }
  }

  /** True while a debounced write is waiting to fire. */
  get hasPendingWrite(): boolean {
    return this.cancelPending !== null
  }

  /**
   * Load state from storage. Returns null if absent or invalid.
   */
  load(): ServerState | null {
    const raw = this.io.read()
    if (raw === null) return null
    try {
      const parsed = JSON.parse(raw) as ServerState
      if (!parsed || typeof parsed.version !== 'number' || !parsed.nodes) return null
      return parsed
    } catch {
      return null
    }
  }
}
