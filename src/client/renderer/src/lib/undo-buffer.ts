import type { UndoEntry } from '../../../../shared/undo-types'

const MAX_BUFFER = 100

// --- Server-persisted buffer (synced from server state on startup) ---

let buffer: UndoEntry[] = []
let undoInProgress = false

/** Initialize from server state on startup. */
export function syncUndoBuffer(entries: UndoEntry[]): void {
  buffer = entries
}

/** Push a new entry locally. Trims FIFO if > MAX_BUFFER. */
export function pushUndo(entry: UndoEntry): void {
  buffer.push(entry)
  if (buffer.length > MAX_BUFFER) buffer.shift()
}

/** Peek at the top entry without removing it. */
export function peekUndo(): UndoEntry | undefined {
  return buffer[buffer.length - 1]
}

/** Pop and return the top entry. */
export function popUndo(): UndoEntry | undefined {
  return buffer.pop()
}

/** Guard so undo execution doesn't push new entries. */
export function setUndoInProgress(v: boolean): void { undoInProgress = v }
export function getUndoInProgress(): boolean { return undoInProgress }

// --- Confirmation state for archive/unarchive undo ---

let confirmationEntry: UndoEntry | null = null
let confirmationTimer: ReturnType<typeof setTimeout> | null = null

export function getConfirmation(): UndoEntry | null {
  return confirmationEntry
}

export function setConfirmation(entry: UndoEntry | null): void {
  if (confirmationTimer) {
    clearTimeout(confirmationTimer)
    confirmationTimer = null
  }
  confirmationEntry = entry
  if (entry) {
    confirmationTimer = setTimeout(() => {
      confirmationEntry = null
      confirmationTimer = null
    }, 5000)
  }
}

export function clearConfirmation(): void {
  setConfirmation(null)
}
