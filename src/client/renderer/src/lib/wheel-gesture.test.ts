import { describe, it, expect } from 'vitest'
import { createWheelAccumulator, classifyWheelEvent } from './wheel-gesture'

// The classifier decides whether a wheel event stays with the surface under
// the pointer ('vertical') or escapes to the window manager. A focused
// terminal, and the help/search modals, hand every non-vertical gesture to
// the canvas, so these tests pin down which inputs count as an escape.

function wheel(init: Partial<WheelEventInit>): WheelEvent {
  return new WheelEvent('wheel', { deltaX: 0, deltaY: 0, ...init })
}

describe('classifyWheelEvent', () => {
  it('plain vertical scroll stays with the surface', () => {
    expect(classifyWheelEvent(createWheelAccumulator(), wheel({ deltaY: 40 }))).toBe('vertical')
  })

  it('Cmd+wheel is a zoom, even for a single tiny mouse notch', () => {
    // A plain mouse reports ~4px per notch, far below any accumulator threshold.
    expect(classifyWheelEvent(createWheelAccumulator(), wheel({ deltaY: 4, metaKey: true }))).toBe('zoom')
    expect(classifyWheelEvent(createWheelAccumulator(), wheel({ deltaY: -4, metaKey: true }))).toBe('zoom')
  })

  it('trackpad pinch (ctrlKey wheel) is a zoom once it clears the jitter threshold', () => {
    expect(classifyWheelEvent(createWheelAccumulator(), wheel({ deltaY: 10, ctrlKey: true }))).toBe('zoom')
    expect(classifyWheelEvent(createWheelAccumulator(), wheel({ deltaY: 1, ctrlKey: true }))).toBe('vertical')
  })

  it('sideways motion escapes only after it accumulates past the threshold', () => {
    const acc = createWheelAccumulator()
    expect(classifyWheelEvent(acc, wheel({ deltaX: -5, deltaY: 4 }))).toBe('vertical')
    expect(classifyWheelEvent(acc, wheel({ deltaX: -8, deltaY: 4 }))).toBe('vertical')
    expect(classifyWheelEvent(acc, wheel({ deltaX: -8, deltaY: 2 }))).toBe('horizontal')
  })
})
