/**
 * The zoom and offset of a picture fitted to a frame, as the full-size
 * picture viewer pinches and drags it. Points are in px from the frame's
 * centre, where the fitted picture's centre sits at rest.
 */

/** Drawn `scale` times its fitted size, its centre `x`, `y` px from the frame's. */
export interface PanZoom { scale: number; x: number; y: number }

/** The fitted picture's size and its frame's. */
export interface Frame { width: number; height: number; frameWidth: number; frameHeight: number }

export interface Point { x: number; y: number }

export const FITTED: PanZoom = { scale: 1, x: 0, y: 0 }
/** The most a picture is zoomed past its fitted size. */
export const MAX_SCALE = 8

function within(value: number, limit: number): number {
  return Math.max(-limit, Math.min(limit, value))
}

/**
 * `view` kept in bounds: never smaller than fitted, and never moved further
 * than its edges reach, so a picture smaller than the frame stays centred.
 */
export function clampView(view: PanZoom, frame: Frame): PanZoom {
  const scale = Math.max(1, Math.min(MAX_SCALE, view.scale))
  const reachX = Math.max(0, (frame.width * scale - frame.frameWidth) / 2)
  const reachY = Math.max(0, (frame.height * scale - frame.frameHeight) / 2)
  return { scale, x: within(view.x, reachX), y: within(view.y, reachY) }
}

/** Zoomed by `factor` about `at`, keeping the part of the picture under `at` there. */
export function zoomAbout(view: PanZoom, factor: number, at: Point, frame: Frame): PanZoom {
  const scale = Math.max(1, Math.min(MAX_SCALE, view.scale * factor))
  const k = scale / view.scale
  return clampView({ scale, x: at.x - (at.x - view.x) * k, y: at.y - (at.y - view.y) * k }, frame)
}

export function panBy(view: PanZoom, dx: number, dy: number, frame: Frame): PanZoom {
  return clampView({ ...view, x: view.x + dx, y: view.y + dy }, frame)
}

/**
 * One step of a two-finger pinch, from the fingers at `before` to `after`:
 * zoomed by how far they spread, about where they were, and moved as far as
 * their midpoint moved.
 */
export function pinch(view: PanZoom, before: [Point, Point], after: [Point, Point], frame: Frame): PanZoom {
  const spread = (pair: [Point, Point]) => Math.hypot(pair[0].x - pair[1].x, pair[0].y - pair[1].y)
  const mid = (pair: [Point, Point]) => ({ x: (pair[0].x + pair[1].x) / 2, y: (pair[0].y + pair[1].y) / 2 })
  const from = spread(before)
  const zoomed = from > 0 ? zoomAbout(view, spread(after) / from, mid(before), frame) : view
  const [m0, m1] = [mid(before), mid(after)]
  return panBy(zoomed, m1.x - m0.x, m1.y - m0.y, frame)
}
