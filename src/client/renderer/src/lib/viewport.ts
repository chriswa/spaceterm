import type { Camera } from './camera'

/**
 * Which cards are close enough to the viewport to be worth drawing.
 *
 * Unfocused terminal cards repaint from a server snapshot up to ten times a
 * second between them, and a repaint costs one fillText per glyph. Doing that
 * for a card sitting two screens away is pure waste — the canvas it draws into
 * is not composited anywhere the user can see.
 *
 * This is a pure function of camera + geometry so the rule can be tested
 * directly, and so there is one definition of "on screen" rather than one per
 * call site.
 */

/** A card's footprint in world units, centred on (x, y) — the same convention
 *  `onNodeReady` reports and `terminalPixelSize` measures. */
export interface WorldRect {
  x: number
  y: number
  width: number
  height: number
}

export interface ViewportSize {
  width: number
  height: number
}

/**
 * How far outside the viewport a card still counts as visible, as a multiple of
 * the viewport's own size on each edge.
 *
 * Not zero, because the camera only syncs into React state `CAMERA_SETTLE_DELAY`
 * after motion stops: during a fast pan nothing re-evaluates visibility, so a
 * card that enters the viewport mid-pan would show whatever was last painted
 * until the camera settles. One screen of slack means a card is already being
 * kept current well before it can be panned into view.
 */
export const VIEWPORT_MARGIN = 1

/**
 * Does this card overlap the viewport, inflated by `margin` screens on each
 * edge? Degenerate viewports (a zero-size window, which is what a jsdom test or
 * a minimised window reports) count everything as visible rather than nothing,
 * so a measurement failure can never silently freeze every card.
 */
export function isCardOnScreen(
  rect: WorldRect,
  camera: Camera,
  viewport: ViewportSize,
  margin = VIEWPORT_MARGIN
): boolean {
  if (!(viewport.width > 0) || !(viewport.height > 0)) return true

  // World rect → screen rect. canvasToScreen is inlined rather than called
  // twice: the bottom-right corner is the top-left plus the scaled size.
  const left = (rect.x - rect.width / 2) * camera.z + camera.x
  const top = (rect.y - rect.height / 2) * camera.z + camera.y
  const right = left + rect.width * camera.z
  const bottom = top + rect.height * camera.z

  const padX = viewport.width * margin
  const padY = viewport.height * margin

  return (
    right >= -padX &&
    left <= viewport.width + padX &&
    bottom >= -padY &&
    top <= viewport.height + padY
  )
}
