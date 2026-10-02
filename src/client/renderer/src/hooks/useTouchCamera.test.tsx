import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { useTouchCamera, type TouchCameraControls } from './useTouchCamera'

/**
 * jsdom has no `Touch` constructor, so touches are plain objects on a plain
 * event — which is all the hook reads.
 */
function touch(el: Element, type: string, points: Array<[number, number]>, timeStamp?: number): boolean {
  const event = new Event(type, { bubbles: true, cancelable: true })
  const touches = points.map(([clientX, clientY], identifier) => ({ identifier, clientX, clientY }))
  Object.defineProperty(event, 'touches', { value: touches })
  if (timeStamp !== undefined) Object.defineProperty(event, 'timeStamp', { value: timeStamp })
  el.dispatchEvent(event)
  return event.defaultPrevented
}

function Harness({ controls }: { controls: TouchCameraControls }) {
  useTouchCamera('.canvas-viewport', controls)
  return null
}

function setup() {
  const viewport = document.createElement('div')
  viewport.className = 'canvas-viewport'
  document.body.appendChild(viewport)
  const controls = { pan: vi.fn(), zoom: vi.fn(), getZoom: () => 1, onGestureStart: vi.fn(), onLongPress: vi.fn() }
  render(<Harness controls={controls} />)
  return { viewport, controls }
}

afterEach(() => {
  vi.useRealTimers()
  cleanup()
  document.body.innerHTML = ''
})

describe('useTouchCamera', () => {
  it('leaves a tap alone, so it can still become a click', () => {
    const { viewport, controls } = setup()
    touch(viewport, 'touchstart', [[100, 100]])
    const prevented = touch(viewport, 'touchmove', [[103, 102]])
    touch(viewport, 'touchend', [])
    expect(prevented).toBe(false)
    expect(controls.pan).not.toHaveBeenCalled()
    expect(controls.onGestureStart).not.toHaveBeenCalled()
  })

  it('pans with one finger once it passes the slop, opposite to the drag like the mouse', () => {
    const { viewport, controls } = setup()
    touch(viewport, 'touchstart', [[100, 100]])
    expect(touch(viewport, 'touchmove', [[80, 90]])).toBe(true)
    touch(viewport, 'touchmove', [[60, 70]])
    expect(controls.onGestureStart).toHaveBeenCalledTimes(1)
    expect(controls.pan).toHaveBeenLastCalledWith(20, 20)
  })

  it('pinches about the midpoint, scaling the zoom it started from', () => {
    const { viewport, controls } = setup()
    touch(viewport, 'touchstart', [[100, 100], [200, 100]])
    touch(viewport, 'touchmove', [[50, 100], [250, 100]])
    expect(controls.zoom).toHaveBeenLastCalledWith({ x: 150, y: 100 }, 2)
  })

  it('a finger held still is a long press, and its click is suppressed', () => {
    vi.useFakeTimers()
    const { viewport, controls } = setup()
    touch(viewport, 'touchstart', [[120, 140]])
    vi.advanceTimersByTime(499)
    expect(controls.onLongPress).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(controls.onLongPress).toHaveBeenCalledWith({ x: 120, y: 140 })
    expect(touch(viewport, 'touchend', [])).toBe(true)
  })

  it('a finger that moves is not a long press', () => {
    vi.useFakeTimers()
    const { viewport, controls } = setup()
    touch(viewport, 'touchstart', [[120, 140]])
    touch(viewport, 'touchmove', [[150, 140]])
    vi.advanceTimersByTime(1000)
    expect(controls.onLongPress).not.toHaveBeenCalled()
    expect(touch(viewport, 'touchend', [])).toBe(false)
  })

  describe('momentum', () => {
    const fling = (viewport: Element, endAt: number) => {
      touch(viewport, 'touchstart', [[300, 300]], 1000)
      touch(viewport, 'touchmove', [[280, 300]], 1016)
      touch(viewport, 'touchmove', [[240, 300]], 1032)
      touch(viewport, 'touchmove', [[200, 300]], 1048)
      touch(viewport, 'touchend', [], endAt)
    }

    it('a flicked pan keeps going after release, the way the finger was going', () => {
      vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance'] })
      const { viewport, controls } = setup()
      fling(viewport, 1050)
      const duringDrag = controls.pan.mock.calls.length
      vi.advanceTimersByTime(200)
      const glide = controls.pan.mock.calls.slice(duringDrag)
      expect(glide.length).toBeGreaterThan(3)
      // The finger moved left, so the camera keeps moving the way pan() was already being told.
      expect(glide.every(([dx]) => dx > 0)).toBe(true)
      // And it slows.
      expect(glide[glide.length - 1][0]).toBeLessThan(glide[0][0])
    })

    it('a finger that stopped before lifting does not glide', () => {
      vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance'] })
      const { viewport, controls } = setup()
      fling(viewport, 1300)
      const duringDrag = controls.pan.mock.calls.length
      vi.advanceTimersByTime(200)
      expect(controls.pan.mock.calls.length).toBe(duringDrag)
    })

    it('a new touch catches a glide in progress', () => {
      vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance'] })
      const { viewport, controls } = setup()
      fling(viewport, 1050)
      vi.advanceTimersByTime(50)
      touch(viewport, 'touchstart', [[100, 100]], 1200)
      const caught = controls.pan.mock.calls.length
      vi.advanceTimersByTime(500)
      expect(controls.pan.mock.calls.length).toBe(caught)
    })
  })
})
