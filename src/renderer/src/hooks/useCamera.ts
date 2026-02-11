import { useCallback, useEffect, useRef, useState } from 'react'
import { Camera, panCamera, zoomCamera } from '../lib/camera'

const DEFAULT_CAMERA: Camera = { x: 0, y: 0, z: 1 }
const ANIMATION_DURATION = 300

interface CameraTarget {
  from: Camera
  to: Camera
  startedAt: number
}

function easeOutCubic(t: number): number {
  return 1 - (1 - t) ** 3
}

function lerpCamera(from: Camera, to: Camera, t: number): Camera {
  return {
    x: from.x + (to.x - from.x) * t,
    y: from.y + (to.y - from.y) * t,
    z: from.z + (to.z - from.z) * t
  }
}

export function useCamera(initialCamera?: Camera) {
  const [camera, setCamera] = useState<Camera>(initialCamera ?? DEFAULT_CAMERA)
  const cameraRef = useRef(camera)
  cameraRef.current = camera

  const targetRef = useRef<CameraTarget | null>(null)
  const rafRef = useRef<number>(0)

  // Animation loop
  useEffect(() => {
    function tick() {
      const target = targetRef.current
      if (!target) return

      const elapsed = performance.now() - target.startedAt
      const t = Math.min(elapsed / ANIMATION_DURATION, 1)
      const eased = easeOutCubic(t)
      const cam = lerpCamera(target.from, target.to, eased)
      setCamera(cam)

      if (t >= 1) {
        targetRef.current = null
      } else {
        rafRef.current = requestAnimationFrame(tick)
      }
    }

    if (targetRef.current) {
      rafRef.current = requestAnimationFrame(tick)
    }

    return () => cancelAnimationFrame(rafRef.current)
  })

  const animateTo = useCallback((to: Camera) => {
    cancelAnimationFrame(rafRef.current)
    targetRef.current = {
      from: cameraRef.current,
      to,
      startedAt: performance.now()
    }
  }, [])

  const handleWheel = useCallback((e: WheelEvent) => {
    e.preventDefault()

    // Cancel any in-flight animation
    targetRef.current = null
    cancelAnimationFrame(rafRef.current)

    const point = { x: e.clientX, y: e.clientY }

    if (e.ctrlKey || e.metaKey) {
      // Pinch-to-zoom or Ctrl+scroll
      setCamera((cam) => zoomCamera(cam, point, e.deltaY))
    } else {
      // Pan
      setCamera((cam) => panCamera(cam, e.deltaX, e.deltaY))
    }
  }, [])

  const resetCamera = useCallback(() => {
    targetRef.current = null
    cancelAnimationFrame(rafRef.current)
    setCamera(DEFAULT_CAMERA)
  }, [])

  return { camera, handleWheel, resetCamera, setCamera, animateTo }
}
