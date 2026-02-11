import { useEffect, useRef } from 'react'
import { getCameraTransform } from '../lib/camera'
import type { Camera } from '../lib/camera'

interface CanvasProps {
  camera: Camera
  onWheel: (e: WheelEvent) => void
  children: React.ReactNode
}

export function Canvas({ camera, onWheel, children }: CanvasProps) {
  const viewportRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return

    // Must use addEventListener with passive: false so we can preventDefault
    viewport.addEventListener('wheel', onWheel, { passive: false })
    return () => viewport.removeEventListener('wheel', onWheel)
  }, [onWheel])

  return (
    <div className="canvas-viewport" ref={viewportRef}>
      <div
        className="canvas-surface"
        style={{ transform: getCameraTransform(camera), transformOrigin: '0 0' }}
      >
        {children}
      </div>
    </div>
  )
}
