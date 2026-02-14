const STORAGE_KEY = 'spaceterm:layout'

export interface SavedRemnant {
  sessionId: string
  x: number
  y: number
  zIndex: number
  name?: string
  colorPresetId?: string
  parentId: string
  shellTitleHistory?: string[]
  cwd?: string
  exitCode: number
}

export interface SavedMarkdown {
  id: string
  x: number
  y: number
  zIndex: number
  width: number
  height: number
  content: string
  name?: string
  colorPresetId?: string
  parentId: string
}

export interface SavedLayout {
  camera: { x: number; y: number; z: number }
  terminals: { sessionId: string; x: number; y: number; zIndex: number; name?: string; colorPresetId?: string; parentId: string }[]
  remnants?: SavedRemnant[]
  markdowns?: SavedMarkdown[]
  nextZIndex: number
}

export function loadLayout(): SavedLayout | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed || !parsed.camera || !Array.isArray(parsed.terminals)) return null
    // Migrate old headerColor (hex) to colorPresetId
    for (const t of parsed.terminals) {
      if (t.headerColor && t.headerColor.startsWith('#')) {
        t.colorPresetId = 'default'
        delete t.headerColor
      }
      // Migrate old layouts without parentId
      t.parentId ??= 'root'
    }
    // Migrate old layouts without remnants
    parsed.remnants ??= []
    // Migrate old layouts without markdowns
    parsed.markdowns ??= []
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
