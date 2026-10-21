/**
 * Marks an element that handles its own drags, pinches and scrolls, such as
 * the full-size picture viewer. The gestures that close a screen from
 * anywhere on it (a sideways drag on the phone, a sideways scroll on the Mac)
 * leave alone any gesture that starts inside one.
 */
export const GESTURE_OWNER_ATTR = 'data-owns-gestures'

/** Whether a gesture starting on `target` belongs to an element marked with `GESTURE_OWNER_ATTR`. */
export function ownsGestures(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(`[${GESTURE_OWNER_ATTR}]`) !== null
}
