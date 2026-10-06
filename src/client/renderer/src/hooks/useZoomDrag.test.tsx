import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, act } from '@testing-library/react'
import { useRef } from 'react'
import { useZoomDrag, type ZoomDrag } from './useZoomDrag'
import { ZOOM_DRAG_SENSITIVITY } from '../lib/constants'
import type { Camera } from '../lib/camera'

function setup(startZ = 2) {
  const zoom = vi.fn()
  let begin!: (anchor: { x: number; y: number }) => ZoomDrag
  function Harness() {
    const cameraRef = useRef<Camera>({ x: 0, y: 0, z: startZ })
    const drag = useZoomDrag(cameraRef, zoom)
    begin = drag.begin
    return <div className="canvas-viewport">{drag.overlayElement}</div>
  }
  const { container } = render(<Harness />)
  const overlay = () => container.querySelector('.zoom-drag-overlay')
  const start = (x: number, y: number): ZoomDrag => {
    let drag!: ZoomDrag
    act(() => { drag = begin({ x, y }) })
    return drag
  }
  return { zoom, begin: start, overlay }
}

afterEach(cleanup)

describe('useZoomDrag', () => {
  it('zooms out about the anchor by the distance moved, in any direction', () => {
    const { zoom, begin } = setup(2)
    const drag = begin(100, 100)
    drag.move({ x: 100, y: 200 })
    expect(zoom).toHaveBeenLastCalledWith({ x: 100, y: 100 }, 2 * Math.exp(-100 * ZOOM_DRAG_SENSITIVITY))
    drag.move({ x: 0, y: 100 })
    expect(zoom).toHaveBeenLastCalledWith({ x: 100, y: 100 }, 2 * Math.exp(-100 * ZOOM_DRAG_SENSITIVITY))
    drag.move({ x: 100, y: 100 })
    expect(zoom).toHaveBeenLastCalledWith({ x: 100, y: 100 }, 2)
  })

  it('marks the anchor and draws a line to the pointer while it runs', () => {
    const { begin, overlay } = setup()
    expect(overlay()).toBeNull()
    const drag = begin(40, 60)
    const circle = overlay()?.querySelector('circle')
    expect(circle?.getAttribute('cx')).toBe('40')
    expect(circle?.getAttribute('cy')).toBe('60')
    drag.move({ x: 90, y: 20 })
    const line = overlay()?.querySelector('line')
    expect([line?.getAttribute('x1'), line?.getAttribute('y1')]).toEqual(['40', '60'])
    expect([line?.getAttribute('x2'), line?.getAttribute('y2')]).toEqual(['90', '20'])
    act(() => drag.end())
    expect(overlay()).toBeNull()
  })

  it('ignores the pointer once ended', () => {
    const { zoom, begin } = setup()
    const drag = begin(0, 0)
    act(() => drag.end())
    drag.move({ x: 50, y: 0 })
    expect(zoom).not.toHaveBeenCalled()
  })
})
