import { createGate, type Gate } from './gate'

/**
 * Whether the phone's canvas — the desktop's whole `App`, every card in it —
 * is mounted at all.
 *
 * Most of the time on the phone is spent talking to Control, with the canvas
 * out of sight (Control mode: the transcript up, or the screen off). Paused,
 * a mounted canvas still re-renders on every agent update and holds every
 * card in memory, so it is not kept for long:
 *
 * - A fresh start opens on Control's transcript with no canvas at all, and
 *   the canvas first mounts when you leave the transcript.
 * - Leaving Control mode — closing the transcript, or the screen coming back
 *   on with the canvas or a terminal in front — always mounts it.
 * - After `IDLE_MS` in Control mode, it is unmounted. Coming back to the
 *   transcript keeps it unmounted; coming back to the canvas mounts it again,
 *   and App restores the camera and focus it saved (localStorage), which puts
 *   you back on the same view, or in the same terminal.
 *
 * Nothing outside the canvas depends on it being mounted: the stores it
 * draws from are kept current by the server sync, which main.tsx holds for
 * the page's life (`retainServerSync`).
 */

export const IDLE_MS = 5 * 60_000

let holds = 0

/**
 * Keep the canvas mounted while something open on top of it would be lost
 * with it — the composer, mid-draft. Returns the release.
 */
export function holdCanvas(): () => void {
  holds++
  let released = false
  return () => {
    if (released) return
    released = true
    holds--
  }
}

export interface CanvasLifecycleDeps {
  controlMode: Gate
  /** Mounted from the start: a reload that was on the canvas, not a fresh start. */
  startMounted: boolean
  /** Something that must not lose the canvas under it, such as an open composer. */
  pinned?: () => boolean
  setTimer?: (fn: () => void, ms: number) => () => void
  log?: (message: string) => void
}

export function canvasLifecycle({
  controlMode,
  startMounted,
  pinned = () => holds > 0,
  setTimer = (fn, ms) => { const id = setTimeout(fn, ms); return () => clearTimeout(id) },
  log = () => undefined,
}: CanvasLifecycleDeps): Gate {
  const mounted = createGate(startMounted || !controlMode.on)
  let cancelIdle: (() => void) | null = null

  const armIdle = () => {
    cancelIdle?.()
    cancelIdle = setTimer(() => {
      cancelIdle = null
      if (!controlMode.on || !mounted.on) return
      // Still wanted: look again after another stretch.
      if (pinned()) { armIdle(); return }
      log(`[canvas] unmounted after ${IDLE_MS / 60_000} minutes out of sight`)
      mounted.set(false)
    }, IDLE_MS)
  }

  if (controlMode.on && mounted.on) armIdle()
  controlMode.subscribe((on) => {
    if (on) {
      if (mounted.on) armIdle()
      return
    }
    cancelIdle?.()
    cancelIdle = null
    if (!mounted.on) log('[canvas] mounted')
    mounted.set(true)
  })
  return { get on() { return mounted.on }, subscribe: mounted.subscribe }
}

const VIEW_KEY = 'mobile.view'

/**
 * Which view the page was last on, Control's transcript or the canvas, kept
 * across a reload (sessionStorage is the web view's, and goes with the app):
 * a reload after a dropped connection goes back to it, and a fresh start —
 * nothing kept — opens on the transcript.
 */
export function rememberView(view: 'control' | 'canvas'): void {
  try { sessionStorage.setItem(VIEW_KEY, view) } catch { /* private mode */ }
}

export function lastView(): 'control' | 'canvas' {
  try { return sessionStorage.getItem(VIEW_KEY) === 'canvas' ? 'canvas' : 'control' } catch { return 'control' }
}
