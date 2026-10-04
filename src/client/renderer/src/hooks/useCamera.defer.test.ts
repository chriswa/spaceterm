import { describe, expect, it } from 'vitest'
import { DEFERRED_SCALE_LIMIT, outgrowsDeferredScale, relativeCameraTransform } from './useCamera'
import { getCameraTransform, type Camera } from '../lib/camera'

/** Where a world point lands under a camera, and under the zoom layer's transform over the committed one. */
const project = (cam: Camera, p: { x: number; y: number }) => ({ x: p.x * cam.z + cam.x, y: p.y * cam.z + cam.y })
function parse(transform: string): Camera {
  const [, tx, ty, s] = /translate\(([-\d.e]+)px, ([-\d.e]+)px\) scale\(([-\d.e]+)\)/.exec(transform)!
  return { x: Number(tx), y: Number(ty), z: Number(s) }
}

describe('relativeCameraTransform', () => {
  it('puts every world point where the real camera would, over a surface showing the committed one', () => {
    const committed = { x: 120, y: -40, z: 0.31 }
    const real = { x: 260, y: 380, z: 0.03 }
    const layer = parse(relativeCameraTransform(committed, real))
    for (const p of [{ x: 0, y: 0 }, { x: 7008, y: 4594 }, { x: -11588, y: 11729 }]) {
      const onSurface = project(committed, p)
      const shown = { x: onSurface.x * layer.z + layer.x, y: onSurface.y * layer.z + layer.y }
      const want = project(real, p)
      expect(shown.x).toBeCloseTo(want.x, 6)
      expect(shown.y).toBeCloseTo(want.y, 6)
    }
  })

  it('is the identity when nothing has moved', () => {
    const cam = { x: 5, y: 6, z: 0.5 }
    expect(parse(relativeCameraTransform(cam, cam))).toEqual({ x: 0, y: 0, z: 1 })
    expect(getCameraTransform(cam)).toContain('scale(0.5)')
  })
})

describe('outgrowsDeferredScale', () => {
  const committed = { x: 0, y: 0, z: 0.28 }
  it('keeps scaling the drawing within the limit, either way, and while only panning', () => {
    expect(outgrowsDeferredScale(committed, { x: 900, y: -300, z: 0.28 })).toBe(false)
    expect(outgrowsDeferredScale(committed, { x: 0, y: 0, z: (0.28 / DEFERRED_SCALE_LIMIT) * 1.01 })).toBe(false)
    expect(outgrowsDeferredScale(committed, { x: 0, y: 0, z: 0.28 * DEFERRED_SCALE_LIMIT * 0.99 })).toBe(false)
  })

  it('redraws once the camera is past the limit, zooming out or in', () => {
    expect(outgrowsDeferredScale(committed, { x: 0, y: 0, z: 0.01 })).toBe(true)
    expect(outgrowsDeferredScale(committed, { x: 0, y: 0, z: 0.28 * DEFERRED_SCALE_LIMIT * 1.01 })).toBe(true)
  })
})
