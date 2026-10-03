/**
 * A radial menu around a thumb: where its options sit, and which one the
 * thumb is pointing at. Pure, so the geometry can be tested without a phone.
 *
 * Options fan out over the arc above the thumb, where they are not under it.
 * The whole menu is moved in from any screen edge it would cross; the thumb
 * stays where it is, so near an edge it may already sit over an option and
 * releasing there picks it — acceptable, and better than an option off-screen.
 */

export interface Point { x: number; y: number }

export interface RadialLayout {
  /** The menu's centre, after keeping it on screen. */
  center: Point
  /** Each option's centre. */
  items: Point[]
}

/** From the menu's centre to each option's. */
export const RADIUS = 92
/** Each option's diameter. */
export const BUBBLE = 72
/** A thumb this close to the centre points at nothing: release there to cancel. */
export const DEAD_ZONE = 34
/** Space kept from the screen's edges. */
const EDGE = 8

/** The arc the options share: above the thumb, from upper left to upper right. */
const ARC_START = -160 * (Math.PI / 180)
const ARC_SPAN = 140 * (Math.PI / 180)

function angles(count: number): number[] {
  return Array.from({ length: count }, (_, i) => ARC_START + ((i + 0.5) * ARC_SPAN) / count)
}

const clamp = (v: number, lo: number, hi: number) => (lo > hi ? (lo + hi) / 2 : Math.min(hi, Math.max(lo, v)))

export function layoutRadial(count: number, at: Point, screen: { width: number; height: number }): RadialLayout {
  const offsets = angles(count).map((a) => ({ x: Math.cos(a) * RADIUS, y: Math.sin(a) * RADIUS }))
  const r = BUBBLE / 2
  const xs = offsets.map((o) => o.x)
  const ys = offsets.map((o) => o.y)
  const center = {
    x: clamp(at.x, EDGE + r - Math.min(0, ...xs), screen.width - EDGE - r - Math.max(0, ...xs)),
    y: clamp(at.y, EDGE + r - Math.min(0, ...ys), screen.height - EDGE - r - Math.max(0, ...ys))
  }
  return { center, items: offsets.map((o) => ({ x: center.x + o.x, y: center.y + o.y })) }
}

/**
 * The option a thumb at `point` is pointing at, or null in the dead zone or
 * pointing away from every option. By direction from the centre, not by
 * landing on a bubble: a flick of the thumb towards one is enough.
 */
export function pickRadial(layout: RadialLayout, point: Point): number | null {
  const dx = point.x - layout.center.x
  const dy = point.y - layout.center.y
  if (Math.hypot(dx, dy) < DEAD_ZONE) return null
  const heading = Math.atan2(dy, dx)
  let best: number | null = null
  let bestDiff = Infinity
  layout.items.forEach((item, i) => {
    const a = Math.atan2(item.y - layout.center.y, item.x - layout.center.x)
    let diff = Math.abs(heading - a)
    if (diff > Math.PI) diff = 2 * Math.PI - diff
    if (diff < bestDiff) {
      bestDiff = diff
      best = i
    }
  })
  // Pointing well away from all of them — down, say — is no choice at all.
  return bestDiff <= Math.PI / 4 + ARC_SPAN / (2 * Math.max(1, layout.items.length)) ? best : null
}
