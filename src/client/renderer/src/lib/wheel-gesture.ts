import { WHEEL_DECAY_MS, HORIZONTAL_SCROLL_THRESHOLD, PINCH_ZOOM_THRESHOLD } from './constants'

export interface WheelAccumulator { dx: number; dy: number; t: number }

export function createWheelAccumulator(): WheelAccumulator {
  return { dx: 0, dy: 0, t: 0 }
}

export type WheelGesture = 'vertical' | 'horizontal' | 'pinch'

/** Classify a wheel event. Updates accumulator in place. */
export function classifyWheelEvent(acc: WheelAccumulator, ev: WheelEvent): WheelGesture {
  if (ev.ctrlKey && Math.abs(ev.deltaY) > PINCH_ZOOM_THRESHOLD) return 'pinch'

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
