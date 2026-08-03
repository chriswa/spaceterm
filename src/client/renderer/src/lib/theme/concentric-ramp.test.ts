import { describe, it, expect } from 'vitest'
import { ROOT_DISC_RADIUS, ROOT_NODE_RADIUS } from '../../../../../shared/node-size'
import { CONCENTRIC_DARK, CONCENTRIC_PALE, CONCENTRIC_BG_FRAG } from './shaders'
import { linearEmission, srgbToLinear } from './srgb'

/**
 * The concentric background's antialiasing rule: what a pixel shows must be the *average* of
 * the pattern over that pixel, not the pattern sampled at its centre.
 *
 * An earlier version of this background point-sampled a `smoothstep` of the
 * distance to the nearest edge, which is the usual way to do it and crawls
 * badly — the transition's width and position both wobble as the edge drifts
 * against the pixel grid. The fix is to integrate the pattern over the pixel
 * footprint exactly.
 *
 * The functions below mirror `rampIntegral` / `rampTone` in `CONCENTRIC_BG_FRAG`.
 * They are a port, so the GLSL is the source of truth and the two must be
 * changed together — one test here at least fails loudly if the shader stops
 * using this approach at all. What the port buys is that the averaging
 * property can be checked to floating-point precision, which reading back
 * 8-bit pixels from a real GL context cannot do.
 */

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

/**
 * Easing exponent. The shader spells the cubic out as multiplications rather
 * than a `pow` with a named exponent, so this port is where the curve is
 * written as a number — the two move together, and `is what the shader
 * actually does` below pins the arithmetic that has to agree.
 */
const EASE = 3
/** Mean tone over one period — the background's average brightness. */
const MEAN = 1 / (EASE + 1)

/**
 * Antiderivative of the ramp: a unit-period sawtooth rising 0 to 1 across each
 * period and dropping back at the boundary.
 */
function rampIntegral(x: number): number {
  const i = Math.floor(x)
  const f = x - i
  return i * MEAN + f ** (EASE + 1) * MEAN
}

/** The ramp itself, for asserting against the eased shape rather than a line. */
const ideal = (radii: number): number => (radii - Math.floor(radii)) ** EASE

/** Exact average tone over one pixel, with `u` in periods and `du` its footprint. */
function rampTone(u: number, du: number): number {
  const h = 0.5 * du
  const hi = u + h
  // A pixel astride the origin has no negative radius to average over — its
  // footprint folds back outward.
  const folded = Math.max(h - u, 0)
  const lo = Math.max(u - h, 0)
  const n = Math.floor(lo)
  return clamp((rampIntegral(hi - n) - rampIntegral(lo - n) + rampIntegral(folded)) / du, 0, 1)
}

/** Tone at a pixel `radii` root-radii from the origin, with `periodPx` per ramp. */
const at = (radii: number, periodPx: number): number => rampTone(radii, 1 / periodPx)

describe('radial ramp', () => {
  it('brightens with distance, then drops back at the cliff', () => {
    // The shape in one assertion: monotonic up across a period, and far lower
    // just after the boundary than just before it.
    const periodPx = 400
    let previous = -1
    for (let radii = 1.02; radii < 1.98; radii += 0.02) {
      const tone = at(radii, periodPx)
      expect(tone, `${radii.toFixed(2)} radii out`).toBeGreaterThan(previous)
      previous = tone
    }
    expect(at(1.99, periodPx)).toBeGreaterThan(0.95)
    expect(at(2.01, periodPx)).toBeLessThan(0.05)
    // Eased, not linear: the halfway point is well down toward the dark end.
    expect(at(1.5, periodPx)).toBeLessThan(0.25)
  })

  it('runs the full range of the ramp in every period', () => {
    // Not a decaying or a growing pattern: each period covers the same two
    // greys end to end, however far out it is.
    const periodPx = 400
    for (const cycle of [0, 1, 7, 250]) {
      expect(at(cycle + 0.005, periodPx), `cycle ${cycle}`).toBeLessThan(0.02)
      expect(at(cycle + 0.995, periodPx), `cycle ${cycle}`).toBeGreaterThan(0.97)
      // With a footprint this small the average is the curve itself.
      for (const phase of [0.25, 0.5, 0.75]) {
        expect(at(cycle + phase, periodPx), `cycle ${cycle}, ${phase}`)
          .toBeCloseTo(ideal(phase), 3)
      }
    }
  })

  it('spends exactly one pixel on the cliff, wherever it falls', () => {
    const periodPx = 400
    const px = 1 / periodPx
    for (let phase = 0; phase < 1; phase += 0.05) {
      // The pixel straddling the cliff averages the two sides; the pixels
      // either side of it are already back on the ramp proper.
      const cliff = 1 + (phase - 0.5) * px
      expect(at(cliff - px, periodPx), `phase ${phase.toFixed(2)}`).toBeGreaterThan(0.98)
      expect(at(cliff + px, periodPx), `phase ${phase.toFixed(2)}`).toBeLessThan(0.01)
    }
  })

  it('conserves the light over a period however the cliff falls between pixels', () => {
    // The averaging property, stated as a sum: a period of pixels emits the
    // same total whatever sub-pixel phase it starts at. This is what stops the
    // cliff from thickening and thinning, and the field from pulsing, as you
    // pan.
    const periodPx = 200
    const px = 1 / periodPx
    for (let phase = 0; phase < 1; phase += 0.017) {
      let sum = 0
      for (let k = 0; k < periodPx; k++) sum += at(1 + (k + phase) * px, periodPx)
      expect(sum, `phase ${phase.toFixed(3)}`).toBeCloseTo(MEAN * periodPx, 9)
    }
  })

  it('converges on the ramp\'s mean once a period is thinner than a pixel', () => {
    // The degenerate end. Point sampling turns this into moiré; an integral
    // turns it into a flat wash of the right brightness, approached as 1/du —
    // the residue is the partial period at the end of the footprint, and it
    // can only shrink. The shader then fades that wash out (see MIN_PX), but
    // it must not alias on the way there.
    let previousBound = 1
    for (const periodPx of [0.5, 0.2, 0.05]) {
      const du = 1 / periodPx
      const bound = 0.5 / du
      expect(bound).toBeLessThan(previousBound)
      previousBound = bound
      for (let radii = 10; radii < 12; radii += 0.137) {
        expect(
          Math.abs(at(radii, periodPx) - MEAN),
          `${periodPx}px periods, ${radii.toFixed(3)} radii out`,
        ).toBeLessThanOrEqual(bound + 1e-9)
      }
    }
  })

  it('never leaves the two greys it is mixing', () => {
    for (const periodPx of [0.1, 1, 400]) {
      for (let radii = 0; radii < 4; radii += 0.03) {
        const tone = at(radii, periodPx)
        expect(tone).toBeGreaterThanOrEqual(0)
        expect(tone).toBeLessThanOrEqual(1)
      }
    }
  })

  it('puts the first cliff on the root node\'s rim', () => {
    // The relationship the whole pattern hangs off: one ramp per root radius,
    // so the node's edge and the first cliff are the same circle, and every
    // cliff after it is a whole number of root radii out.
    expect(CONCENTRIC_BG_FRAG).toContain(`const float PERIOD     = ${ROOT_DISC_RADIUS.toFixed(1)};`)
    // The circle that is drawn, not the box around it. These differ, and using
    // the box put every cliff about 40% too far out — the bug this pins.
    expect(ROOT_DISC_RADIUS).toBeLessThan(ROOT_NODE_RADIUS)
    expect(CONCENTRIC_BG_FRAG).not.toContain(`= ${ROOT_NODE_RADIUS.toFixed(1)};`)
    // The origin is the bottom of the first ramp at every zoom the ramp is a
    // ramp — the centre pixel averages a folded footprint rather than the
    // bright end of the period behind it. Below that it converges on the same
    // wash as everywhere else, which MIN_PX then fades out.
    for (const periodPx of [1, 4, 400]) {
      expect(at(0, periodPx), `${periodPx}px periods`).toBeLessThan(0.5 / periodPx + 1e-9)
    }
  })

  it('is what the shader actually does', () => {
    // Weak checks, but they catch the shader being rewritten back to a
    // point-sampled smoothstep, or losing the reset, while this file keeps
    // quietly passing.
    expect(CONCENTRIC_BG_FRAG).toContain('rampIntegral')
    expect(CONCENTRIC_BG_FRAG).toContain('rampTone')
    // The port above hardcodes the exponent; the shader spells the same curve
    // out as `(i + f2 * f2) * MEAN` and states the mean as a literal. Both
    // halves are pinned, because a `pow` traded for multiplications is exactly
    // the kind of edit that silently changes the curve.
    expect(CONCENTRIC_BG_FRAG).toContain('float f2 = f * f;')
    expect(CONCENTRIC_BG_FRAG).toContain('return (i + f2 * f2) * MEAN;')
    expect(CONCENTRIC_BG_FRAG).toContain(`const float MEAN = ${MEAN};`)
    // Eased toward the dark end, which is the whole reason it is not linear.
    expect(EASE).toBeGreaterThan(1)
    // And no `pow` left in the ramp: three per fragment on a full-screen quad
    // was the reason for spelling it out. `linearToSrgb` keeps its own — that
    // one is the real sRGB curve and is not negotiable.
    expect(CONCENTRIC_BG_FRAG.match(/pow\s*\(/g) ?? []).toHaveLength(1)
    // Evenly spaced: the radius is divided by a constant, with no log warp.
    expect(CONCENTRIC_BG_FRAG).toMatch(/length\s*\(\s*world\s*\)\s*\/\s*PERIOD/)
    expect(CONCENTRIC_BG_FRAG).not.toMatch(/\blog\s*\(/)
    // The footprint must stay analytic: fwidth quantises to 2×2 quads.
    // Matching the call, not the word — the shader mentions it in a comment
    // saying why it is not used.
    expect(CONCENTRIC_BG_FRAG).not.toMatch(/fwidth\s*\(/)
  })
})

/**
 * The second half of the same property. An exact tone only removes the crawl
 * if the tone is then used to mix *light*; mixing the sRGB-encoded values
 * instead throws most of the win away, and over a gradient this wide and this
 * shallow that is what shows up as contour banding.
 */
describe('concentric ramp colours', () => {
  /** Linear light emitted at a given point on the ramp. */
  const emit = (tone: number): number =>
    srgbToLinear(CONCENTRIC_DARK[0]) + tone * linearEmission(CONCENTRIC_DARK, CONCENTRIC_PALE)[0]

  /** The same, for the old shortcut: mix the encoded values, then decode. */
  const emitEncoded = (tone: number): number =>
    srgbToLinear(CONCENTRIC_DARK[0] + (CONCENTRIC_PALE[0] - CONCENTRIC_DARK[0]) * tone)

  it('is a straight line in light from one grey to the other', () => {
    const dark = srgbToLinear(CONCENTRIC_DARK[0])
    const whole = emit(1) - dark
    for (const split of [0.5, 0.25, 0.1, 0.02]) {
      // Affine in the tone: two points on the ramp summing to 1 emit the same
      // total as one point at the top, which is what makes a pixel's average
      // tone the right thing to hand it.
      const parts = (emit(split) - dark) + (emit(1 - split) - dark)
      expect(parts, `split ${split}`).toBeCloseTo(whole, 12)
    }
  })

  it('would bend that line if it composited in sRGB instead', () => {
    // What justifies decoding the pair in TypeScript: the midpoint of the ramp
    // would emit measurably less than half the step between the two greys.
    const dark = srgbToLinear(CONCENTRIC_DARK[0])
    const whole = emitEncoded(1) - dark
    const halved = 2 * (emitEncoded(0.5) - dark)
    expect(halved / whole).toBeLessThan(0.98)
    expect(halved / whole).toBeGreaterThan(0.8)
  })

  it('ramps between two dark greys of the same hue', () => {
    // Both dark: neither end may read as lit. sRGB, because that is the space
    // the pair was picked in.
    for (const [name, c] of [['dark', CONCENTRIC_DARK], ['pale', CONCENTRIC_PALE]] as const) {
      for (const ch of c) {
        expect(ch, `${name} channel`).toBeGreaterThan(0.05)
        expect(ch, `${name} channel`).toBeLessThan(0.25)
      }
    }
    // Separated enough for the cliff to resolve as an edge, not so much that
    // the pattern competes with the cards in front of it.
    const step = CONCENTRIC_PALE.map((c, i) => c - CONCENTRIC_DARK[i])
    for (const d of step) {
      expect(d).toBeGreaterThan(0.02)
      expect(d).toBeLessThan(0.08)
    }
    // Same cool cast at both ends, or the ramp reads as a shift in material
    // rather than in tone. Channel ratios, which is where a hue change shows.
    const ratio = (c: readonly number[]): number[] => [c[0] / c[2], c[1] / c[2]]
    const [dr, dg] = ratio(CONCENTRIC_DARK)
    const [pr, pg] = ratio(CONCENTRIC_PALE)
    expect(pr).toBeCloseTo(dr, 1)
    expect(pg).toBeCloseTo(dg, 1)
  })

  it('draws the ramp between two colours and no more', () => {
    // The ramp carries no hierarchy, so a second emission constant in the
    // shader means a tier has crept back in.
    expect(CONCENTRIC_BG_FRAG.match(/const vec3 E_/g) ?? []).toHaveLength(1)
  })

  it('bakes the emission constant into the shader rather than encoding a mix', () => {
    expect(CONCENTRIC_BG_FRAG).toContain('linearToSrgb')
    // Mixing the encoded pair in the shader is the shortcut this replaced.
    expect(CONCENTRIC_BG_FRAG).not.toMatch(/mix\s*\(\s*DARK/)
    const e = linearEmission(CONCENTRIC_DARK, CONCENTRIC_PALE)[0].toFixed(6)
    expect(CONCENTRIC_BG_FRAG).toContain(`vec3(${e},`)
  })
})
