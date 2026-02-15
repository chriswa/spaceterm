import { useCallback, useEffect, useRef, useState } from 'react'
import { Camera, getCameraTransform, screenToCanvas, zoomCamera, zoomCameraElastic } from '../lib/camera'
import { MIN_ZOOM, MAX_ZOOM, UNFOCUSED_MAX_ZOOM, UNFOCUS_SNAP_ZOOM, FOCUS_SPEED, UNFOCUS_SPEED, ZOOM_SNAP_BACK_SPEED, ZOOM_SNAP_BACK_DELAY } from '../lib/constants'

// PERF: During camera animation and continuous user input (trackpad pan, wheel
// zoom), we write the CSS transform directly to the DOM via surfaceRef instead
// of calling setCamera(). This avoids React re-rendering the entire component
// tree on every frame. React state is synced when:
//   1. A flyTo animation completes (camerasClose)
//   2. User input stops for SETTLE_DELAY ms (debounced sync)
//   3. resetCamera() is called (immediate sync)
//
// cameraRef is the source of truth. React state `camera` may lag behind by up
// to SETTLE_DELAY ms during continuous input, which only affects Toolbar display.

// Start zoomed in tight on the root node (canvas origin) at screen center.
// The initial fitAll flyTo will smoothly zoom out from here.
const DEFAULT_CAMERA: Camera = { x: window.innerWidth / 2, y: window.innerHeight / 2, z: 10 }

const SETTLE_DELAY = 150

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

  const surfaceRef = useRef<HTMLDivElement>(null)
  const syncTimerRef = useRef<number>(0)

  const inputDeviceRef = useRef<InputDevice>('mouse')
  const [inputDevice, setInputDevice] = useState<InputDevice>('mouse')

  const snapBackTimerRef = useRef<number>(0)
  const isSnapBackRef = useRef(false)
  const lastZoomPointRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 })

  const applyToDOM = useCallback((cam: Camera) => {
    if (surfaceRef.current) {
      surfaceRef.current.style.transform = getCameraTransform(cam)
    }
  }, [])

  const scheduleSync = useCallback(() => {
    clearTimeout(syncTimerRef.current)
    syncTimerRef.current = window.setTimeout(() => {
      setCamera(cameraRef.current)
    }, SETTLE_DELAY)
  }, [])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      cancelAnimationFrame(rafRef.current)
      clearTimeout(syncTimerRef.current)
      clearTimeout(snapBackTimerRef.current)
    }
  }, [])

  // Animation tick — exponential smoothing
  const tick = useCallback((now: number) => {
    const dt = Math.min((now - lastTimeRef.current) / 1000, 0.1)
    lastTimeRef.current = now
    const factor = 1 - Math.exp(-speedRef.current * dt)

    const next = lerpCamera(cameraRef.current, targetRef.current, factor)

    if (camerasClose(next, targetRef.current)) {
      cameraRef.current = { ...targetRef.current }
      applyToDOM(cameraRef.current)
      setCamera(cameraRef.current)
      animatingRef.current = false
      isSnapBackRef.current = false
      return
    }

    cameraRef.current = next
    applyToDOM(next)
    rafRef.current = requestAnimationFrame(tick)
  }, [applyToDOM])

  const ensureAnimating = useCallback(() => {
    if (animatingRef.current) return
    animatingRef.current = true
    lastTimeRef.current = performance.now()
    rafRef.current = requestAnimationFrame(tick)
  }, [tick])

  const flyTo = useCallback((to: Camera, speed = FOCUS_SPEED, isSnapBack = false) => {
    clearTimeout(snapBackTimerRef.current)
    isSnapBackRef.current = isSnapBack
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
    applyToDOM(cameraRef.current)
    scheduleSync()
  }, [applyToDOM, scheduleSync])

  const scheduleSnapBack = useCallback((cam: Camera, maxZoom: number, anchor: { x: number; y: number }) => {
    clearTimeout(snapBackTimerRef.current)
    if (cam.z >= MIN_ZOOM && cam.z <= maxZoom) return
    snapBackTimerRef.current = window.setTimeout(() => {
      const clampedZ = Math.min(maxZoom, Math.max(MIN_ZOOM, cameraRef.current.z))
      const canvasPoint = screenToCanvas(anchor, cameraRef.current)
      flyTo({
        x: anchor.x - canvasPoint.x * clampedZ,
        y: anchor.y - canvasPoint.y * clampedZ,
        z: clampedZ
      }, ZOOM_SNAP_BACK_SPEED, true)
    }, ZOOM_SNAP_BACK_DELAY)
  }, [flyTo])

  const handleWheel = useCallback((e: WheelEvent) => {
    e.preventDefault()

    // Detect trackpad: mice can't produce simultaneous X+Y scroll
    if (e.deltaX !== 0 && inputDeviceRef.current === 'mouse') {
      inputDeviceRef.current = 'trackpad'
      setInputDevice('trackpad')
    }

    const isZoomAnimating = Math.abs(cameraRef.current.z - targetRef.current.z) > 0.001

    if (e.ctrlKey || e.metaKey) {
      // Pinch-to-zoom or Ctrl+scroll — block during flyTo but allow during snap-back
      if (isZoomAnimating && !isSnapBackRef.current) return
      if (isSnapBackRef.current) {
        // Cancel snap-back: sync target to current position
        targetRef.current = { ...cameraRef.current }
        isSnapBackRef.current = false
      }
      const point = { x: e.clientX, y: e.clientY }
      const maxZoom = focusedRef?.current ? MAX_ZOOM : UNFOCUSED_MAX_ZOOM
      const next = zoomCameraElastic(cameraRef.current, point, e.deltaY, maxZoom)
      cameraRef.current = next
      targetRef.current = { ...next }
      applyToDOM(next)
      scheduleSync()
      lastZoomPointRef.current = point
      scheduleSnapBack(next, maxZoom, point)
    } else if (inputDeviceRef.current === 'trackpad') {
      // Trackpad pan — always allowed, scaled for target zoom feel
      userPan(e.deltaX, e.deltaY)
    } else {
      // Mouse wheel zoom — block during flyTo but allow during snap-back
      if (isZoomAnimating && !isSnapBackRef.current) return
      if (isSnapBackRef.current) {
        targetRef.current = { ...cameraRef.current }
        isSnapBackRef.current = false
      }
      const point = { x: e.clientX, y: e.clientY }
      const maxZoom = focusedRef?.current ? MAX_ZOOM : UNFOCUSED_MAX_ZOOM
      const next = zoomCameraElastic(cameraRef.current, point, e.deltaY, maxZoom)
      cameraRef.current = next
      targetRef.current = { ...next }
      applyToDOM(next)
      scheduleSync()
      lastZoomPointRef.current = point
      scheduleSnapBack(next, maxZoom, point)
    }
  }, [focusedRef, userPan, applyToDOM, scheduleSync, scheduleSnapBack])

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
    clearTimeout(snapBackTimerRef.current)
    animatingRef.current = false
    isSnapBackRef.current = false
    cameraRef.current = DEFAULT_CAMERA
    targetRef.current = { ...DEFAULT_CAMERA }
    applyToDOM(DEFAULT_CAMERA)
    setCamera(DEFAULT_CAMERA)
  }, [applyToDOM])

  const toggleInputDevice = useCallback(() => {
    const next = inputDeviceRef.current === 'mouse' ? 'trackpad' : 'mouse'
    inputDeviceRef.current = next
    setInputDevice(next)
  }, [])

  return { camera, cameraRef, surfaceRef, handleWheel, handlePanStart, resetCamera, flyTo, flyToUnfocusZoom, inputDevice, toggleInputDevice }
}
