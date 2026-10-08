import type { Camera } from '@/lib/camera'
import { loadCameraFromStorage, saveCameraToStorage } from '@/lib/camera'

/**
 * Out of a crash loop. iOS ends the page's process when it runs out of memory,
 * and the app reloads it — at the camera it saved, which is where it ran out.
 * Zoomed far out, with every card in view, that is a page that dies a second
 * after every load, forever: the canvas flashes and goes black on a loop, and
 * nothing can be touched to get out of it.
 *
 * So after a kill, a saved camera further out than this starts at the root
 * instead, close enough in that only a few cards are in view. Zooming back out
 * is the user's to try.
 */
export const SAFE_ZOOM_AFTER_KILL = 0.2

/**
 * The camera to start at after iOS ended the page's process; null to keep the
 * saved one. The root is the canvas origin, centred in a `width`×`height` view.
 */
export function cameraAfterKill(saved: Camera | null, processRestarts: number, width: number, height: number): Camera | null {
  if (processRestarts <= 0 || !saved || saved.z >= SAFE_ZOOM_AFTER_KILL) return null
  return { x: width / 2, y: height / 2, z: SAFE_ZOOM_AFTER_KILL }
}

/** Before the canvas mounts and reads the saved camera. Says what it did, if anything. */
export function recoverCameraAfterKill(processRestarts: number, width = window.innerWidth, height = window.innerHeight): string | null {
  const saved = loadCameraFromStorage()
  const safe = cameraAfterKill(saved, processRestarts, width, height)
  if (!safe || !saved) return null
  saveCameraToStorage(safe)
  return `[camera] reloaded after iOS ended the page at zoom ${saved.z.toFixed(4)}: starting at the root at ${safe.z}`
}
