import { writeFileSync, readFileSync, renameSync, existsSync, openSync, fsyncSync, closeSync, mkdirSync } from 'fs'
import { dirname, join } from 'path'
import type { ServerState } from '../shared/state'
import { SOCKET_DIR } from '../shared/protocol'

const STATE_FILE = join(SOCKET_DIR, 'state.json')
const STATE_TMP = STATE_FILE + '.tmp'
const DEBOUNCE_MS = 1000

let debounceTimer: ReturnType<typeof setTimeout> | null = null

/**
 * Strip ephemeral fields (e.g. gitStatus) from state before persisting.
 * Returns a JSON string ready to write. Uses a replacer to avoid deep-cloning.
 */
function serializeState(state: ServerState): string {
  return JSON.stringify(state, (key, value) => {
    if (key === 'gitStatus') return undefined
    return value
  }, 2)
}

/**
 * Atomically write state to disk: write to .tmp → fsync → rename
 */
function writeAtomic(state: ServerState): void {
  mkdirSync(dirname(STATE_FILE), { recursive: true })
  const data = serializeState(state)
  writeFileSync(STATE_TMP, data, 'utf-8')
  const fd = openSync(STATE_TMP, 'r')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(STATE_TMP, STATE_FILE)
}

/**
 * Schedule a debounced write. Resets the timer on each call.
 * State is written after DEBOUNCE_MS of inactivity.
 */
export function schedulePersist(state: ServerState): void {
  if (debounceTimer !== null) {
    clearTimeout(debounceTimer)
  }
  debounceTimer = setTimeout(() => {
    debounceTimer = null
    writeAtomic(state)
  }, DEBOUNCE_MS)
}

/**
 * Immediately persist state (used on shutdown, PTY exit).
 * Also cancels any pending debounced write.
 */
export function persistNow(state: ServerState): void {
  if (debounceTimer !== null) {
    clearTimeout(debounceTimer)
    debounceTimer = null
  }
  writeAtomic(state)
}

/**
 * Load state from disk. Returns null if file doesn't exist or is invalid.
 */
export function loadState(): ServerState | null {
  if (!existsSync(STATE_FILE)) return null
  try {
    const raw = readFileSync(STATE_FILE, 'utf-8')
    const parsed = JSON.parse(raw) as ServerState
    if (!parsed || typeof parsed.version !== 'number' || !parsed.nodes) return null
    return parsed
  } catch {
    return null
  }
}
