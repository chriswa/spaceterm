import type { UndoEntry } from '../../../../shared/undo-types'

const MAX_BUFFER = 100

// --- Cursor-based undo/redo buffer ---

let buffer: UndoEntry[] = []
let cursor = 0  // index of "next entry to undo" — 0 = nothing to undo, buffer.length = nothing to redo
let undoInProgress = false

/** Initialize from server state on startup. */
export function syncUndoBuffer(entries: UndoEntry[], serverCursor?: number): void {
  buffer = entries
  cursor = serverCursor ?? entries.length
}

/** Push a new entry. Truncates any redo history beyond cursor. */
export function pushUndo(entry: UndoEntry): void {
  // Discard redo entries
  buffer.splice(cursor)
  buffer.push(entry)
  cursor = buffer.length
  // Trim FIFO if over limit
  if (buffer.length > MAX_BUFFER) {
    buffer.shift()
    cursor--
  }
}

/** Peek at the entry that would be undone (cursor - 1). */
export function peekUndo(): UndoEntry | undefined {
  if (cursor <= 0) return undefined
  return buffer[cursor - 1]
}

/** Peek at the entry that would be redone (cursor). */
export function peekRedo(): UndoEntry | undefined {
  if (cursor >= buffer.length) return undefined
  return buffer[cursor]
}

/** Step backward: decrement cursor, return the entry. */
export function undoStep(): UndoEntry | undefined {
  if (cursor <= 0) return undefined
  cursor--
  return buffer[cursor]
}

/** Step forward: return the entry at cursor, then increment. */
export function redoStep(): UndoEntry | undefined {
  if (cursor >= buffer.length) return undefined
  const entry = buffer[cursor]
  cursor++
  return entry
}

/** Get current cursor position for syncing to server. */
export function getCursor(): number {
  return cursor
}

/** Guard so undo/redo execution doesn't push new entries. */
export function setUndoInProgress(v: boolean): void { undoInProgress = v }
export function getUndoInProgress(): boolean { return undoInProgress }

// --- Direction-aware confirmation state for archive/unarchive ---

let confirmationEntry: UndoEntry | null = null
let confirmationDirection: 'undo' | 'redo' | null = null
let confirmationTimer: ReturnType<typeof setTimeout> | null = null

export function getConfirmation(): { entry: UndoEntry; direction: 'undo' | 'redo' } | null {
  if (!confirmationEntry || !confirmationDirection) return null
  return { entry: confirmationEntry, direction: confirmationDirection }
}

export function setConfirmation(entry: UndoEntry | null, direction: 'undo' | 'redo' | null): void {
  if (confirmationTimer) {
    clearTimeout(confirmationTimer)
    confirmationTimer = null
  }
  confirmationEntry = entry
  confirmationDirection = direction
  if (entry) {
    confirmationTimer = setTimeout(() => {
      confirmationEntry = null
      confirmationDirection = null
      confirmationTimer = null
    }, 5000)
  }
}

export function clearConfirmation(): void {
  setConfirmation(null, null)
}
