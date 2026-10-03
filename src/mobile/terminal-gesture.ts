/**
 * What one touch on the full-screen terminal means.
 *
 * - **Drag up or down** scrolls — sent to the terminal as wheel events, so the
 *   TUI (or the shell's scrollback) decides what scrolling is, as it does for a
 *   trackpad on the desktop.
 * - **Drag left or right** past a threshold leaves for the canvas the moment
 *   it gets there, and the rest of the drag pans the canvas. A quicker flick
 *   that falls short leaves on release.
 * - **Pinch in** (zoom out) leaves too, after only a little closing, since
 *   nothing else uses two fingers here; the rest of the pinch zooms the canvas.
 * - **Tap** opens the composer.
 * - **Long press** opens the keyboard for typing straight into the terminal.
 *
 * Tap and long press are decided on release, not on a timer: iOS only lets a
 * page raise the keyboard from inside a touch handler, so the decision has to
 * be made where focus can still be taken.
 *
 * Pure — no DOM — so the rules can be tested without a phone.
 */

/** Movement below this is still a tap or a press. */
export const SLOP_PX = 10
export const LONG_PRESS_MS = 450
/**
 * How far a drag goes before its direction is decided. Later than the tap
 * slop: a thumb's arc often starts out sideways before it settles into the
 * vertical scroll it was meant to be.
 */
export const AXIS_DECISION_PX = 16
/**
 * Sideways must beat vertical by this factor to count as a swipe — within
 * about 27° of horizontal. Anything steeper is a scroll. Biased this hard
 * because scrolling is constant and leaving is occasional, and a scroll
 * mistaken for a swipe throws you out of the terminal.
 */
export const HORIZONTAL_DOMINANCE = 2
/** A horizontal drag this far leaves, then and there, whatever its speed. */
export const EXIT_DISTANCE_PX = 93
/** A shorter one leaves if it is quick — a flick. */
export const FLICK_DISTANCE_PX = 60
export const FLICK_SPEED_PX_PER_MS = 0.6
/** Fingers brought this close, relative to where they started, leaves at once. */
export const PINCH_EXIT_SCALE = 0.9

export type GestureEnd = 'tap' | 'long-press' | 'exit' | 'none'
/**
 * `exit` is reported once, mid-gesture: the touch is over as far as this
 * classifier is concerned, and its remainder belongs to the canvas.
 */
export type GestureMove =
  | { kind: 'scroll'; deltaY: number }
  | { kind: 'swipe'; dx: number }
  | { kind: 'pinch'; scale: number }
  | { kind: 'exit' }
  | { kind: 'none' }

export class TerminalGesture {
  private start: { x: number; y: number; t: number } | null = null
  private last = { x: 0, y: 0 }
  private axis: 'none' | 'vertical' | 'horizontal' | 'pinch' = 'none'
  private pinchStart = 0
  private pinchScale = 1

  begin(x: number, y: number, t: number): void {
    this.start = { x, y, t }
    this.last = { x, y }
    this.axis = 'none'
  }

  /**
   * A second finger came down. From here the touch is a pinch, whatever the
   * first finger was doing; `distance` is the span between the two.
   */
  pinch(distance: number): void {
    if (!this.start) this.start = { x: 0, y: 0, t: 0 }
    this.axis = 'pinch'
    this.pinchStart = Math.max(1, distance)
    this.pinchScale = 1
  }

  pinchMove(distance: number): GestureMove {
    if (this.axis !== 'pinch') return { kind: 'none' }
    this.pinchScale = distance / this.pinchStart
    if (this.pinchScale <= PINCH_EXIT_SCALE) return this.exit()
    return { kind: 'pinch', scale: this.pinchScale }
  }

  move(x: number, y: number): GestureMove {
    if (this.axis === 'pinch') return { kind: 'none' }
    if (!this.start) return { kind: 'none' }
    if (this.axis === 'none') {
      const dx = x - this.start.x
      const dy = y - this.start.y
      if (Math.hypot(dx, dy) < AXIS_DECISION_PX) {
        this.last = { x, y }
        return { kind: 'none' }
      }
      this.axis = Math.abs(dx) >= HORIZONTAL_DOMINANCE * Math.abs(dy) ? 'horizontal' : 'vertical'
      // The first scroll covers the travel made while the direction was undecided.
      this.last = { x: this.start.x, y: this.start.y }
    }
    if (this.axis === 'vertical') {
      // Finger up reveals what is below, as on any touch screen: a positive
      // wheel delta.
      const deltaY = this.last.y - y
      this.last = { x, y }
      return { kind: 'scroll', deltaY }
    }
    this.last = { x, y }
    const dx = x - this.start.x
    if (Math.abs(dx) >= EXIT_DISTANCE_PX && Math.abs(dx) >= HORIZONTAL_DOMINANCE * Math.abs(y - this.start.y)) return this.exit()
    return { kind: 'swipe', dx }
  }

  /** Done here: nothing more from this touch until the next `begin`. */
  private exit(): GestureMove {
    this.start = null
    this.axis = 'none'
    return { kind: 'exit' }
  }

  end(t: number): GestureEnd {
    const start = this.start
    this.start = null
    if (!start) return 'none'
    // A pinch far enough to leave left mid-move; one released short of that stays.
    if (this.axis === 'pinch') return 'none'
    if (this.axis === 'none') {
      // Movement short of a decided direction: within the tap slop it was a
      // tap or a press; past it, an aborted drag that means nothing.
      if (Math.hypot(this.last.x - start.x, this.last.y - start.y) >= SLOP_PX) return 'none'
      return t - start.t >= LONG_PRESS_MS ? 'long-press' : 'tap'
    }
    if (this.axis === 'horizontal') {
      const distance = Math.abs(this.last.x - start.x)
      // Still mostly sideways at the end, or it drifted into a scroll.
      if (distance < HORIZONTAL_DOMINANCE * Math.abs(this.last.y - start.y)) return 'none'
      const speed = distance / Math.max(1, t - start.t)
      if (distance >= FLICK_DISTANCE_PX && speed >= FLICK_SPEED_PX_PER_MS) return 'exit'
    }
    return 'none'
  }

  /** The touch is being held still — for showing that a long press has armed. */
  isStill(): boolean {
    return this.start !== null && this.axis === 'none' &&
      Math.hypot(this.last.x - this.start.x, this.last.y - this.start.y) < SLOP_PX
  }
}
