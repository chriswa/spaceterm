import { writeFileSync, readFileSync, renameSync, existsSync, openSync, fsyncSync, closeSync, mkdirSync, copyFileSync } from 'fs'
import { dirname, join } from 'path'
import type { ServerState } from '../shared/state'
import { SOCKET_DIR } from '../shared/protocol'
import { assertNever } from '../shared/exhaustive'
import { migrateState, emptyState, CURRENT_STATE_VERSION, type MigrationResult } from './state-migrations'

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
  /**
   * Copy the current document aside under `label`, so a state file we are about
   * to stop honouring is not lost. Best-effort: failures must not block startup.
   */
  archive(label: string): void
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

  archive(label: string): void {
    if (!existsSync(STATE_FILE)) return
    try {
      copyFileSync(STATE_FILE, `${STATE_FILE}.${label}`)
    } catch (err) {
      console.error(`[persistence] Could not preserve state file as .${label}: ${String(err)}`)
    }
  },

  schedule(fn: () => void, ms: number): CancelScheduled {
    const timer = setTimeout(fn, ms)
    return () => clearTimeout(timer)
  }
}

/**
 * Node fields deliberately not persisted.
 *
 * These are re-derived at startup and are worse than useless on disk: a stale
 * `gitStatus` shows the branch and dirty count from whenever the app last quit,
 * which reads as current until the first poll replaces it seconds later.
 *
 * Named and exported rather than inlined in the replacer so the round-trip test
 * can assert this exact list — a field added here without a reason, or a field
 * that stops being ephemeral, both show up as a failing test instead of as a
 * document that quietly loses data.
 */
export const EPHEMERAL_STATE_FIELDS = ['gitStatus'] as const

const EPHEMERAL_FIELD_SET: ReadonlySet<string> = new Set(EPHEMERAL_STATE_FIELDS)

/**
 * Serialise state for disk, dropping the ephemeral fields above.
 *
 * A `JSON.stringify` replacer rather than a deep clone: the document holds
 * every node plus their archived children, and copying it on every debounced
 * write would be the most expensive thing the server does at idle.
 */
export function serializeState(state: ServerState): string {
  return JSON.stringify(state, (key, value) => (EPHEMERAL_FIELD_SET.has(key) ? undefined : value), 2)
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
   * Load and migrate persisted state.
   *
   * Returns a usable `ServerState` in every case, because refusing to start is
   * worse than starting empty. When the stored document cannot be honoured — it
   * is corrupt, or was written by a newer build whose fields we would silently
   * drop — the file is copied aside before the caller is handed a fresh state,
   * so the next write does not destroy something recoverable.
   */
  load(): { state: ServerState; outcome: MigrationResult } {
    const raw = this.io.read()
    if (raw === null) return { state: emptyState(), outcome: { status: 'empty' } }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (err) {
      return this.startFresh({ status: 'corrupt', reason: `invalid JSON: ${String(err)}` })
    }

    const outcome = migrateState(parsed)
    switch (outcome.status) {
      case 'ok':
        if (outcome.migratedFrom !== null) {
          // Keep the pre-migration file: a migration bug should be recoverable.
          this.io.archive(`v${outcome.migratedFrom}`)
          console.log(
            `[persistence] Migrated state from version ${outcome.migratedFrom} to ${CURRENT_STATE_VERSION}`
          )
        }
        return { state: outcome.state, outcome }

      case 'corrupt':
        return this.startFresh(outcome)

      case 'too-new':
        console.error(
          `[persistence] State file is version ${outcome.found}, but this build understands ${outcome.supported}. ` +
            'Starting empty and preserving the existing file.'
        )
        return this.startFresh(outcome)

      case 'empty':
        return { state: emptyState(), outcome }

      default:
        return assertNever(outcome, 'StatePersister.load')
    }
  }

  private startFresh(outcome: MigrationResult): { state: ServerState; outcome: MigrationResult } {
    const label = outcome.status === 'too-new' ? `v${outcome.found}` : 'unreadable'
    if (outcome.status === 'corrupt') {
      console.error(`[persistence] State file is unusable (${outcome.reason}); preserving it as .${label}`)
    }
    this.io.archive(label)
    return { state: emptyState(), outcome }
  }
}
