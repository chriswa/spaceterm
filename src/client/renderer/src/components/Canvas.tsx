import { useCallback, useEffect, useRef } from 'react'
import { getCameraTransform } from '../lib/camera'
import type { Camera } from '../lib/camera'

interface CanvasProps {
  camera: Camera
  surfaceRef?: React.RefObject<HTMLDivElement | null>
  onWheel: (e: WheelEvent) => void
  onPanStart: (e: MouseEvent) => void
  onCanvasClick: (e: MouseEvent) => void
  onDoubleClick: () => void
  background?: React.ReactNode
  overlay?: React.ReactNode
  children: React.ReactNode
}

export function Canvas({ camera, surfaceRef, onWheel, onPanStart, onCanvasClick, onDoubleClick, background, overlay, children }: CanvasProps) {
  const viewportRef = useRef<HTMLDivElement>(null)

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
    if (e.button !== 0) return
    if ((e.target as HTMLElement).closest('.canvas-node')) return

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
  }, [onPanStart, onCanvasClick])

  const handleDoubleClick = useCallback((e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('.canvas-node')) return
    onDoubleClick()
  }, [onDoubleClick])

  return (
    <div className="canvas-viewport" ref={viewportRef} onMouseDown={handleMouseDown} onDoubleClick={handleDoubleClick}>
      {background}
      <div
        ref={surfaceRef}
        className="canvas-surface"
        style={{ transform: getCameraTransform(camera), transformOrigin: '0 0' }}
      >
        {children}
      </div>
      {overlay}
    </div>
  )
}
