import { MIN_ZOOM, MAX_ZOOM, ZOOM_SNAP_LOW, ZOOM_SNAP_HIGH, ZOOM_SENSITIVITY, ZOOM_RUBBER_BAND_HIGH, ZOOM_RUBBER_BAND_LOW, FOCUS_SPEED, FLY_TO_BASE_DURATION, FLY_TO_HALF_RANGE, FLY_TO_MAX_DURATION } from './constants'

export interface Camera {
  x: number
  y: number
  z: number // zoom level (1 = 100%)
}

export interface Point {
  x: number
  y: number
}

export function screenToCanvas(point: Point, camera: Camera): Point {
  return {
    x: (point.x - camera.x) / camera.z,
    y: (point.y - camera.y) / camera.z
  }
}

export function canvasToScreen(point: Point, camera: Camera): Point {
  return {
    x: point.x * camera.z + camera.x,
    y: point.y * camera.z + camera.y
  }
}

export function clampZoom(z: number): number {
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z))
}

export function panCamera(camera: Camera, dx: number, dy: number): Camera {
  return {
    ...camera,
    x: camera.x - dx,
    y: camera.y - dy
  }
}

export function zoomCamera(camera: Camera, screenPoint: Point, delta: number, snapMax = ZOOM_SNAP_HIGH): Camera {
  const newZ = clampZoom(camera.z - delta * ZOOM_SENSITIVITY * camera.z)

  // Keep the point under the cursor fixed
  const canvasPoint = screenToCanvas(screenPoint, camera)
  return {
    x: screenPoint.x - canvasPoint.x * newZ,
    y: screenPoint.y - canvasPoint.y * newZ,
    z: newZ
  }
}

function elasticClamp(z: number, snapMin: number, snapMax: number): number {
  if (z >= snapMin && z <= snapMax) return z
  if (z > snapMax) {
    const excess = z - snapMax
    return Math.min(MAX_ZOOM, snapMax + ZOOM_RUBBER_BAND_HIGH * Math.tanh(excess / ZOOM_RUBBER_BAND_HIGH))
  }
  const excess = snapMin - z
  return Math.max(MIN_ZOOM, snapMin - ZOOM_RUBBER_BAND_LOW * Math.tanh(excess / ZOOM_RUBBER_BAND_LOW))
}

export function zoomCameraElastic(camera: Camera, screenPoint: Point, delta: number, snapMax = ZOOM_SNAP_HIGH): Camera {
  const rawZ = camera.z - delta * ZOOM_SENSITIVITY * camera.z
  const newZ = elasticClamp(rawZ, ZOOM_SNAP_LOW, snapMax)

  // Keep the point under the cursor fixed
  const canvasPoint = screenToCanvas(screenPoint, camera)
  return {
    x: screenPoint.x - canvasPoint.x * newZ,
    y: screenPoint.y - canvasPoint.y * newZ,
    z: newZ
  }
}

export function getCameraTransform(camera: Camera): string {
  return `translate(${camera.x}px, ${camera.y}px) scale(${camera.z})`
}

export interface Bounds {
  x: number
  y: number
  width: number
  height: number
}

export function cameraToFitBounds(
  bounds: Bounds,
  viewportWidth: number,
  viewportHeight: number,
  padding = 0.1,
  maxZoom = MAX_ZOOM
): Camera {
  const usableW = viewportWidth * (1 - 2 * padding)
  const usableH = viewportHeight * (1 - 2 * padding)

  const zoom = Math.min(usableW / bounds.width, usableH / bounds.height, maxZoom)

  const centerX = bounds.x + bounds.width / 2
  const centerY = bounds.y + bounds.height / 2

  return {
    x: viewportWidth / 2 - centerX * zoom,
    y: viewportHeight / 2 - centerY * zoom,
    z: zoom
  }
}

export function cameraToFitBoundsWithCenter(
  center: Point,
  rects: Array<{ x: number; y: number; width: number; height: number }>,
  viewportWidth: number,
  viewportHeight: number,
  padding = 0.1,
  maxZoom = MAX_ZOOM
): Camera {
  // Compute max extent from center to each edge of each rect in all 4 directions
  let halfW = 0
  let halfH = 0
  for (const r of rects) {
    halfW = Math.max(halfW, Math.abs(r.x - center.x), Math.abs(r.x + r.width - center.x))
    halfH = Math.max(halfH, Math.abs(r.y - center.y), Math.abs(r.y + r.height - center.y))
  }

  // Create symmetric bounds centered on the given point
  const boundsWidth = halfW * 2
  const boundsHeight = halfH * 2

  const usableW = viewportWidth * (1 - 2 * padding)
  const usableH = viewportHeight * (1 - 2 * padding)

  const zoom = Math.min(usableW / boundsWidth, usableH / boundsHeight, maxZoom)

  return {
    x: viewportWidth / 2 - center.x * zoom,
    y: viewportHeight / 2 - center.y * zoom,
    z: zoom
  }
}

export function unionBounds(
  rects: Array<{ x: number; y: number; width: number; height: number }>
): Bounds | null {
  if (rects.length === 0) return null

  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity

  for (const r of rects) {
    minX = Math.min(minX, r.x)
    minY = Math.min(minY, r.y)
    maxX = Math.max(maxX, r.x + r.width)
    maxY = Math.max(maxY, r.y + r.height)
  }

  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

const CAMERA_STORAGE_KEY = 'spaceterm-camera'

export function loadCameraFromStorage(): Camera | null {
  try {
    const raw = localStorage.getItem(CAMERA_STORAGE_KEY)
    if (!raw) return null
    const { x, y, z } = JSON.parse(raw)
    if (typeof x === 'number' && typeof y === 'number' && typeof z === 'number') {
      return { x, y, z }
    }
    return null
  } catch { return null }
}

export function saveCameraToStorage(cam: Camera): void {
  try {
    localStorage.setItem(CAMERA_STORAGE_KEY, JSON.stringify({ x: cam.x, y: cam.y, z: cam.z }))
  } catch { /* ignore quota errors */ }
}

export function computeFlyToDuration(distance: number): number {
  return Math.min(FLY_TO_MAX_DURATION, FLY_TO_BASE_DURATION * (1 + distance / FLY_TO_HALF_RANGE))
}

/**
 * Scale a zoom arc so z(t) = startZ + (endZ-startZ)*t + arc*sin(πt)
 * never dips below `floor`. Returns the (possibly reduced) arc.
 */
export function clampZoomArc(startZ: number, endZ: number, rawArc: number, floor: number): number {
  function curveMin(arc: number): number {
    const dz = endZ - startZ
    if (Math.abs(arc * Math.PI) < 1e-6) return Math.min(startZ, endZ)
    const cosArg = -dz / (arc * Math.PI)
    if (Math.abs(cosArg) > 1) return Math.min(startZ, endZ)
    const tMin = Math.acos(cosArg) / Math.PI
    return startZ + dz * tMin + arc * Math.sin(Math.PI * tMin)
  }

  if (curveMin(rawArc) >= floor) return rawArc

  // Binary search for scale s ∈ [0,1] so curveMin(s * rawArc) ≈ floor
  let lo = 0, hi = 1
  for (let i = 0; i < 20; i++) {
    const s = (lo + hi) / 2
    if (curveMin(rawArc * s) < floor) hi = s; else lo = s
  }
  return rawArc * lo
}

/**
 * Clamp a parabolic arc in log-height space so that z(t) = exp(-h(t))
 * never dips below `minZoom`. The height curve is:
 *   h(t) = hSrc + (hTgt-hSrc)*t + arc*4*t*(1-t)
 * Returns the (possibly reduced) arc.
 */
export function clampHeightArc(hSrc: number, hTgt: number, rawArc: number, minZoom: number): number {
  if (rawArc <= 0) return rawArc
  const hCeiling = -Math.log(minZoom)

  function peakH(arc: number): number {
    const dh = hTgt - hSrc
    const tPeak = Math.max(0, Math.min(1, 0.5 + dh / (8 * arc)))
    return hSrc + dh * tPeak + arc * 4 * tPeak * (1 - tPeak)
  }

  if (peakH(rawArc) <= hCeiling) return rawArc

  let lo = 0, hi = rawArc
  for (let i = 0; i < 20; i++) {
    const mid = (lo + hi) / 2
    if (peakH(mid) > hCeiling) hi = mid; else lo = mid
  }
  return lo
}

export function computeFlyToSpeed(distance: number): number {
  const durationRatio = Math.min(FLY_TO_MAX_DURATION / FLY_TO_BASE_DURATION, 1 + distance / FLY_TO_HALF_RANGE)
  return FOCUS_SPEED / durationRatio
}

/**
 * Camera-lock "expand to include": if the node center is already in the
 * viewport, returns null (no fly needed).  Otherwise returns the smallest
 * camera that fits the union of the current viewport rect and the full
 * bounding box of the target node.
 */
export function expandCameraToInclude(
  nodeBounds: Bounds,
  camera: Camera,
  viewportWidth: number,
  viewportHeight: number,
  padding = 0.025
): Camera | null {
  const topLeft = screenToCanvas({ x: 0, y: 0 }, camera)
  const bottomRight = screenToCanvas({ x: viewportWidth, y: viewportHeight }, camera)

  const nodeCenterX = nodeBounds.x + nodeBounds.width / 2
  const nodeCenterY = nodeBounds.y + nodeBounds.height / 2

  if (
    nodeCenterX >= topLeft.x && nodeCenterX <= bottomRight.x &&
    nodeCenterY >= topLeft.y && nodeCenterY <= bottomRight.y
  ) {
    return null
  }

  const viewportRect: Bounds = {
    x: topLeft.x,
    y: topLeft.y,
    width: bottomRight.x - topLeft.x,
    height: bottomRight.y - topLeft.y
  }

  const union = unionBounds([viewportRect, nodeBounds])
  if (!union) return null

  return cameraToFitBounds(union, viewportWidth, viewportHeight, padding)
}
