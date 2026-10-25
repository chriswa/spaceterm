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
 * - A start, a reload included, with the transcript up — it reopens as it was
 *   left (controlTranscriptStore) — mounts no canvas at all, and the canvas
 *   first mounts when you leave the transcript.
 * - Leaving Control mode — closing the transcript, or the screen coming back
 *   on with the canvas or a terminal in front — always mounts it.
 * - The page going out of sight — the screen off, another app in front —
 *   unmounts it at once. After `IDLE_MS` with the transcript up, it is
 *   unmounted too. Coming back to the transcript keeps it unmounted; coming
 *   back to the canvas mounts it again, and App restores the camera and focus
 *   it saved (localStorage), which puts you back on the same view, or in the
 *   same terminal.
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
  /** The page out of sight: part of Control mode, and unmounts at once rather than after `IDLE_MS`. */
  hidden: Gate
  /** Mounted from the start, rather than on first leaving Control mode. */
  startMounted: boolean
  /** Something that must not lose the canvas under it, such as an open composer. */
  pinned?: () => boolean
  setTimer?: (fn: () => void, ms: number) => () => void
  log?: (message: string) => void
}

export function canvasLifecycle({
  controlMode,
  hidden,
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

  const update = () => {
    if (!controlMode.on) {
      cancelIdle?.()
      cancelIdle = null
      if (!mounted.on) log('[canvas] mounted')
      mounted.set(true)
      return
    }
    if (!mounted.on) return
    // Held, it waits out the timer like the transcript does, and looks again after.
    if (hidden.on && !pinned()) {
      cancelIdle?.()
      cancelIdle = null
      log('[canvas] unmounted: page out of sight')
      mounted.set(false)
      return
    }
    armIdle()
  }

  update()
  controlMode.subscribe(update)
  hidden.subscribe(update)
  return { get on() { return mounted.on }, subscribe: mounted.subscribe }
}
