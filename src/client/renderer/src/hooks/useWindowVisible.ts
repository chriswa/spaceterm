import { useEffect, useState } from 'react'

/**
 * Whether the window is worth drawing for.
 *
 * Two sources, ANDed, because neither sees everything:
 *
 * - **IPC from the main process** — `hide`/`show`/`minimize`/`restore` on the
 *   `BrowserWindow`.
 * - **`document.visibilityState`** — what Chromium itself believes, and the only
 *   way to learn the window has been *occluded*: fully covered by another
 *   window, or on a Space that is not on screen. Electron's `BrowserWindow`
 *   emits no event for that, so IPC cannot report it.
 *
 * Occlusion is the case that matters most, because Chromium drops a hidden
 * surface's composited frames. Anything that draws to a canvas and then stops —
 * see `CanvasFrameGate` — is showing a frame the compositor is entitled to have
 * discarded, and has to repaint on the way back. A loop that never hears about
 * occlusion never repaints.
 *
 * Subscribe through `onWindowVisibleChange` rather than
 * `window.api.window.onVisibilityChanged`: the latter is only one of the two
 * inputs to this, so a loop that listens to it directly is a loop that misses
 * occlusion.
 */

let ipcVisible = true
let documentVisible = true
let _visible = true
const listeners = new Set<(visible: boolean) => void>()

function recompute(): void {
  const next = ipcVisible && documentVisible
  if (next === _visible) return
  _visible = next
  for (const cb of listeners) cb(next)
}

// Subscribe once on module load
if (typeof window !== 'undefined') {
  if (window.api?.window?.onVisibilityChanged) {
    window.api.window.onVisibilityChanged((visible) => {
      ipcVisible = visible
      recompute()
    })
  }
  if (typeof document !== 'undefined') {
    documentVisible = document.visibilityState !== 'hidden'
    _visible = ipcVisible && documentVisible
    document.addEventListener('visibilitychange', () => {
      documentVisible = document.visibilityState !== 'hidden'
      recompute()
    })
  }
}

/** Non-React getter for use inside RAF loops and callbacks */
export function isWindowVisible(): boolean {
  return _visible
}

/**
 * Subscribe to visibility changes; returns an unsubscribe.
 *
 * For render loops, which want a callback rather than a re-render.
 */
export function onWindowVisibleChange(cb: (visible: boolean) => void): () => void {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}

/** React hook that re-renders when window visibility changes */
export function useWindowVisible(): boolean {
  const [visible, setVisible] = useState(_visible)

  useEffect(() => {
    const cb = (v: boolean) => setVisible(v)
    listeners.add(cb)
    // Sync in case it changed between render and effect
    setVisible(_visible)
    return () => { listeners.delete(cb) }
  }, [])

  return visible
}
