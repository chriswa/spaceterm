import { describe, it, expect } from 'vitest'
import { MAX_SNAPSHOT_LOD, MIN_SNAPSHOT_LOD, glyphGrowth, rowsToRepaint, snapshotLod } from './snapshot-lod'
import { CELL_HEIGHT, MAX_ZOOM, MIN_ZOOM } from './constants'

/**
 * Properties rather than a table of zoom→level pairs. Every one of these is a
 * claim the callers depend on, and pinning the octave a particular zoom lands
 * on would turn a legitimate retune of the floor into a failing test.
 */

/** Every zoom the camera can reach, at both of the display scales we run on. */
const SWEEP: Array<{ zoom: number; dpr: number }> = []
for (const dpr of [1, 2]) {
  for (let z = MIN_ZOOM; z <= MAX_ZOOM; z *= 1.05) SWEEP.push({ zoom: z, dpr })
  SWEEP.push({ zoom: MAX_ZOOM, dpr })
}

describe('snapshotLod', () => {
  it('stays within the clamp for every reachable zoom', () => {
    for (const { zoom, dpr } of SWEEP) {
      const lod = snapshotLod(zoom, dpr)
      expect(lod).toBeGreaterThanOrEqual(MIN_SNAPSHOT_LOD)
      expect(lod).toBeLessThanOrEqual(MAX_SNAPSHOT_LOD)
    }
  })

  it('is a power of two, so a grid row is a whole number of bitmap pixels', () => {
    for (const { zoom, dpr } of SWEEP) {
      const lod = snapshotLod(zoom, dpr)
      expect(Number.isInteger(Math.log2(lod))).toBe(true)
      // The invariant `TerminalCard`'s partial repaints rest on: clearing one
      // row never half-covers a pixel its neighbour also owns.
      expect((CELL_HEIGHT * lod) % 1).toBe(0)
    }
  })

  it('never asks for more pixels than a world unit', () => {
    for (const { zoom, dpr } of SWEEP) {
      expect(snapshotLod(zoom, dpr)).toBeLessThanOrEqual(1)
    }
  })

  it('never undersamples the screen, between the clamps', () => {
    for (const { zoom, dpr } of SWEEP) {
      const lod = snapshotLod(zoom, dpr)
      if (lod === MIN_SNAPSHOT_LOD || lod === MAX_SNAPSHOT_LOD) continue
      // The compositor is left minifying, never magnifying — magnification is
      // what a level chosen one octave too coarse would look like.
      expect(lod).toBeGreaterThanOrEqual(zoom * dpr)
    }
  })

  it('leaves the compositor no more than an octave to minify', () => {
    for (const { zoom, dpr } of SWEEP) {
      const lod = snapshotLod(zoom, dpr)
      if (lod === MIN_SNAPSHOT_LOD || lod === MAX_SNAPSHOT_LOD) continue
      expect(zoom * dpr / lod).toBeGreaterThan(0.5)
    }
  })

  it('never coarsens as the card grows', () => {
    for (const dpr of [1, 2]) {
      let previous = 0
      for (let z = MIN_ZOOM; z <= MAX_ZOOM; z *= 1.05) {
        const lod = snapshotLod(z, dpr)
        expect(lod).toBeGreaterThanOrEqual(previous)
        previous = lod
      }
    }
  })

  it('falls back to full resolution when the zoom is not a usable number', () => {
    for (const zoom of [0, -1, NaN, Infinity]) {
      expect(snapshotLod(zoom, 2)).toBe(MAX_SNAPSHOT_LOD)
    }
  })
})

describe('rowsToRepaint', () => {
  it('widens each changed row by its neighbours', () => {
    expect(rowsToRepaint([4], 24)).toEqual([3, 4, 5])
  })

  it('merges overlapping neighbourhoods without repeating a row', () => {
    expect(rowsToRepaint([4, 5], 24)).toEqual([3, 4, 5, 6])
  })

  it('stays inside the grid at both edges', () => {
    expect(rowsToRepaint([0], 3)).toEqual([0, 1])
    expect(rowsToRepaint([2], 3)).toEqual([1, 2])
  })

  it('sorts, so the clear pass and the paint pass walk the same bands', () => {
    expect(rowsToRepaint([9, 2], 24)).toEqual([1, 2, 3, 8, 9, 10])
  })

  it('has nothing to do when nothing changed', () => {
    expect(rowsToRepaint([], 24)).toEqual([])
  })
})

describe('glyphGrowth', () => {
  it('leaves a full-size card exactly as it was', () => {
    expect(glyphGrowth(MAX_SNAPSHOT_LOD)).toBe(1)
  })

  it('grows as the bitmap shrinks', () => {
    let previous = 0
    for (const lod of [MIN_SNAPSHOT_LOD, 1 / 8, 1 / 4, 1 / 2, 1].reverse()) {
      const growth = glyphGrowth(lod)
      expect(growth).toBeGreaterThanOrEqual(previous)
      previous = growth
    }
  })

  it('restores the light the sRGB blend loses, at every level', () => {
    // Measured in Chromium: the share of the full-size render's linear
    // luminance a plain repaint at each level keeps. The growth law exists to
    // cancel these, so it is the only thing worth pinning — if a retune of
    // `GLYPH_GROWTH_PER_LOST_UNIT` stops cancelling them, that is a regression
    // and not a retune.
    const kept: Record<number, number> = { 1: 1.0, 0.5: 0.972, 0.25: 0.899, 0.125: 0.864, 0.0625: 0.647 }
    // A grown glyph's ink goes up with the square of its size, and that ink is
    // what the lost light is made of.
    for (const [lod, share] of Object.entries(kept)) {
      const restored = share * glyphGrowth(Number(lod)) ** 2
      expect(restored).toBeGreaterThan(0.95)
      expect(restored).toBeLessThan(1.15)
    }
  })

  it('never distorts a glyph enough to be seen at the level it applies to', () => {
    // A tenth over is already a lot for type, and at 1/16 a glyph is a pixel
    // and a half wide — nothing about its shape survives to be distorted.
    expect(glyphGrowth(MIN_SNAPSHOT_LOD)).toBeLessThan(1.3)
    expect(glyphGrowth(1 / 2)).toBeLessThan(1.05)
  })
})
