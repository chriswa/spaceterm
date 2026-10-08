import { describe, expect, it } from 'vitest'
import { SAFE_ZOOM_AFTER_KILL, cameraAfterKill } from './crash-camera'

describe('cameraAfterKill', () => {
  const zoomedOut = { x: 117, y: 560, z: 0.015 }

  it('keeps the saved camera when the page was not killed', () => {
    expect(cameraAfterKill(zoomedOut, 0, 400, 800)).toBeNull()
  })

  it('starts a killed page zoomed far out at the root, closer in', () => {
    const cam = cameraAfterKill(zoomedOut, 3, 400, 800)
    expect(cam).toEqual({ x: 200, y: 400, z: SAFE_ZOOM_AFTER_KILL })
  })

  it('leaves a killed page that was already close in where it was', () => {
    expect(cameraAfterKill({ x: 0, y: 0, z: 0.5 }, 1, 400, 800)).toBeNull()
  })

  it('has nothing to recover without a saved camera', () => {
    expect(cameraAfterKill(null, 1, 400, 800)).toBeNull()
  })
})
