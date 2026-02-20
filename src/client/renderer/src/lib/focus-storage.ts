const FOCUS_KEY = 'spaceterm-focus'
const SCROLL_PREFIX = 'spaceterm-scroll-'

interface FocusState {
  focusedId: string | null
  scrollMode: boolean
}

export function saveFocusState(focusedId: string | null, scrollMode: boolean): void {
  try {
    localStorage.setItem(FOCUS_KEY, JSON.stringify({ focusedId, scrollMode }))
  } catch { /* ignore quota errors */ }
}

export function loadFocusState(): FocusState | null {
  try {
    const raw = localStorage.getItem(FOCUS_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (typeof parsed.focusedId === 'string' || parsed.focusedId === null) {
      return { focusedId: parsed.focusedId, scrollMode: !!parsed.scrollMode }
    }
    return null
  } catch { return null }
}

export function saveTerminalScroll(sessionId: string, pixels: number): void {
  try {
    localStorage.setItem(SCROLL_PREFIX + sessionId, String(pixels))
  } catch { /* ignore quota errors */ }
}

export function loadTerminalScroll(sessionId: string): number | null {
  try {
    const raw = localStorage.getItem(SCROLL_PREFIX + sessionId)
    if (!raw) return null
    const val = Number(raw)
    return Number.isFinite(val) ? val : null
  } catch { return null }
}

export function clearTerminalScroll(sessionId: string): void {
  try {
    localStorage.removeItem(SCROLL_PREFIX + sessionId)
  } catch { /* ignore */ }
}

// Tracks which sessions should restore scroll on next mount (set by App during reload restore)
const pendingScrollRestore = new Set<string>()

export function markSessionForScrollRestore(sessionId: string): void {
  pendingScrollRestore.add(sessionId)
}

export function consumeScrollRestore(sessionId: string): boolean {
  return pendingScrollRestore.delete(sessionId)
}

export function cleanupStaleScrollEntries(validSessionIds: Set<string>): void {
  try {
    const keysToRemove: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key && key.startsWith(SCROLL_PREFIX)) {
        const sessionId = key.slice(SCROLL_PREFIX.length)
        if (!validSessionIds.has(sessionId)) {
          keysToRemove.push(key)
        }
      }
    }
    for (const key of keysToRemove) {
      localStorage.removeItem(key)
    }
  } catch { /* ignore */ }
}
