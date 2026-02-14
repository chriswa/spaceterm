import type { TreeNode } from '../hooks/useTerminalManager'

const STORAGE_KEY = 'spaceterm:layout'
const LAYOUT_VERSION = 2

export interface SavedLayout {
  version: number
  camera: { x: number; y: number; z: number }
  nodes: TreeNode[]
  nextZIndex: number
  /** Saved terminal session IDs → position info for restoring PTY sessions from the server */
  terminalPositions?: Record<string, { x: number; y: number; zIndex: number; name?: string; colorPresetId?: string; parentId?: string }>
}

export function loadLayout(): SavedLayout | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed || parsed.version !== LAYOUT_VERSION) return null
    if (!parsed.camera || !Array.isArray(parsed.nodes)) return null
    return parsed as SavedLayout
  } catch {
    return null
  }
}

export function saveLayout(layout: SavedLayout): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(layout))
  } catch {
    // localStorage full or unavailable
  }
}
