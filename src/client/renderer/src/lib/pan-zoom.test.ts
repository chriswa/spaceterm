import { describe, expect, it } from 'vitest'
import { FITTED, MAX_SCALE, clampView, panBy, pinch, zoomAbout, type Frame, type PanZoom } from './pan-zoom'

/** A 400×300 picture fitted into a 400×600 frame. */
const frame: Frame = { width: 400, height: 300, frameWidth: 400, frameHeight: 600 }

/** Where the picture's point `q` (px from its centre, fitted) is drawn. */
const drawn = (view: PanZoom, q: { x: number; y: number }) => ({ x: view.x + view.scale * q.x, y: view.y + view.scale * q.y })

describe('pan and zoom', () => {
  it('keeps the part of the picture under the zoom point still', () => {
    const at = { x: 100, y: 50 }
    // Filling its frame, so zoomed in it has room to move both ways.
    const zoomed = zoomAbout(FITTED, 2, at, { ...frame, frameHeight: 300 })
    // The picture point that was under `at` when fitted: (100, 50) from its centre.
    expect(drawn(zoomed, { x: 100, y: 50 })).toEqual(at)
  })

  it('never shrinks below fitted nor grows past the most', () => {
    expect(zoomAbout(FITTED, 0.5, { x: 0, y: 0 }, frame).scale).toBe(1)
    expect(zoomAbout(FITTED, 100, { x: 0, y: 0 }, frame).scale).toBe(MAX_SCALE)
  })

  it('does not move a fitted picture, and moves a zoomed one only as far as its edges reach', () => {
    expect(panBy(FITTED, 50, 50, frame)).toEqual(FITTED)
    const zoomed = { scale: 2, x: 0, y: 0 }
    // 800×600 drawn in a 400×600 frame: 200 px of reach sideways, none up and down.
    expect(panBy(zoomed, 500, 500, frame)).toEqual({ scale: 2, x: 200, y: 0 })
    expect(clampView({ scale: 3, x: -1000, y: 1000 }, frame)).toEqual({ scale: 3, x: -400, y: 150 })
  })

  it('zooms by how far two fingers spread, and follows their midpoint', () => {
    const spread = pinch(FITTED, [{ x: -50, y: 0 }, { x: 50, y: 0 }], [{ x: -100, y: 0 }, { x: 100, y: 0 }], frame)
    expect(spread).toEqual({ scale: 2, x: 0, y: 0 })
    const moved = pinch(spread, [{ x: -50, y: 0 }, { x: 50, y: 0 }], [{ x: -20, y: 0 }, { x: 80, y: 0 }], frame)
    expect(moved).toEqual({ scale: 2, x: 30, y: 0 })
  })
})
