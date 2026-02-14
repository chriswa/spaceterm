import { useCallback, useEffect, useRef, useState } from 'react'
import { Camera, screenToCanvas, zoomCamera } from '../lib/camera'
import { MAX_ZOOM, UNFOCUSED_MAX_ZOOM, UNFOCUS_SNAP_ZOOM, FOCUS_SPEED, UNFOCUS_SPEED } from '../lib/constants'

const DEFAULT_CAMERA: Camera = { x: 0, y: 0, z: 1 }

function lerpCamera(from: Camera, to: Camera, t: number): Camera {
  return {
    x: from.x + (to.x - from.x) * t,
    y: from.y + (to.y - from.y) * t,
    z: from.z + (to.z - from.z) * t
  }
}

function camerasClose(a: Camera, b: Camera): boolean {
  return Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5 && Math.abs(a.z - b.z) < 0.001
}

export type InputDevice = 'mouse' | 'trackpad'

export function useCamera(initialCamera?: Camera, focusedRef?: React.RefObject<string | null>) {
  const initial = initialCamera ?? DEFAULT_CAMERA
  const [camera, setCamera] = useState<Camera>(initial)
  const cameraRef = useRef<Camera>(initial)
  const targetRef = useRef<Camera>({ ...initial })
  const speedRef = useRef(FOCUS_SPEED)
  const animatingRef = useRef(false)
  const lastTimeRef = useRef(0)
  const rafRef = useRef<number>(0)

  const inputDeviceRef = useRef<InputDevice>('mouse')
  const [inputDevice, setInputDevice] = useState<InputDevice>('mouse')

  // Keep cameraRef in sync with React state
  cameraRef.current = camera

  // Cleanup on unmount
  useEffect(() => {
    return () => cancelAnimationFrame(rafRef.current)
  }, [])

  // Animation tick — exponential smoothing
  const tick = useCallback((now: number) => {
    const dt = Math.min((now - lastTimeRef.current) / 1000, 0.1)
    lastTimeRef.current = now
    const factor = 1 - Math.exp(-speedRef.current * dt)

    const next = lerpCamera(cameraRef.current, targetRef.current, factor)

    if (camerasClose(next, targetRef.current)) {
      cameraRef.current = { ...targetRef.current }
      setCamera(cameraRef.current)
      animatingRef.current = false
      return
    }

    cameraRef.current = next
    setCamera(next)
    rafRef.current = requestAnimationFrame(tick)
  }, [])

  const ensureAnimating = useCallback(() => {
    if (animatingRef.current) return
    animatingRef.current = true
    lastTimeRef.current = performance.now()
    rafRef.current = requestAnimationFrame(tick)
  }, [tick])

  const flyTo = useCallback((to: Camera, speed = FOCUS_SPEED) => {
    targetRef.current = to
    speedRef.current = speed
    ensureAnimating()
  }, [ensureAnimating])

  const flyToUnfocusZoom = useCallback(() => {
    const cam = cameraRef.current
    if (cam.z <= UNFOCUS_SNAP_ZOOM) return

    const viewport = document.querySelector('.canvas-viewport') as HTMLElement | null
    if (!viewport) return

    const centerCanvas = screenToCanvas(
      { x: viewport.clientWidth / 2, y: viewport.clientHeight / 2 }, cam
    )
    flyTo({
      x: viewport.clientWidth / 2 - centerCanvas.x * UNFOCUS_SNAP_ZOOM,
      y: viewport.clientHeight / 2 - centerCanvas.y * UNFOCUS_SNAP_ZOOM,
      z: UNFOCUS_SNAP_ZOOM
    }, UNFOCUS_SPEED)
  }, [flyTo])

  const userPan = useCallback((dx: number, dy: number) => {
    // Scale delta so panning feels like target zoom speed
    const scale = cameraRef.current.z / targetRef.current.z
    const sdx = dx * scale
    const sdy = dy * scale

    cameraRef.current = {
      ...cameraRef.current,
      x: cameraRef.current.x - sdx,
      y: cameraRef.current.y - sdy
    }
    targetRef.current = {
      ...targetRef.current,
      x: targetRef.current.x - sdx,
      y: targetRef.current.y - sdy
    }
    setCamera({ ...cameraRef.current })
  }, [])

  const handleWheel = useCallback((e: WheelEvent) => {
    e.preventDefault()

    // Detect trackpad: mice can't produce simultaneous X+Y scroll
    if (e.deltaX !== 0 && inputDeviceRef.current === 'mouse') {
      inputDeviceRef.current = 'trackpad'
      setInputDevice('trackpad')
    }

    const isZoomAnimating = Math.abs(cameraRef.current.z - targetRef.current.z) > 0.001

    if (e.ctrlKey || e.metaKey) {
      // Pinch-to-zoom or Ctrl+scroll — suppress during zoom animation
      if (isZoomAnimating) return
      const point = { x: e.clientX, y: e.clientY }
      const maxZoom = focusedRef?.current ? MAX_ZOOM : UNFOCUSED_MAX_ZOOM
      const next = zoomCamera(cameraRef.current, point, e.deltaY, maxZoom)
      cameraRef.current = next
      targetRef.current = { ...next }
      setCamera(next)
    } else if (inputDeviceRef.current === 'trackpad') {
      // Trackpad pan — always allowed, scaled for target zoom feel
      userPan(e.deltaX, e.deltaY)
    } else {
      // Mouse wheel zoom — suppress during zoom animation
      if (isZoomAnimating) return
      const point = { x: e.clientX, y: e.clientY }
      const maxZoom = focusedRef?.current ? MAX_ZOOM : UNFOCUSED_MAX_ZOOM
      const next = zoomCamera(cameraRef.current, point, e.deltaY, maxZoom)
      cameraRef.current = next
      targetRef.current = { ...next }
      setCamera(next)
    }
  }, [focusedRef, userPan])

  const handlePanStart = useCallback((e: MouseEvent) => {
    let lastX = e.clientX
    let lastY = e.clientY

    const onMouseMove = (ev: MouseEvent) => {
      userPan(lastX - ev.clientX, lastY - ev.clientY)
      lastX = ev.clientX
      lastY = ev.clientY
    }

    const onMouseUp = () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }

    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
  }, [userPan])

  const resetCamera = useCallback(() => {
    cancelAnimationFrame(rafRef.current)
    animatingRef.current = false
    cameraRef.current = DEFAULT_CAMERA
    targetRef.current = { ...DEFAULT_CAMERA }
    setCamera(DEFAULT_CAMERA)
  }, [])

  const toggleInputDevice = useCallback(() => {
    const next = inputDeviceRef.current === 'mouse' ? 'trackpad' : 'mouse'
    inputDeviceRef.current = next
    setInputDevice(next)
  }, [])

  return { camera, handleWheel, handlePanStart, resetCamera, flyTo, flyToUnfocusZoom, inputDevice, toggleInputDevice }
}
