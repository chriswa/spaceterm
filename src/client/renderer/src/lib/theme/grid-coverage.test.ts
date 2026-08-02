import { describe, it, expect } from 'vitest'
import { GRID_BG_FRAG } from './shaders'

/**
 * The grid's antialiasing rule: a line's total brightness must not depend on
 * where it happens to fall between pixels.
 *
 * The first version of the grid point-sampled a `smoothstep` of the distance
 * to the nearest line, which is the usual way to do it and flickers badly —
 * measured on the real shader, a line's peak pixel swings by half its value as
 * it drifts, and with point sampling that swing lands in the *total* instead
 * of being redistributed. The fix is to integrate coverage over the pixel
 * footprint exactly.
 *
 * The functions below mirror `boxIntegral` / `lineCoverage` in `GRID_BG_FRAG`.
 * They are a port, so the GLSL is the source of truth and the two must be
 * changed together — the last test in this file at least fails loudly if the
 * shader stops using this approach at all. What the port buys is that the
 * conservation property can be checked to floating-point precision, which
 * reading back 8-bit pixels from a real GL context cannot do.
 */

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

/** Antiderivative of the periodic line indicator: half-width `w` on every integer. */
function boxIntegral(x: number, w: number): number {
  const i = Math.floor(x + 0.5)
  return i * 2 * w + clamp(x - i, -w, w)
}

/** Exact fraction of one pixel covered by a unit-spaced family of lines. */
function lineCoverage(t: number, dt: number, w: number): number {
  const f = t - Math.floor(t + 0.5)
  const h = 0.5 * dt
  return clamp((boxIntegral(f + h, w) - boxIntegral(f - h, w)) / dt, 0, 1)
}

/** Half-width in pixels, matching HALF_PX in the shader. */
const HALF_PX = 0.5

/** Total coverage over one full period of the grid, at a given sub-pixel phase. */
function energyOverOnePeriod(spacingPx: number, phase: number): number {
  const dt = 1 / spacingPx
  const w = dt * HALF_PX
  let sum = 0
  for (let k = 0; k < spacingPx; k++) sum += lineCoverage((k + phase) * dt, dt, w)
  return sum
}

describe('grid line coverage', () => {
  it('conserves a line\'s energy at every sub-pixel phase', () => {
    // This is the whole point: the sum across the pixels a line touches is the
    // line's width, full stop — whether it sits on one pixel or straddles two.
    for (const spacingPx of [4, 7, 13, 40, 137]) {
      for (let phase = 0; phase < 1; phase += 0.017) {
        expect(
          energyOverOnePeriod(spacingPx, phase),
          `spacing ${spacingPx}px, phase ${phase.toFixed(3)}`,
        ).toBeCloseTo(2 * HALF_PX, 10)
      }
    }
  })

  it('redistributes rather than discards when a line straddles two pixels', () => {
    const spacingPx = 20
    const dt = 1 / spacingPx
    const w = dt * HALF_PX
    // Dead centre on a pixel: that pixel takes all of it.
    expect(lineCoverage(0, dt, w)).toBeCloseTo(1, 10)
    // Exactly between two: each takes half, and nothing is lost.
    const left = lineCoverage(-0.5 * dt, dt, w)
    const right = lineCoverage(0.5 * dt, dt, w)
    expect(left).toBeCloseTo(0.5, 10)
    expect(right).toBeCloseTo(0.5, 10)
    expect(left + right).toBeCloseTo(1, 10)
  })

  it('converges on average density once lines are closer than a pixel', () => {
    // The degenerate end. Point sampling turns this into moiré; an integral
    // turns it into a flat wash of the right brightness.
    for (const spacingPx of [3, 2, 1.5]) {
      const dt = 1 / spacingPx
      const w = dt * HALF_PX
      let sum = 0
      const samples = 400
      for (let i = 0; i < samples; i++) sum += lineCoverage((i / samples) * dt * spacingPx, dt, w)
      expect(sum / samples, `spacing ${spacingPx}px`).toBeCloseTo(Math.min(1, 2 * HALF_PX / spacingPx), 2)
    }
  })

  it('never exceeds full coverage', () => {
    for (const spacingPx of [0.1, 0.5, 1, 5, 50]) {
      const dt = 1 / spacingPx
      const w = dt * HALF_PX
      for (let phase = 0; phase < 1; phase += 0.05) {
        const c = lineCoverage(phase * dt, dt, w)
        expect(c).toBeGreaterThanOrEqual(0)
        expect(c).toBeLessThanOrEqual(1)
      }
    }
  })

  it('is what the shader actually does', () => {
    // A weak check, but it catches the shader being rewritten back to a
    // point-sampled smoothstep while this file keeps quietly passing.
    expect(GRID_BG_FRAG).toContain('boxIntegral')
    expect(GRID_BG_FRAG).toContain('lineCoverage')
    // The derivative must stay analytic: fwidth quantises to 2×2 quads and
    // spikes where the warp's sign flips. Matching the call, not the word —
    // the shader mentions it in a comment saying why it is not used.
    expect(GRID_BG_FRAG).not.toMatch(/fwidth\s*\(/)
  })
})
