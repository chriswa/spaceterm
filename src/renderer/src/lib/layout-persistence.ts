const STORAGE_KEY = 'spaceterm:layout'

export interface SavedLayout {
  camera: { x: number; y: number; z: number }
  terminals: { sessionId: string; x: number; y: number; zIndex: number; name?: string; headerColor?: string }[]
  nextZIndex: number
}

export function loadLayout(): SavedLayout | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed || !parsed.camera || !Array.isArray(parsed.terminals)) return null
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
