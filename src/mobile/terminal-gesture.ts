/**
 * What one touch on the full-screen terminal means.
 *
 * - **Drag up or down** scrolls — sent to the terminal as wheel events, so the
 *   TUI (or the shell's scrollback) decides what scrolling is, as it does for a
 *   trackpad on the desktop.
 * - **Flick left or right** past a threshold leaves for the canvas.
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
/** A horizontal drag this far leaves, whatever its speed. */
export const EXIT_DISTANCE_PX = 110
/** A shorter one leaves if it is quick — a flick. */
export const FLICK_DISTANCE_PX = 50
export const FLICK_SPEED_PX_PER_MS = 0.5

export type GestureEnd = 'tap' | 'long-press' | 'exit' | 'none'
export type GestureMove = { kind: 'scroll'; deltaY: number } | { kind: 'swipe'; dx: number } | { kind: 'none' }

export class TerminalGesture {
  private start: { x: number; y: number; t: number } | null = null
  private last = { x: 0, y: 0 }
  private axis: 'none' | 'vertical' | 'horizontal' = 'none'

  begin(x: number, y: number, t: number): void {
    this.start = { x, y, t }
    this.last = { x, y }
    this.axis = 'none'
  }

  move(x: number, y: number): GestureMove {
    if (!this.start) return { kind: 'none' }
    if (this.axis === 'none') {
      const dx = x - this.start.x
      const dy = y - this.start.y
      if (Math.hypot(dx, dy) < SLOP_PX) return { kind: 'none' }
      this.axis = Math.abs(dy) >= Math.abs(dx) ? 'vertical' : 'horizontal'
    }
    if (this.axis === 'vertical') {
      // Finger up reveals what is below, as on any touch screen: a positive
      // wheel delta.
      const deltaY = this.last.y - y
      this.last = { x, y }
      return { kind: 'scroll', deltaY }
    }
    this.last = { x, y }
    return { kind: 'swipe', dx: x - this.start.x }
  }

  end(t: number): GestureEnd {
    const start = this.start
    this.start = null
    if (!start) return 'none'
    if (this.axis === 'none') return t - start.t >= LONG_PRESS_MS ? 'long-press' : 'tap'
    if (this.axis === 'horizontal') {
      const distance = Math.abs(this.last.x - start.x)
      const speed = distance / Math.max(1, t - start.t)
      if (distance >= EXIT_DISTANCE_PX) return 'exit'
      if (distance >= FLICK_DISTANCE_PX && speed >= FLICK_SPEED_PX_PER_MS) return 'exit'
    }
    return 'none'
  }

  /** The touch is being held still — for showing that a long press has armed. */
  isStill(): boolean {
    return this.start !== null && this.axis === 'none'
  }
}
