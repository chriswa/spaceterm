import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { useCamera } from './useCamera'
import { ZOOMING_HIDE_BELOW, ZOOMING_SETTLE_MS } from '../lib/constants'

let camera: ReturnType<typeof useCamera> | undefined

function Surface() {
  camera = useCamera()
  return <div data-testid="surface" ref={camera.surfaceRef} />
}

afterEach(() => {
  cleanup()
  localStorage.clear()
  vi.useRealTimers()
})

describe('the zooming mark on the canvas surface', () => {
  it('is set while the zoom changes below ZOOMING_HIDE_BELOW, and cleared once it holds still', () => {
    vi.useFakeTimers()
    localStorage.setItem('spaceterm-camera', JSON.stringify({ x: 0, y: 0, z: ZOOMING_HIDE_BELOW / 2 }))
    const { getByTestId } = render(<Surface />)
    const surface = getByTestId('surface')
    expect(surface.hasAttribute('data-zooming')).toBe(false)
    act(() => camera!.userZoom({ x: 0, y: 0 }, ZOOMING_HIDE_BELOW / 3))
    expect(surface.hasAttribute('data-zooming')).toBe(true)
    act(() => { vi.advanceTimersByTime(ZOOMING_SETTLE_MS + 1) })
    expect(surface.hasAttribute('data-zooming')).toBe(false)
    // A pan repaints nothing at a new scale.
    act(() => camera!.userPan(40, 0))
    expect(surface.hasAttribute('data-zooming')).toBe(false)
  })

  it('is never set zoomed in, where cards are read', () => {
    localStorage.setItem('spaceterm-camera', JSON.stringify({ x: 0, y: 0, z: 1 }))
    const { getByTestId } = render(<Surface />)
    act(() => camera!.userZoom({ x: 0, y: 0 }, 0.9))
    expect(getByTestId('surface').hasAttribute('data-zooming')).toBe(false)
  })
})
