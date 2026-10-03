/**
 * Where a floating toolbar goes, and how its buttons wrap, so it is always
 * whole on screen — on a phone, a long press near an edge used to leave the
 * bar centred on the finger with half of it off the side.
 *
 * Pure: the toolbar measures itself and asks these.
 */

/** Space kept between the toolbar and the window's edges. */
export const EDGE_PAD = 8

/**
 * How far to move a span [lo, hi] along one axis to bring it inside
 * [pad, size - pad]: not at all if it fits where it is, to the nearest edge if
 * it pokes out, and centred if it is wider than the room.
 */
export function shiftIntoView(lo: number, hi: number, size: number, pad = EDGE_PAD): number {
  if (hi - lo > size - 2 * pad) return size / 2 - (lo + hi) / 2
  if (lo < pad) return pad - lo
  if (hi > size - pad) return size - pad - hi
  return 0
}

/**
 * Buttons per row when `count` buttons in one row of `width` would not fit
 * in `room`, or null when one row fits. Rows are filled evenly — nine buttons
 * in two rows are five and four, never eight and one — so the bar stays a
 * compact block rather than a long row with a straggler under it.
 */
export function buttonsPerRow(count: number, width: number, room: number): number | null {
  if (count <= 1 || width <= room) return null
  const rows = Math.min(count, Math.ceil(width / room))
  return Math.ceil(count / rows)
}
