import { describe, it, expect } from 'vitest'
import { createGate } from './gate'
import { canvasLifecycle, holdCanvas, IDLE_MS } from './canvas-lifecycle'

/** A manual timer: `advance` fires whatever is due. */
function clock() {
  let now = 0
  const timers = new Set<{ at: number; fn: () => void }>()
  return {
    setTimer: (fn: () => void, ms: number) => {
      const t = { at: now + ms, fn }
      timers.add(t)
      return () => { timers.delete(t) }
    },
    advance(ms: number) {
      now += ms
      for (const t of [...timers]) if (t.at <= now) { timers.delete(t); t.fn() }
    },
  }
}

describe('the phone canvas lifecycle', () => {
  it('starts with no canvas on a fresh start, and mounts it on leaving the transcript', () => {
    const control = createGate(true)
    const mounted = canvasLifecycle({ controlMode: control, startMounted: false, setTimer: clock().setTimer })
    expect(mounted.on).toBe(false)
    control.set(false)
    expect(mounted.on).toBe(true)
  })

  it('starts mounted on a reload that was on the canvas', () => {
    const mounted = canvasLifecycle({ controlMode: createGate(false), startMounted: true, setTimer: clock().setTimer })
    expect(mounted.on).toBe(true)
  })

  it('unmounts after five minutes out of sight, and not before', () => {
    const c = clock()
    const control = createGate(false)
    const mounted = canvasLifecycle({ controlMode: control, startMounted: true, setTimer: c.setTimer })
    control.set(true)
    c.advance(IDLE_MS - 1)
    expect(mounted.on).toBe(true)
    c.advance(1)
    expect(mounted.on).toBe(false)
  })

  it('starts the five minutes again each time the canvas is seen', () => {
    const c = clock()
    const control = createGate(false)
    const mounted = canvasLifecycle({ controlMode: control, startMounted: true, setTimer: c.setTimer })
    control.set(true)
    c.advance(IDLE_MS - 1000)
    control.set(false)
    control.set(true)
    c.advance(IDLE_MS - 1000)
    expect(mounted.on).toBe(true)
  })

  it('stays unmounted back on the transcript, and remounts back on the canvas', () => {
    const c = clock()
    const control = createGate(true)
    const mounted = canvasLifecycle({ controlMode: control, startMounted: true, setTimer: c.setTimer })
    c.advance(IDLE_MS)
    expect(mounted.on).toBe(false)
    // The screen going off and on over the transcript is Control mode throughout.
    control.set(true)
    expect(mounted.on).toBe(false)
    control.set(false)
    expect(mounted.on).toBe(true)
  })

  it('keeps a canvas that is held, and lets it go once released', () => {
    const c = clock()
    const control = createGate(false)
    const mounted = canvasLifecycle({ controlMode: control, startMounted: true, setTimer: c.setTimer })
    const release = holdCanvas()
    control.set(true)
    c.advance(IDLE_MS)
    expect(mounted.on).toBe(true)
    release()
    c.advance(IDLE_MS)
    expect(mounted.on).toBe(false)
  })
})
