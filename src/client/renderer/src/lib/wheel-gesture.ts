import { WHEEL_DECAY_MS, HORIZONTAL_SCROLL_THRESHOLD, PINCH_ZOOM_THRESHOLD } from './constants'

export interface WheelAccumulator { dx: number; dy: number; t: number }

export function createWheelAccumulator(): WheelAccumulator {
  return { dx: 0, dy: 0, t: 0 }
}

export type WheelGesture = 'vertical' | 'horizontal' | 'zoom'

/**
 * Classify a wheel event. Updates accumulator in place.
 *
 * Only 'vertical' belongs to whatever is under the pointer (terminal
 * scrollback, a modal's list). 'horizontal' and 'zoom' always go to the
 * window manager, so they are how a wheel breaks out of a focused surface.
 *
 * 'zoom' is a trackpad pinch (macOS reports it as a ctrlKey wheel) or any
 * wheel with Command held. Cmd+wheel is the mouse user's zoom: a plain mouse
 * has no pinch, and its sideways jitter rarely clears the horizontal
 * threshold, so without this rule Cmd+scroll over a focused terminal would
 * just scroll the terminal.
 */
export function classifyWheelEvent(acc: WheelAccumulator, ev: WheelEvent): WheelGesture {
  if (ev.metaKey) return 'zoom'
  if (ev.ctrlKey && Math.abs(ev.deltaY) > PINCH_ZOOM_THRESHOLD) return 'zoom'

  const now = performance.now()
  const dt = now - acc.t
  const decay = acc.t === 0 ? 0 : Math.exp(-dt / WHEEL_DECAY_MS)
  acc.dx = acc.dx * decay + Math.abs(ev.deltaX)
  acc.dy = acc.dy * decay + Math.abs(ev.deltaY)
  acc.t = now

  if (acc.dx > HORIZONTAL_SCROLL_THRESHOLD && acc.dx > acc.dy) {
    acc.dx = 0
    acc.dy = 0
    return 'horizontal'
  }
  return 'vertical'
}
