import { MIN_ZOOM, MAX_ZOOM, ZOOM_SENSITIVITY, ZOOM_RUBBER_BAND_HIGH, ZOOM_RUBBER_BAND_LOW, FOCUS_SPEED, FLY_TO_BASE_DURATION, FLY_TO_HALF_RANGE, FLY_TO_MAX_DURATION } from './constants'

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

export function panCamera(camera: Camera, dx: number, dy: number): Camera {
  return {
    ...camera,
    x: camera.x - dx,
    y: camera.y - dy
  }
}

export function zoomCamera(camera: Camera, screenPoint: Point, delta: number, maxZoom = MAX_ZOOM): Camera {
  const newZ = Math.min(maxZoom, Math.max(MIN_ZOOM, camera.z - delta * ZOOM_SENSITIVITY * camera.z))

  // Keep the point under the cursor fixed
  const canvasPoint = screenToCanvas(screenPoint, camera)
  return {
    x: screenPoint.x - canvasPoint.x * newZ,
    y: screenPoint.y - canvasPoint.y * newZ,
    z: newZ
  }
}

function elasticClamp(z: number, min: number, max: number): number {
  if (z >= min && z <= max) return z
  if (z > max) {
    const excess = z - max
    return max + ZOOM_RUBBER_BAND_HIGH * Math.tanh(excess / ZOOM_RUBBER_BAND_HIGH)
  }
  // z < min
  const excess = min - z
  return Math.max(0.01, min - ZOOM_RUBBER_BAND_LOW * Math.tanh(excess / ZOOM_RUBBER_BAND_LOW))
}

export function zoomCameraElastic(camera: Camera, screenPoint: Point, delta: number, maxZoom = MAX_ZOOM): Camera {
  const rawZ = camera.z - delta * ZOOM_SENSITIVITY * camera.z
  const newZ = elasticClamp(rawZ, MIN_ZOOM, maxZoom)

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

export function computeFlyToSpeed(distance: number): number {
  const durationRatio = Math.min(FLY_TO_MAX_DURATION / FLY_TO_BASE_DURATION, 1 + distance / FLY_TO_HALF_RANGE)
  return FOCUS_SPEED / durationRatio
}
