import { useCallback, useRef, useState, createElement } from 'react'
import type { MutableRefObject, ReactNode } from 'react'
import { screenToCanvas } from '../lib/camera'
import type { Camera } from '../lib/camera'
import { ZOOM_DRAG_SENSITIVITY } from '../lib/constants'
import { currentFacet } from './useFacet'

type Point = { x: number; y: number }

/** One zoom drag in progress; see `useZoomDrag`. */
export interface ZoomDrag {
  /** The pointer is now here, in client coordinates. */
  move(point: Point): void
  end(): void
}

const ANCHOR_RADIUS_PX = 5

/**
 * Drag-to-zoom about a fixed point: the desktop's right-button drag on the
 * background, and the phone's long press on it.
 *
 * Logarithmic, like cmd+scroll: radial distance from the anchor maps to a zoom
 * *ratio*, so equal drag distances produce equal zoom multiples regardless of
 * the current zoom. Any direction zooms out; coming back toward the anchor
 * returns to the zoom it started at. The anchor is the zoom's fixed point, so
 * it stays under where the drag began.
 *
 * While it runs, the overlay marks the anchor with a dot and draws a line from
 * it to the pointer — something to hold on to while everything else scales.
 * Both are moved directly on the DOM, so a drag does not re-render the canvas.
 */
export function useZoomDrag(
  cameraRef: MutableRefObject<Camera>,
  zoom: (anchor: Point, z: number) => void
): {
  begin: (anchor: Point) => ZoomDrag
  overlayElement: ReactNode
} {
  const [active, setActive] = useState(false)
  /** Both in the viewport's own coordinates, which the overlay is drawn in. */
  const anchorRef = useRef<Point>({ x: 0, y: 0 })
  const pointerRef = useRef<Point>({ x: 0, y: 0 })
  const colorRef = useRef('currentColor')
  const lineRef = useRef<SVGLineElement>(null)
  const zoomRef = useRef(zoom)
  zoomRef.current = zoom

  const begin = useCallback((anchor: Point): ZoomDrag => {
    const startZ = cameraRef.current.z
    const origin = document.querySelector('.canvas-viewport')?.getBoundingClientRect() ?? { left: 0, top: 0 }
    const local = (p: Point): Point => ({ x: p.x - origin.left, y: p.y - origin.top })
    anchorRef.current = pointerRef.current = local(anchor)
    // The anchor is the zoom's fixed point, so its world position — and the
    // tint there — holds for the whole drag.
    const world = screenToCanvas(anchorRef.current, cameraRef.current)
    colorRef.current = currentFacet('nodeTint').borderColor(world.x, world.y)
    setActive(true)
    let ended = false
    return {
      move(point) {
        if (ended) return
        // Distance is always >= 0, so this only ever zooms out from startZ.
        const dist = Math.hypot(point.x - anchor.x, point.y - anchor.y)
        zoomRef.current(anchor, startZ * Math.exp(-dist * ZOOM_DRAG_SENSITIVITY))
        pointerRef.current = local(point)
        lineRef.current?.setAttribute('x2', String(pointerRef.current.x))
        lineRef.current?.setAttribute('y2', String(pointerRef.current.y))
      },
      end() {
        if (ended) return
        ended = true
        setActive(false)
      }
    }
  }, [cameraRef])

  const anchor = anchorRef.current
  const pointer = pointerRef.current
  const overlayElement = active
    ? createElement('svg', {
        className: 'zoom-drag-overlay',
        style: { color: colorRef.current },
      },
        createElement('line', { ref: lineRef, x1: anchor.x, y1: anchor.y, x2: pointer.x, y2: pointer.y }),
        createElement('circle', { cx: anchor.x, cy: anchor.y, r: ANCHOR_RADIUS_PX }),
      )
    : null

  return { begin, overlayElement }
}
