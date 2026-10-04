/**
 * What the page is holding in memory, as far as a page can see — for the
 * zoomed-out kills: iOS ends the page's process (zoom about 0.05–0.11, a
 * handful of glowing cards) and nothing in the log says what grew.
 *
 * WebKit offers no heap figure, so this measures the allocations a page can
 * count itself: every canvas's backing store (the cards' snapshot bitmaps,
 * xterm's WebGL canvases, the background), the DOM's size, and how many cards
 * are on screen. Compositor layers are invisible from here; if these stay
 * small at the moment of a kill, the memory went there.
 *
 * - `[memory]` — logged whenever canvas memory moves by a quarter or more.
 * - `[memory] last seen before the kill` — the same, written every tick to
 *   localStorage, which outlives the page's process, and logged on reload.
 */

const KEY = 'spaceterm:memory-breadcrumb'
const TICK_MS = 250
const MB = 1024 * 1024

interface Measure { canvasBytes: number; summary: string }

/** The page's canvases, DOM and on-screen cards, in one line. */
export function measure(doc: Document = document, viewport = { width: window.innerWidth, height: window.innerHeight }): Measure {
  const canvases = [...doc.querySelectorAll('canvas')]
  let canvasBytes = 0
  let largest: HTMLCanvasElement | undefined
  for (const canvas of canvases) {
    const bytes = canvas.width * canvas.height * 4
    canvasBytes += bytes
    if (!largest || bytes > largest.width * largest.height * 4) largest = canvas
  }
  let onScreen = 0
  for (const card of doc.querySelectorAll('.card-shell')) {
    const r = card.getBoundingClientRect()
    if (r.right > 0 && r.bottom > 0 && r.left < viewport.width && r.top < viewport.height) onScreen++
  }
  const where = largest ? ` in ${largest.className || largest.parentElement?.className || 'canvas'}`.slice(0, 60) : ''
  const summary = `canvases ${canvases.length} = ${(canvasBytes / MB).toFixed(1)}MB`
    + (largest ? `, largest ${largest.width}x${largest.height}${where}` : '')
    + `; ${doc.getElementsByTagName('*').length} elements; ${onScreen} cards on screen`
  return { canvasBytes, summary }
}

export function installMemoryProbe(log: (message: string) => void, killed: boolean): void {
  if (killed) {
    try {
      const crumb = localStorage.getItem(KEY)
      if (crumb) log(`[memory] last seen before the kill: ${crumb}`)
    } catch { /* storage unavailable */ }
  }
  let logged = -1
  setInterval(() => {
    const { canvasBytes, summary } = measure()
    try { localStorage.setItem(KEY, `${new Date().toISOString()} ${summary}`) } catch { /* private mode, or full */ }
    if (logged < 0 || Math.abs(canvasBytes - logged) >= Math.max(logged, MB) / 4) {
      logged = canvasBytes
      log(`[memory] ${summary}`)
    }
  }, TICK_MS)
}
