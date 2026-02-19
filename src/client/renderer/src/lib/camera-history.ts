import type { Camera } from './camera'

export interface CameraHistoryEntry {
  camera: Camera
  focusedId: string | null
}

const MAX_ENTRIES = 1000
const POSITION_THRESHOLD = 5
const ZOOM_THRESHOLD = 0.01

const entries: CameraHistoryEntry[] = []
let cursor = -1

function entriesClose(a: CameraHistoryEntry, b: CameraHistoryEntry): boolean {
  return (
    Math.abs(a.camera.x - b.camera.x) < POSITION_THRESHOLD &&
    Math.abs(a.camera.y - b.camera.y) < POSITION_THRESHOLD &&
    Math.abs(a.camera.z - b.camera.z) < ZOOM_THRESHOLD &&
    a.focusedId === b.focusedId
  )
}

export function pushCameraHistory(entry: CameraHistoryEntry): void {
  // Dedup: skip if close to current entry
  if (cursor >= 0 && entriesClose(entries[cursor], entry)) return

  // Truncate any forward entries (undo-style)
  entries.length = cursor + 1

  entries.push(entry)
  cursor = entries.length - 1

  // Cap size by shifting from front
  if (entries.length > MAX_ENTRIES) {
    entries.shift()
    cursor--
  }
}

export function goBack(): CameraHistoryEntry | null {
  if (cursor <= 0) return null
  cursor--
  return entries[cursor]
}

export function goForward(): CameraHistoryEntry | null {
  if (cursor >= entries.length - 1) return null
  cursor++
  return entries[cursor]
}
