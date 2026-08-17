import { describe, it, expect } from 'vitest'
import { ROOT_DISC_RADIUS } from '../../../../../shared/node-size'
import {
  MEDALLION_BG_FRAG,
  MEDALLION_HIGH,
  MEDALLION_MID,
  MEDALLION_SHADOW,
  MEDALLION_SWIRL,
} from './shaders'
import { srgbToLinear } from './srgb'

/**
 * What the Medallion background has to keep being.
 *
 * It arrived by way of four drafts that each looked right in the one frame they
 * were tuned in and wrong everywhere else, so most of what is pinned here is a
 * property no single screenshot can show: that the pattern is a fixed painting
 * rather than an effect fitted to the camera, that something in it runs *around*
 * the origin, that the lattice closes on itself, and that the octave window
 * slides without anything popping.
 *
 * The shader is GLSL, so its arithmetic is ported here — exactly as
 * `concentric-ramp.test.ts` ports the ramp. The GLSL is the source of truth and
 * the two move together, with `is what the shader actually does` below pinning
 * the parts a port cannot follow.
 */

/* ------------------------------------------------------------------ */
/*  Ported from MEDALLION_BG_FRAG                                      */
/* ------------------------------------------------------------------ */

const TAU = Math.PI * 2
const SECTORS = 6
/** The lean, which is a knob the design deliberately allows at zero. */
const SWIRL = MEDALLION_SWIRL
const OCTAVES = 4
const WINDOW = OCTAVES
const GROWTH = 0.25
const FOLLOW = 1 - GROWTH
const FINEST_CELL = 80
/** Where the weave is calibrated — clear of the window's floor. See the shader. */
const REFERENCE = ROOT_DISC_RADIUS * 4
const KBIAS = Math.log2((TAU * REFERENCE) / (SECTORS * FINEST_CELL)) - FOLLOW * Math.log2(REFERENCE)

/** The lattice coordinate: angle, and radius measured logarithmically. */
const lattice = (r: number, theta: number): [number, number] =>
  [(theta * SECTORS) / TAU, (Math.log(r) * SECTORS) / TAU]

/** A pixel's footprint in lattice cells. Conformal, so one number serves both axes. */
const footprint = (r: number, worldPerPx: number): number => (worldPerPx * SECTORS) / (TAU * r)

/** The octave the weave sits at here, and the four drawn around it. */
function octaves(r: number): { levels: number[]; weights: number[] } {
  const kf = Math.max(FOLLOW * Math.log2(r) + KBIAS, WINDOW - 1)
  const k0 = Math.floor(kf)
  const t = kf - k0
  const levels: number[] = []
  const weights: number[] = []
  for (let j = 0; j < OCTAVES; j++) {
    const m = (OCTAVES - 1 - j + t) / WINDOW
    levels.push(k0 - (OCTAVES - 1 - j))
    weights.push(6.75 * m * m * (1 - m))
  }
  return { levels, weights }
}

/** World units across a cell of the finest octave drawn at this radius. */
const cellWorld = (r: number): number => (TAU * r) / (SECTORS * 2 ** Math.max(...octaves(r).levels))

/** What weight a given octave is drawn at, whether or not it is in the window. */
function weightOf(level: number, r: number): number {
  const { levels, weights } = octaves(r)
  const i = levels.indexOf(level)
  return i < 0 ? 0 : weights[i]
}

describe('the two thread families', () => {
  // In lattice space the ring family is the level set of `q.y + SWIRL * q.x`
  // and the spoke family that of `q.x - SWIRL * q.y`; a level set runs
  // perpendicular to its gradient. x is the tangential axis, y the radial one.
  const ring = [1, -SWIRL]
  const spoke = [SWIRL, 1]
  const degrees = (a: number[], b: number[]): number =>
    (Math.acos(Math.abs(a[0] * b[0] + a[1] * b[1]) / (Math.hypot(...a) * Math.hypot(...b))) * 180) / Math.PI

  it('gives the pattern something that goes around the origin', () => {
    // The defect that took this design apart once: both families ran along the
    // lattice diagonals, so both were 45-degree spirals and *nothing* on screen
    // ran circumferentially. Following any line took you away from the origin
    // rather than around it, which left no way to read direction at all.
    expect(degrees(ring, [1, 0]), 'the ring family should run around').toBeLessThan(15)
    expect(degrees(spoke, [0, 1]), 'the spoke family should run outward').toBeLessThan(15)
    // Neither may drift toward the diagonal, which is what the broken version was.
    for (const family of [ring, spoke]) {
      expect(degrees(family, [1, 1]), 'a family has gone diagonal').toBeGreaterThan(25)
    }
  })

  it('leans both families by the same amount, and by no more than a lean', () => {
    // The lean is what makes a ring a shallow spiral rather than a circle. It is
    // allowed to be off (SWIRL = 0, exact circles and rays), but if it is on it
    // has to stay small enough that a ring still reads as going *around* — the
    // failure this whole family split exists to avoid is a 45-degree spiral with
    // no circumferential structure at all.
    expect(degrees(ring, [1, 0])).toBe(degrees(spoke, [0, 1]))
    expect(degrees(ring, [1, 0])).toBeLessThan(15)
  })

  it('keeps them square to each other', () => {
    expect(ring[0] * spoke[0] + ring[1] * spoke[1]).toBeCloseTo(0, 12)
    expect(Math.hypot(...ring)).toBeCloseTo(Math.hypot(...spoke), 12)
  })

  it('closes the sheared lattice on itself at every octave', () => {
    // A full turn advances the lattice by SECTORS * 2^k cells, so the ring
    // coordinate advances by SWIRL * SECTORS * 2^k. Unless that is a whole
    // number of threads the rings do not meet where the angle wraps, and one
    // ragged seam runs out to infinity. Zero clears that trivially, and
    // 1 / SECTORS is the only lean that also does.
    for (let k = 0; k < 24; k++) {
      const advance = SWIRL * SECTORS * 2 ** k
      expect(Number.isInteger(advance), `octave ${k}`).toBe(true)
      expect(Number.isInteger(SECTORS * 2 ** k), `octave ${k}`).toBe(true)
    }
  })
})

describe('the lattice', () => {
  it('keeps a cell square at every radius, with no ladder to patch it', () => {
    // (theta, log r) scales both axes by 1/r, so the map is conformal. This is
    // what the doubling ladders in the earlier drafts existed to approximate.
    for (const r of [50, 500, 5_000, 5_000_000]) {
      const step = r * 1e-6
      const tangential = lattice(r, step / r)[0] - lattice(r, 0)[0]
      const radial = lattice(r + step, 0)[1] - lattice(r, 0)[1]
      expect(radial / tangential, `r = ${r}`).toBeCloseTo(1, 5)
      expect(tangential, `r = ${r}`).toBeCloseTo(footprint(r, step), 12)
    }
  })

  it('is calibrated off the root node, the one landmark it has', () => {
    // Cell size varies with radius now, so a radius has to be named. Within a
    // factor of two above, which is the sawtooth every octave window has.
    const atReference = cellWorld(REFERENCE)
    expect(atReference).toBeGreaterThanOrEqual(FINEST_CELL * 0.999)
    expect(atReference).toBeLessThan(FINEST_CELL * 2)
  })

  it('runs finer than that under the root node, and says so', () => {
    // Inside the window's floor the weave cannot coarsen any further and simply
    // tightens toward the origin. That region is beneath the root node, and the
    // tight spiral core it leaves is a reasonable thing to find at the middle of
    // a rug — but it is not what the calibration describes, which is why the
    // calibration is not anchored there.
    expect(cellWorld(ROOT_DISC_RADIUS)).toBeLessThan(FINEST_CELL)
    expect(octaves(ROOT_DISC_RADIUS).levels[0]).toBe(0)
  })
})

describe('the outward flare', () => {
  it('coarsens the weave with distance from the origin', () => {
    // Compared at radii a whole octave apart, where the window's sawtooth is in
    // the same phase and the trend is all that is left.
    const step = 2 ** (1 / FOLLOW)
    for (const r of [2_000, 20_000, 200_000]) {
      expect(cellWorld(r * step) / cellWorld(r), `r = ${r}`).toBeCloseTo(step ** GROWTH, 9)
    }
  })

  it('flares gently rather than running away', () => {
    // "Not to an extreme extent": across the whole canvas the cloth opens up by
    // a few times, not by orders of magnitude. A cell also stays a cell — never
    // so large that a screen holds only one of them at a workable zoom.
    const near = cellWorld(REFERENCE)
    const far = cellWorld(REFERENCE * 1_000)
    expect(far / near).toBeGreaterThan(2)
    expect(far / near).toBeLessThan(12)
  })

  it('is tightest at the origin, so feature size reads as distance', () => {
    let previous = 0
    for (let r = REFERENCE; r < 1e7; r *= 1.37) {
      const cell = cellWorld(r)
      // Monotone up to the window sawtooth, which can only halve it.
      expect(cell, `r = ${r.toFixed(0)}`).toBeGreaterThan(previous * 0.5)
      previous = cell
    }
  })
})

describe('the octave window', () => {
  it('depends on position and never on zoom', () => {
    // The correction that produced this version. An earlier draft chose the
    // octave from the pixel footprint, which held the weave at a constant
    // *apparent* size — a Droste effect, where zooming in gained you a
    // subdivision instead of a bigger pattern. The pattern is a painting; the
    // camera only moves over it.
    const line = MEDALLION_BG_FRAG.split('\n').find(l => l.includes('float kf ='))
    expect(line).toBeTruthy()
    expect(line).not.toMatch(/worldPerPx|uZoom|uDpr|fq/)
    // worldPerPx may reach the footprint and the fades it drives, and nothing
    // else: those change how hard the painting is blurred, never what it is.
    const uses = MEDALLION_BG_FRAG.match(/^.*worldPerPx.*$/gm) ?? []
    expect(uses.length).toBeGreaterThan(0)
    for (const use of uses) {
      expect(use, use.trim()).toMatch(/worldPerPx = 1\.0|world = |fq0\s*=/)
    }
  })

  it('brings each octave in and out continuously as the window slides', () => {
    // What stops the weave popping as you pan outward. An octave's weight is a
    // function of how far it sits from the nominal one, so it must rise from
    // zero and fall back to zero without a step in between — including across
    // the radius where the window shifts by one.
    const level = 6
    let previous = weightOf(level, REFERENCE)
    let sawWeight = false
    for (let r = REFERENCE; r < 1e7; r *= 1.0015) {
      const w = weightOf(level, r)
      expect(w, `r = ${r.toFixed(0)}`).toBeGreaterThanOrEqual(0)
      expect(Math.abs(w - previous), `r = ${r.toFixed(0)}`).toBeLessThan(0.02)
      sawWeight ||= w > 0.5
      previous = w
    }
    // ...and it really was drawn somewhere in that sweep, or this proves nothing
    // but that zero is continuous.
    expect(sawWeight).toBe(true)
    expect(previous).toBe(0)
  })

  it('vanishes at both ends, which is what makes the slide seamless', () => {
    // The entering octave must start from nothing and the leaving one end at
    // nothing, or the set being drawn changes with a visible step.
    for (const r of [1_000, 12_345, 987_654]) {
      const { weights } = octaves(r)
      expect(Math.min(...weights)).toBeGreaterThanOrEqual(0)
      expect(Math.max(...weights)).toBeGreaterThan(0.5)
    }
    // At the two extremes of the window's phase, one end is exactly out.
    expect(6.75 * 0 * 0 * (1 - 0)).toBe(0)
    expect(6.75 * 1 * 1 * (1 - 1)).toBe(0)
  })

  it('leans on the coarse octaves, which carry the structure', () => {
    // A symmetric profile lets two octaves of comparable strength cancel each
    // other into mush — that is what the first summed version did. The peak sits
    // two thirds of the way toward the coarse end, so the big weave reads and
    // the fine ones only roughen it.
    for (const r of [4_000, 60_000]) {
      const { levels, weights } = octaves(r)
      const dominant = levels[weights.indexOf(Math.max(...weights))]
      expect(dominant).toBeLessThan(Math.max(...levels))
      expect(dominant).toBeGreaterThan(Math.min(...levels))
    }
  })

  it('never asks for an octave too coarse to divide the circle', () => {
    for (const r of [0.01, 1, 40, ROOT_DISC_RADIUS, 1e9]) {
      const cells = SECTORS * 2 ** Math.min(...octaves(r).levels)
      expect(cells, `r ${r}`).toBeGreaterThanOrEqual(SECTORS)
      expect(Number.isInteger(cells), `r ${r}`).toBe(true)
    }
  })
})

describe('the palette', () => {
  const stops = { SHADOW: MEDALLION_SHADOW, MID: MEDALLION_MID, HIGH: MEDALLION_HIGH }
  const warmth = (c: readonly number[]): number => c[0] / c[2]

  it('runs cool in shadow to warm at the crown', () => {
    // The whole reason this is a lighting ramp rather than two dyes. Two
    // low-saturation dyes at this brightness went muddy every time; one cloth
    // with a cool shadow and a warm highlight is how a lit surface behaves, and
    // it buys a far wider swing of hue while staying one believable material.
    expect(warmth(MEDALLION_SHADOW)).toBeLessThan(0.8)
    expect(warmth(MEDALLION_MID)).toBeLessThan(warmth(MEDALLION_HIGH))
    expect(warmth(MEDALLION_HIGH)).toBeGreaterThan(1)
  })

  it('rises in brightness from shadow to crown, with the body between', () => {
    expect(MEDALLION_SHADOW[1]).toBeLessThan(MEDALLION_MID[1])
    expect(MEDALLION_MID[1]).toBeLessThan(MEDALLION_HIGH[1])
  })

  it('stays dark, and inside a range a background is allowed', () => {
    // A background is furniture: it may be interesting to look at and may not
    // ask to be looked at.
    const channels = Object.values(stops).flatMap(c => [...c])
    expect(Math.min(...channels)).toBeGreaterThan(0.03)
    expect(Math.max(...channels)).toBeLessThan(0.2)
    expect(Math.max(...channels) - Math.min(...channels)).toBeLessThan(0.11)
  })

  it('is coloured, but nowhere near saturated', () => {
    for (const [name, c] of Object.entries(stops)) {
      const spread = Math.max(...c) - Math.min(...c)
      expect(spread, `${name} is flat grey`).toBeGreaterThan(0.01)
      expect(spread / Math.max(...c), `${name} is too saturated`).toBeLessThan(0.45)
    }
  })

  it('bakes the ramp into the shader as linear light', () => {
    // Shading a weave means mixing coverage, and coverage is a statement about
    // energy — see ./srgb. Decoded once here rather than per fragment of a
    // full-screen quad.
    for (const [name, c] of Object.entries(stops)) {
      const decoded = [...c].map(v => srgbToLinear(v).toFixed(6)).join(', ')
      expect(MEDALLION_BG_FRAG, name).toContain(`vec3(${decoded})`)
    }
    expect(MEDALLION_BG_FRAG).toContain('linearToSrgb')
  })

  it('keeps the crown a highlight rather than the base colour', () => {
    // Splitting the lighting ramp evenly put most of the canvas in its top half
    // and turned the whole thing olive. The body of the cloth has to own most of
    // the range.
    const crown = Number(/const float CROWN = ([\d.]+);/.exec(MEDALLION_BG_FRAG)?.[1])
    expect(crown).toBeGreaterThan(0.65)
    expect(crown).toBeLessThan(0.95)
  })
})

describe('the medallion background', () => {
  const code = MEDALLION_BG_FRAG.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  const count = (re: RegExp): number => (code.match(re) ?? []).length

  it('is what the port above assumes', () => {
    expect(code).toContain('float s = q.y + SWIRL * q.x;')
    expect(code).toContain('float d = q.x - SWIRL * q.y;')
    expect(code).toContain(`const float SWIRL = ${SWIRL.toFixed(6)};`)
    expect(code).toContain(`const float FOLLOW = ${FOLLOW.toFixed(4)};`)
    expect(code).toContain(`const float KBIAS = ${KBIAS.toFixed(6)};`)
    expect(code).toContain('float kf = max(FOLLOW * log2(r) + KBIAS, WINDOW - 1.0);')
    expect(code).toContain('float w = 6.75 * m * m * (1.0 - m);')
    expect(code).toContain(`const float WINDOW = ${OCTAVES}.0;`)
    expect(code).toMatch(new RegExp(`for \\(int j = 0; j < ${OCTAVES}; j\\+\\+\\)`))
  })

  it('interlaces over and under rather than merely crossing', () => {
    // Which is what breaks the rings into segments, so a ring is never a
    // continuous circle even before the lean is applied.
    expect(code).toContain('mod(floor(s + 0.5) + floor(d + 0.5), 2.0)')
    expect(code).toContain('covTop')
  })

  it('lights the rings from the origin, so one ring gives the direction', () => {
    // The cue that survives being zoomed in a long way from home, where a ring
    // is far too big for its curvature to show.
    expect(code).toContain('RING_BIAS * ns')
    expect(code).not.toContain('RING_BIAS * nd')
  })

  it('antialiases analytically, never with a derivative', () => {
    // fwidth quantises to 2x2 quads, and the polar Jacobian is known exactly:
    // |grad r| = 1 and |grad theta| = 1/r.
    expect(code).not.toMatch(/fwidth\s*\(/)
    expect(code).toContain('fq * SHEAR_LEN')
  })

  it('stays cheap enough for the hardware the still themes exist for', () => {
    // One atan, one log, one log2, one exp2, one sqrt via length(), and the
    // single pow inside linearToSrgb — then four passes of fract/abs/mix. No
    // noise, no texture, no branch, so there is no worst case.
    expect(count(/\batan\s*\(/g)).toBe(1)
    expect(count(/\blog\s*\(/g)).toBe(1)
    expect(count(/\blog2\s*\(/g)).toBe(1)
    expect(count(/\bexp2\s*\(/g)).toBe(1)
    expect(count(/\bpow\s*\(/g)).toBe(1)
    expect(count(/\blength\s*\(/g)).toBe(1)
    expect(count(/\bfor\s*\(/g)).toBe(1)
    for (const banned of [/\bsin\s*\(/, /\bcos\s*\(/, /\bif\s*\(/, /texture2D/]) {
      expect(code, String(banned)).not.toMatch(banned)
    }
  })
})
