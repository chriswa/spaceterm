import { useCallback, useRef, useState } from 'react'
import { Camera, panCamera, zoomCamera } from '../lib/camera'

const INITIAL_CAMERA: Camera = { x: 0, y: 0, z: 1 }

export function useCamera() {
  const [camera, setCamera] = useState<Camera>(INITIAL_CAMERA)
  const cameraRef = useRef(camera)
  cameraRef.current = camera

  const handleWheel = useCallback((e: WheelEvent) => {
    e.preventDefault()

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
    setCamera(INITIAL_CAMERA)
  }, [])

  return { camera, handleWheel, resetCamera, setCamera }
}
