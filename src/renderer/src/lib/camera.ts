import { MIN_ZOOM, MAX_ZOOM, ZOOM_SENSITIVITY } from './constants'

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

export function zoomCamera(camera: Camera, screenPoint: Point, delta: number): Camera {
  const newZ = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, camera.z - delta * ZOOM_SENSITIVITY * camera.z))

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
