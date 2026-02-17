import { useCallback, useEffect, useRef, useState } from 'react'
import { Camera, getCameraTransform, cameraToFitBounds, screenToCanvas, unionBounds, zoomCamera, zoomCameraElastic, loadCameraFromStorage, saveCameraToStorage } from '../lib/camera'
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
  const storedCamera = loadCameraFromStorage()
  const initial = initialCamera ?? storedCamera ?? DEFAULT_CAMERA
  const restoredFromStorageRef = useRef(storedCamera !== null && !initialCamera)
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
      surfaceRef.current.style.setProperty('--camera-zoom', String(cam.z))
    }
  }, [])

  const scheduleSync = useCallback(() => {
    clearTimeout(syncTimerRef.current)
    syncTimerRef.current = window.setTimeout(() => {
      setCamera(cameraRef.current)
    }, SETTLE_DELAY)
  }, [])

  // Persist camera to localStorage on every change
  useEffect(() => { saveCameraToStorage(camera) }, [camera])

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

  const snapToTarget = useCallback(() => {
    cancelAnimationFrame(rafRef.current)
    clearTimeout(snapBackTimerRef.current)
    if (!animatingRef.current) return
    cameraRef.current = { ...targetRef.current }
    applyToDOM(cameraRef.current)
    setCamera(cameraRef.current)
    animatingRef.current = false
    isSnapBackRef.current = false
  }, [applyToDOM])

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

  const rotationalFlyTo = useCallback((params: {
    parentCenter: { x: number; y: number }
    sourceCenter: { x: number; y: number }
    targetCenter: { x: number; y: number }
    targetCamera: Camera
    direction: 'cw' | 'ccw'
    duration?: number
  }) => {
    const { parentCenter, sourceCenter, targetCenter, targetCamera, direction } = params

    // Force angle delta to match the requested rotation direction (computed early for duration)
    const srcAngleEarly = Math.atan2(sourceCenter.y - parentCenter.y, sourceCenter.x - parentCenter.x)
    const tgtAngleEarly = Math.atan2(targetCenter.y - parentCenter.y, targetCenter.x - parentCenter.x)
    let angleDeltaEarly = tgtAngleEarly - srcAngleEarly
    if (direction === 'cw') {
      if (angleDeltaEarly <= 0) angleDeltaEarly += 2 * Math.PI
    } else {
      if (angleDeltaEarly >= 0) angleDeltaEarly -= 2 * Math.PI
    }
    // 500ms at 0°, lerp to 1000ms at 360°
    const absAngle = Math.abs(angleDeltaEarly)
    const duration = params.duration ?? (500 + (absAngle / (2 * Math.PI)) * 500)

    // Cancel any existing animation. Keep animatingRef true so that
    // flyTo → ensureAnimating is blocked during the rotational animation.
    cancelAnimationFrame(rafRef.current)
    animatingRef.current = true
    clearTimeout(snapBackTimerRef.current)

    // Store the final target so snapToTarget() can complete this instantly
    targetRef.current = targetCamera

    const viewport = document.querySelector('.canvas-viewport') as HTMLElement | null
    if (!viewport) return
    const vw = viewport.clientWidth
    const vh = viewport.clientHeight

    const startCamera = { ...cameraRef.current }

    // Reuse polar values computed earlier for duration calculation
    const srcAngle = srcAngleEarly
    const srcRadius = Math.hypot(sourceCenter.x - parentCenter.x, sourceCenter.y - parentCenter.y)
    const tgtRadius = Math.hypot(targetCenter.x - parentCenter.x, targetCenter.y - parentCenter.y)
    const angleDelta = angleDeltaEarly

    // Radius dips inward at midpoint to keep the view inside the polar area
    const radiusDipFactor = 0.1

    // Compute mid-zoom: zoom to show parent from the arc midpoint
    const midLinearRadius = (srcRadius + tgtRadius) / 2
    const midEffectiveRadius = midLinearRadius * (1 - radiusDipFactor)
    const midAngle = srcAngle + angleDelta / 2
    const midPoint = {
      x: parentCenter.x + midEffectiveRadius * Math.cos(midAngle),
      y: parentCenter.y + midEffectiveRadius * Math.sin(midAngle)
    }
    const pMinX = Math.min(parentCenter.x, midPoint.x)
    const pMinY = Math.min(parentCenter.y, midPoint.y)
    const pMaxX = Math.max(parentCenter.x, midPoint.x)
    const pMaxY = Math.max(parentCenter.y, midPoint.y)
    const midBounds = { x: pMinX, y: pMinY, width: pMaxX - pMinX, height: pMaxY - pMinY }
    const midZoom = cameraToFitBounds(midBounds, vw, vh, 0.1, UNFOCUS_SNAP_ZOOM).z

    // Zoom arc offset: sin curve that dips to midZoom at t=0.5
    const linearMidZoom = (startCamera.z + targetCamera.z) / 2
    const zoomArc = midZoom - linearMidZoom

    // Precompute the "ideal" camera at t=0 and t=1 from polar math.
    // These may not match startCamera/targetCamera (e.g. interrupted animation),
    // so we measure the error and blend it away during the animation.
    const idealAtT0: Camera = {
      x: vw / 2 - sourceCenter.x * startCamera.z,
      y: vh / 2 - sourceCenter.y * startCamera.z,
      z: startCamera.z
    }
    const idealAtT1: Camera = {
      x: vw / 2 - targetCenter.x * targetCamera.z,
      y: vh / 2 - targetCenter.y * targetCamera.z,
      z: targetCamera.z
    }
    const startCorr = { x: startCamera.x - idealAtT0.x, y: startCamera.y - idealAtT0.y }
    const endCorr = { x: targetCamera.x - idealAtT1.x, y: targetCamera.y - idealAtT1.y }

    // Ease-in-out cubic
    const ease = (t: number) => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2

    const startTime = performance.now()

    const rotTick = (now: number) => {
      const elapsed = now - startTime
      const rawT = Math.min(elapsed / duration, 1)
      const t = ease(rawT)

      // Polar interpolation — all channels use eased t so they stay in sync
      const angle = srcAngle + angleDelta * t
      const linearRadius = srcRadius + (tgtRadius - srcRadius) * t
      const effectiveRadius = linearRadius - linearRadius * radiusDipFactor * Math.sin(Math.PI * t)

      const cx = parentCenter.x + effectiveRadius * Math.cos(angle)
      const cy = parentCenter.y + effectiveRadius * Math.sin(angle)

      const zoom = startCamera.z + (targetCamera.z - startCamera.z) * t + zoomArc * Math.sin(Math.PI * t)

      // Blend endpoint corrections: full startCorr at t=0, full endCorr at t=1
      const corrX = startCorr.x * (1 - t) + endCorr.x * t
      const corrY = startCorr.y * (1 - t) + endCorr.y * t

      const cam: Camera = { x: vw / 2 - cx * zoom + corrX, y: vh / 2 - cy * zoom + corrY, z: zoom }
      cameraRef.current = cam
      applyToDOM(cam)

      if (rawT >= 1) {
        cameraRef.current = { ...targetCamera }
        targetRef.current = { ...targetCamera }
        applyToDOM(targetCamera)
        setCamera(targetCamera)
        animatingRef.current = false
        return
      }

      rafRef.current = requestAnimationFrame(rotTick)
    }

    rafRef.current = requestAnimationFrame(rotTick)
  }, [applyToDOM])

  const hopFlyTo = useCallback((params: {
    targetCamera: Camera
    targetBounds: { x: number; y: number; width: number; height: number }
    duration?: number
  }) => {
    const { targetCamera, targetBounds, duration = 1200 } = params

    cancelAnimationFrame(rafRef.current)
    animatingRef.current = true
    clearTimeout(snapBackTimerRef.current)
    targetRef.current = targetCamera

    const viewport = document.querySelector('.canvas-viewport') as HTMLElement | null
    if (!viewport) return
    const vw = viewport.clientWidth
    const vh = viewport.clientHeight

    const startCamera = { ...cameraRef.current }

    const sourceCenter = screenToCanvas({ x: vw / 2, y: vh / 2 }, startCamera)
    const targetCenter = screenToCanvas({ x: vw / 2, y: vh / 2 }, targetCamera)

    const midBounds = unionBounds([
      { x: sourceCenter.x, y: sourceCenter.y, width: 0, height: 0 },
      targetBounds
    ])
    if (!midBounds) return

    const midZoom = cameraToFitBounds(midBounds, vw, vh, 0.15, UNFOCUS_SNAP_ZOOM).z
    const zoomArc = midZoom - (startCamera.z + targetCamera.z) / 2

    const quarticEase = (t: number) =>
      t < 0.5 ? 8 * t * t * t * t : 1 - Math.pow(-2 * t + 2, 4) / 2

    const startTime = performance.now()

    const hopTick = (now: number) => {
      const elapsed = now - startTime
      const rawT = Math.min(elapsed / duration, 1)
      const tPos = quarticEase(rawT)

      const cx = sourceCenter.x + (targetCenter.x - sourceCenter.x) * tPos
      const cy = sourceCenter.y + (targetCenter.y - sourceCenter.y) * tPos

      const zoom = startCamera.z + (targetCamera.z - startCamera.z) * rawT + zoomArc * Math.sin(Math.PI * rawT)

      const cam: Camera = { x: vw / 2 - cx * zoom, y: vh / 2 - cy * zoom, z: zoom }
      cameraRef.current = cam
      applyToDOM(cam)

      if (rawT >= 1) {
        cameraRef.current = { ...targetCamera }
        targetRef.current = { ...targetCamera }
        applyToDOM(targetCamera)
        setCamera(targetCamera)
        animatingRef.current = false
        return
      }

      rafRef.current = requestAnimationFrame(hopTick)
    }

    rafRef.current = requestAnimationFrame(hopTick)
  }, [applyToDOM])

  const toggleInputDevice = useCallback(() => {
    const next = inputDeviceRef.current === 'mouse' ? 'trackpad' : 'mouse'
    inputDeviceRef.current = next
    setInputDevice(next)
  }, [])

  const shakeCamera = useCallback(() => {
    cancelAnimationFrame(rafRef.current)
    clearTimeout(snapBackTimerRef.current)
    animatingRef.current = true

    const origin = { ...cameraRef.current }
    targetRef.current = { ...origin }
    const startTime = performance.now()
    const duration = 250
    const radius = 6
    const loops = 3

    const shakeTick = (now: number) => {
      const elapsed = now - startTime
      const t = Math.min(elapsed / duration, 1)
      const decay = 1 - t
      const angle = t * loops * 2 * Math.PI
      const ox = radius * decay * Math.sin(angle)
      const oy = radius * decay * Math.cos(angle)

      const cam: Camera = { x: origin.x + ox, y: origin.y + oy, z: origin.z }
      cameraRef.current = cam
      applyToDOM(cam)

      if (t >= 1) {
        cameraRef.current = { ...origin }
        targetRef.current = { ...origin }
        applyToDOM(origin)
        animatingRef.current = false
        return
      }

      rafRef.current = requestAnimationFrame(shakeTick)
    }

    rafRef.current = requestAnimationFrame(shakeTick)
  }, [applyToDOM])

  return { camera, cameraRef, surfaceRef, handleWheel, handlePanStart, resetCamera, flyTo, snapToTarget, flyToUnfocusZoom, rotationalFlyTo, hopFlyTo, shakeCamera, inputDevice, toggleInputDevice, restoredFromStorageRef }
}
