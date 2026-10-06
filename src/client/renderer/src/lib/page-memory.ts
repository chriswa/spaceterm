/**
 * What a page is holding that it can count itself: every canvas's backing
 * store (the cards' snapshot bitmaps, xterm's WebGL canvases, the background),
 * the DOM's size, and how many cards are on screen. Compositor layers and GPU
 * tiles are invisible from here.
 */

const MB = 1024 * 1024

export interface Measure { canvasBytes: number; summary: string }

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

const DESKTOP_TICK_MS = 30_000

/**
 * The desktop's `[memory]` line, with the settled zoom: logged when canvas
 * memory moves by a quarter or the zoom by a factor of two, since GPU tile
 * memory, which a page cannot see, grows with how far out the camera is.
 */
export function installDesktopMemoryProbe(log: (message: string) => void): void {
  let loggedBytes = -1
  let loggedZoom = 0
  setInterval(() => {
    const { canvasBytes, summary } = measure()
    const surface = document.querySelector<HTMLElement>('.canvas-surface')
    const zoom = Number(surface?.style.getPropertyValue('--settled-camera-zoom')) || 0
    const zoomMoved = loggedZoom === 0 || zoom / loggedZoom >= 2 || zoom / loggedZoom <= 0.5
    if (loggedBytes >= 0 && Math.abs(canvasBytes - loggedBytes) < Math.max(loggedBytes, MB) / 4 && !zoomMoved) return
    loggedBytes = canvasBytes
    loggedZoom = zoom
    log(`[memory] ${summary}; zoom ${zoom.toFixed(3)}`)
  }, DESKTOP_TICK_MS)
}
