import { useCallback, useEffect, useRef } from 'react'
import { getCameraTransform, type Camera } from '../lib/camera'
import { DEFERRED_SCALE_LIMIT, isDeferringCameraScale } from '../hooks/useCamera'

interface CanvasProps {
  camera: Camera
  surfaceRef?: React.RefObject<HTMLDivElement>
  onWheel: (e: WheelEvent) => void
  onPanStart: (e: MouseEvent) => void
  onRtsSelectStart?: (e: MouseEvent) => void
  onZoomDragStart?: (e: MouseEvent) => void
  onCanvasClick: (e: MouseEvent) => void
  onDoubleClick: () => void
  background?: React.ReactNode
  overlay?: React.ReactNode
  children: React.ReactNode
}

/**
 * Have Chromium redraw the desktop's surface at the settled zoom once the zoom
 * has moved a factor of DEFERRED_SCALE_LIMIT from where it was last drawn.
 *
 * `.canvas-surface` is `will-change: transform`, so the camera moves it on the
 * compositor without repainting the cards. The cost is that Chromium keeps the
 * layer at the raster scale it was first drawn at: a surface first drawn at
 * zoom 1 and then zoomed out to 0.05 is still tiled at zoom 1, which is 400
 * screens of tiles for one screen of view. GPU tile memory runs out, every pan
 * re-rasterizes what was evicted, and cards draw with missing tiles until the
 * page is reloaded at the new zoom. Dropping `will-change` for a frame drops the
 * layer, and restoring it makes a new one at the current scale.
 */
function useRasterScaleRelock(surfaceRef: React.RefObject<HTMLDivElement> | undefined, zoom: number, enabled: boolean): void {
  const drawnAtRef = useRef(zoom)
  useEffect(() => {
    const surface = surfaceRef?.current
    if (!enabled || !surface) return
    const ratio = zoom / drawnAtRef.current
    if (ratio < DEFERRED_SCALE_LIMIT && ratio > 1 / DEFERRED_SCALE_LIMIT) return
    drawnAtRef.current = zoom
    surface.style.willChange = 'auto'
    // Two frames: one committed without the layer, then the layer back.
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => { surface.style.willChange = '' })
    })
    return () => {
      cancelAnimationFrame(frame)
      surface.style.willChange = ''
    }
  }, [surfaceRef, zoom, enabled])
}

export function Canvas({ camera, surfaceRef, onWheel, onPanStart, onRtsSelectStart, onZoomDragStart, onCanvasClick, onDoubleClick, background, overlay, children }: CanvasProps) {
  const viewportRef = useRef<HTMLDivElement>(null)
  // The phone scales a drawing it redraws itself; see deferCameraScaleWhileMoving.
  useRasterScaleRelock(surfaceRef, camera.z, !isDeferringCameraScale())

  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return

    // Must use addEventListener with passive: false so we can preventDefault
    viewport.addEventListener('wheel', onWheel, { passive: false })
    return () => viewport.removeEventListener('wheel', onWheel)
  }, [onWheel])

  // Prevent focus-induced scroll on the viewport. Browser focus() auto-scrolls
  // overflow:hidden containers, which shifts the WebGL background canvas off-screen.
  // The camera system manages positioning via CSS transforms, never scroll offsets.
  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    const resetScroll = () => { viewport.scrollLeft = 0; viewport.scrollTop = 0 }
    viewport.addEventListener('scroll', resetScroll)
    return () => viewport.removeEventListener('scroll', resetScroll)
  }, [])

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0 && e.button !== 2) return
    if ((e.target as HTMLElement).closest('.canvas-node')) return

    // Right-button drag on the background → zoom
    if (e.button === 2) {
      if (onZoomDragStart) {
        e.preventDefault()
        onZoomDragStart(e.nativeEvent)
      }
      return
    }

    // Shift+drag starts RTS select instead of pan
    if (e.shiftKey && onRtsSelectStart) {
      onRtsSelectStart(e.nativeEvent)
      return
    }

    const startX = e.clientX
    const startY = e.clientY
    let didDrag = false

    onPanStart(e.nativeEvent)

    const onMouseMove = (ev: MouseEvent) => {
      if (Math.abs(ev.clientX - startX) > 3 || Math.abs(ev.clientY - startY) > 3) {
        didDrag = true
      }
    }

    const onMouseUp = (ev: MouseEvent) => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
      if (!didDrag) {
        onCanvasClick(ev)
      }
    }

    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
  }, [onPanStart, onRtsSelectStart, onZoomDragStart, onCanvasClick])

  const handleDoubleClick = useCallback((e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('.canvas-node')) return
    onDoubleClick()
  }, [onDoubleClick])

  // Suppress the native context menu over the background so right-button
  // drag can be used for zoom without popping a menu.
  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('.canvas-node')) return
    e.preventDefault()
  }, [])

  return (
    <div className="canvas-viewport" ref={viewportRef} onMouseDown={handleMouseDown} onContextMenu={handleContextMenu} onDoubleClick={handleDoubleClick}>
      {background}
      {isDeferringCameraScale() ? (
        // The phone: the zoom layer moves the surface while the camera does,
        // so the cards are scaled as drawn rather than redrawn at every scale;
        // see deferCameraScaleWhileMoving. The surface's transform is the
        // camera's, written by useCamera's applyToDOM and nowhere else, and
        // its glows' counter-scale comes from mobile.css.
        <div className="canvas-zoom-layer">
          <div ref={surfaceRef} className="canvas-surface" style={{ transformOrigin: '0 0' }}>
            {children}
          </div>
        </div>
      ) : (
        <div
          ref={surfaceRef}
          className="canvas-surface"
          style={{
            transform: getCameraTransform(camera),
            transformOrigin: '0 0',
            // Counter-scale for anything that must keep its on-screen size while
            // the surface is scaled by the camera — card glows, today. Declared
            // here because this is the one element that already re-renders on
            // every camera change, so it costs nothing extra and is inherited by
            // every card, rather than each of them reading the zoom per frame.
            // Settled values only: deriving it from the per-frame --camera-zoom
            // re-rasterized every glow's blur on every frame of a zoom, and the
            // desktop's zooming stuttered and its labels flickered.
            '--glow-scale': String(Math.max(1, 1 / camera.z)),
            // The settled zoom, which the desktop memory probe logs
            // (lib/page-memory.ts).
            '--settled-camera-zoom': String(camera.z),
          } as React.CSSProperties}
        >
          {children}
        </div>
      )}
      {overlay}
    </div>
  )
}
