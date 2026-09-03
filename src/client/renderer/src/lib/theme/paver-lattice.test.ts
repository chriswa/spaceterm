import { describe, it, expect } from 'vitest'
import { ROOT_DISC_RADIUS } from '../../../../../shared/node-size'
import { PAVER_BG_FRAG, PAVER_LATTICE } from './paver-background'

/**
 * What the paver background has to keep being.
 *
 * How a stone *looks* is taste, and taste is checked by looking. What is pinned
 * is the masonry — the properties that make it read as radial brickwork and
 * that no single screenshot would show failing:
 *
 * - the courses open up outward at a stated rate, which is how far-from-home
 *   reads off the canvas, and a course boundary sits on the root disc's rim;
 * - every course has a whole number of stones, so the ring closes on itself;
 * - a stone has the same proportions in every course past the first few, and
 *   the few where it does not — the wedges — are under the root node;
 * - the pixel footprint is exact, so nothing has to guess at a derivative;
 * - and each scale of detail is retired *before* it goes sub-pixel, finest
 *   first, so a zoomed-out canvas is dark ground and never a shimmer.
 *
 * The shader is GLSL, so its arithmetic is ported here, as
 * `medallion-lattice.test` does for the weave. The GLSL is the source of truth;
 * `is what the shader actually does` pins the parts a port cannot follow.
 */

const {
  GROWTH,
  FOLLOW,
  RIM_COURSE,
  COURSE_AT_RIM,
  ASPECT,
  MIN_PAVERS,
  JOINT,
  BAND,
  WARP,
  WARP_WAVELENGTH,
  GRAIN_OCTAVES,
} = PAVER_LATTICE
const TAU = Math.PI * 2
const WAVELENGTHS = GRAIN_OCTAVES.map(([wavelength]) => wavelength)
/** What a stone aims to be, at the rim. */
const PAVER_AT_RIM = ASPECT * COURSE_AT_RIM

/* ------------------------------------------------------------------ */
/*  Ported from PAVER_BG_FRAG                                          */
/* ------------------------------------------------------------------ */

/** The course coordinate: courses are its whole values. */
const courseCoord = (r: number): number => RIM_COURSE * (r / ROOT_DISC_RADIUS) ** FOLLOW
const courseAt = (r: number): number => Math.floor(courseCoord(r))

/** The radius at a given course coordinate — the inverse of the above. */
const radiusAt = (v: number): number => ROOT_DISC_RADIUS * (v / RIM_COURSE) ** (1 / FOLLOW)

/** World units from one course boundary to the next, at this radius. */
const depth = (r: number): number => r / (FOLLOW * courseCoord(r))

/** Stones around a course: as many as fit at the target aspect, never fewer than the floor. */
const count = (row: number): number =>
  Math.max(Math.floor((TAU * FOLLOW * (row + 0.5)) / ASPECT + 0.5), MIN_PAVERS)

/** A stone's arc width at the middle of its course, in world units. */
const width = (row: number): number => (TAU * radiusAt(row + 0.5)) / count(row)

/** How much wider than deep a stone is, at the middle of its course. */
const aspect = (row: number): number => width(row) / depth(radiusAt(row + 0.5))

const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1)
  return t * t * (3 - 2 * t)
}
const quietStone = (courseDepth: number, fp: number): number =>
  smoothstep(courseDepth / 3, courseDepth / 14, fp)
const grainAlive = (wavelength: number, fp: number): number =>
  smoothstep(wavelength * 0.5, wavelength * 0.17, fp)

/** Radii spread over the whole range the canvas is ever panned across. */
const RADII = [400, 1_000, 2_512, 6_310, 15_800, 39_800, 100_000, 251_000, 1e6]
/** Courses likewise. */
const ROWS = [2, 3, 4, 6, 10, 25, 60, 150, 400, 1_000, 3_000]

describe('the courses', () => {
  it('open up as r ** GROWTH, which is what says how far out you are', () => {
    // Medallion's rate, kept so the two still themes agree on what "far out"
    // looks like. Continuous in r, so nothing breathes.
    for (const r of RADII) {
      expect(depth(r * 10) / depth(r), `r = ${r}`).toBeCloseTo(10 ** GROWTH, 9)
    }
  })

  it('flare gently rather than running away', () => {
    // Ten times further out is under twice as deep, and a thousand times out
    // under six. Across the whole canvas the floor opens by a few times, not by
    // orders of magnitude.
    expect(depth(ROOT_DISC_RADIUS * 10) / depth(ROOT_DISC_RADIUS)).toBeLessThan(2)
    expect(depth(ROOT_DISC_RADIUS * 1000) / depth(ROOT_DISC_RADIUS)).toBeLessThan(6)
  })

  it('put a boundary exactly on the root disc\'s rim, the one landmark the canvas has', () => {
    expect(courseCoord(ROOT_DISC_RADIUS)).toBeCloseTo(RIM_COURSE, 9)
    expect(Number.isInteger(RIM_COURSE)).toBe(true)
    expect(courseAt(0)).toBe(0)
  })

  it('are a workable size next to a card', () => {
    // The pitch of everything. Too shallow and the floor is cobbles that read
    // as texture; too deep and a screen holds two courses.
    expect(depth(ROOT_DISC_RADIUS)).toBeCloseTo(COURSE_AT_RIM, 9)
    expect(COURSE_AT_RIM).toBeGreaterThan(160)
    expect(COURSE_AT_RIM).toBeLessThan(320)
    expect(depth(ROOT_DISC_RADIUS * 100)).toBeLessThan(900)
  })
})

describe('the stones', () => {
  it('close the ring: every course has a whole number of them', () => {
    // The angular coordinate advances by exactly `count` where theta wraps at
    // ±PI. Unless that is a whole number the joints fail to meet along the -x
    // axis, at every radius, forever.
    for (const row of ROWS) {
      expect(Number.isInteger(count(row)), `row ${row}`).toBe(true)
      expect(count(row), `row ${row}`).toBeGreaterThanOrEqual(MIN_PAVERS)
    }
  })

  it('keep the same proportions everywhere past the first few courses', () => {
    // A stone is never more than half a stone's width from the target aspect,
    // and the further out the finer the rounding gets. Past the root disc it
    // is within a tenth; a few courses on, within a couple of percent.
    for (const row of ROWS) {
      const off = Math.abs(aspect(row) - ASPECT) / ASPECT
      expect(off, `row ${row}`).toBeLessThan(1 / (2 * count(row)) + 1e-9)
    }
    expect(Math.abs(aspect(RIM_COURSE) - ASPECT) / ASPECT).toBeLessThan(0.1)
    expect(Math.abs(aspect(20) - ASPECT) / ASPECT).toBeLessThan(0.02)
    expect(Math.abs(aspect(1_000) - ASPECT) / ASPECT).toBeLessThan(0.001)
  })

  it('lean wide, like brickwork, and never so wide as to read as a slab', () => {
    for (const row of ROWS) {
      expect(aspect(row), `row ${row}`).toBeGreaterThan(1.1)
      expect(aspect(row), `row ${row}`).toBeLessThan(1.6)
    }
  })

  it('grow with the course, so a stone far out is a larger stone', () => {
    // The point of the growth: the stone, not only the course, is the cue.
    expect(width(ROWS[ROWS.length - 1]) / width(RIM_COURSE)).toBeGreaterThan(2)
  })

  it('are wedges only where the root node hides them', () => {
    // A course that wants fewer stones than the floor is cut into MIN_PAVERS
    // wedges instead. Those are the courses whose stones are badly out of
    // shape, and every one of them has to lie inside the root disc.
    const wedgeRows = []
    for (let row = 0; row < 20; row++) {
      if (count(row) === MIN_PAVERS) wedgeRows.push(row)
    }
    expect(wedgeRows.length).toBeGreaterThan(0)
    for (const row of wedgeRows) {
      // The course's outer edge, in world units.
      expect(radiusAt(row + 1), `row ${row}`).toBeLessThanOrEqual(ROOT_DISC_RADIUS + 1e-9)
    }
    // ...and the first course past the rim is already more stone than wedge,
    // and the one after it is paving.
    expect(count(RIM_COURSE)).toBeGreaterThanOrEqual(8)
    expect(count(RIM_COURSE + 1)).toBeGreaterThanOrEqual(12)
  })

  it('leave a joint that is narrow against the stone', () => {
    expect((2 * JOINT) / PAVER_AT_RIM).toBeLessThan(0.1)
  })

  it('are roughened, not bent: a small push on a wavelength well under a stone', () => {
    // Enough warp to lose the grid, not enough to lose the ring or to make a
    // stone bulge. A stone moves by a hundredth or two of its width, and the
    // field turns over several times within one stone, so an edge is rough
    // rather than bowed.
    expect(WARP / PAVER_AT_RIM).toBeLessThan(0.03)
    expect(WARP / PAVER_AT_RIM).toBeGreaterThan(0.005)
    expect(WARP_WAVELENGTH).toBeLessThan(PAVER_AT_RIM / 5)
    expect(WARP_WAVELENGTH).toBeGreaterThan(4 * WARP)
  })

  it('lay a darker course on a rhythm that survives past the stones', () => {
    // The soldier course is the one navigation cue the floor keeps at the zoom
    // floor. Its period has to be comfortably above a pixel at the smallest
    // zoom the camera allows (0.005), or it aliases into a moire instead — and
    // courses only get deeper from the rim outward.
    expect(BAND * COURSE_AT_RIM * 0.005).toBeGreaterThan(2)
  })
})

describe('the pixel footprint', () => {
  it('is exact, so nothing has to guess at a derivative', () => {
    // The stone's frame is in world units and the course depth is dr/dv in
    // closed form, so a pixel's footprint across the frame is worldPerPx
    // itself. Compared against a numerical derivative of the coordinate the
    // shader actually uses.
    for (const r of RADII) {
      const step = r * 1e-7
      const dv = courseCoord(r + step) - courseCoord(r)
      expect((step / depth(r)) / dv, `r = ${r}`).toBeCloseTo(1, 6)
    }
  })
})

describe('going quiet', () => {
  it('retires the stones while they are still several pixels across', () => {
    // Fading to the ground, not to the stones' own average: a floor averaged
    // over a pixel is a mid-grey sheet, and a background that turns into a
    // sheet the moment it is zoomed out is the one failure this may not have.
    for (const r of RADII) {
      const courseDepth = depth(r)
      expect(quietStone(courseDepth, courseDepth / 40), `r = ${r}`).toBeGreaterThan(0.99) // 40px: drawn
      expect(quietStone(courseDepth, courseDepth / 2), `r = ${r}`).toBe(0) // 2px: gone
    }
  })

  it('retires the grain finest first, each before it goes sub-pixel', () => {
    for (const wavelength of WAVELENGTHS) {
      expect(grainAlive(wavelength, wavelength / 8), `λ = ${wavelength}`).toBeGreaterThan(0.99)
      expect(grainAlive(wavelength, wavelength / 2), `λ = ${wavelength}`).toBe(0)
    }
    // At one footprint, the finest octave is gone before the coarsest starts to go.
    const finest = Math.min(...WAVELENGTHS)
    const coarsest = Math.max(...WAVELENGTHS)
    expect(grainAlive(finest, finest)).toBe(0)
    expect(grainAlive(coarsest, finest)).toBeGreaterThan(0.99)
  })

  it('retires the grain before the stones', () => {
    // Otherwise a stone would be a sparkle of grain with no outline. At six
    // pixels a course the stones are still mostly drawn and every octave of
    // grain, the coarsest included, has already gone — and that only gets
    // easier as the courses deepen outward.
    const fp = COURSE_AT_RIM / 6
    expect(quietStone(COURSE_AT_RIM, fp)).toBeGreaterThan(0.5)
    for (const wavelength of WAVELENGTHS) {
      expect(grainAlive(wavelength, fp), `λ = ${wavelength}`).toBe(0)
    }
  })
})

describe('the shader', () => {
  const src = PAVER_BG_FRAG
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  const count = (re: RegExp): number => (code.match(re) ?? []).length

  it('is what the port above assumes', () => {
    expect(code).toContain('float lr = log2(r * INV_RIM);')
    expect(code).toContain('float v = RIM_COURSE * exp2(FOLLOW * lr);')
    expect(code).toContain('float row = floor(v);')
    expect(code).toContain('float depth = r / (FOLLOW * v);')
    expect(code).toContain('float count = max(floor(TAU * FOLLOW * (row + 0.5) / ASPECT + 0.5), MIN_PAVERS);')
    expect(code).toContain('float cell = mod(floor(a), count);')
    expect(code).toContain('float width = TAU * r / count;')
    expect(code).toContain('vec2 warped = world + (vnoise2(world * WARP_SCALE) - 0.5) * (2.0 * WARP);')
    expect(code).toContain(`const float FOLLOW  = ${FOLLOW.toFixed(4)};`)
    expect(code).toContain(`const float RIM_COURSE = ${RIM_COURSE}.0;`)
    expect(code).toContain(`const float INV_RIM = ${(1 / ROOT_DISC_RADIUS).toFixed(9)};`)
    expect(code).toContain(`const float ASPECT  = ${ASPECT.toFixed(4)};`)
    expect(code).toContain(`const float MIN_PAVERS = ${MIN_PAVERS}.0;`)
    expect(code).toContain(`const float BAND    = ${BAND}.0;`)
    expect(code).toContain(`const float WARP    = ${WARP.toFixed(2)};`)
    expect(code).toContain(`const float WARP_SCALE = ${(1 / WARP_WAVELENGTH).toFixed(6)};`)
    expect(code).toContain('smoothstep(depth / 3.0, depth / 14.0, worldPerPx)')
    expect(code).toContain('smoothstep(wavelength * 0.5, wavelength * 0.17, fp)')
  })

  it('is a painting: zoom reaches the footprint and nothing else', () => {
    // If the course a pixel is in, or the number of stones around it, could be
    // read off the camera, zooming in would gain you a subdivision instead of
    // a bigger stone — a Droste effect. worldPerPx may reach the world position
    // and the fades, and those only decide how much of the same painting shows.
    for (const line of code.split('\n')) {
      if (/\b(float (lr|v|row|depth|mid|count|cell|fx|fy|width|phase)|vec2 warped) =/.test(line)) {
        expect(line, line.trim()).not.toMatch(/uZoom|uDpr|worldPerPx/)
      }
    }
  })

  it('antialiases analytically, and never with a derivative', () => {
    // Every gradient is in world units, so the footprint is worldPerPx itself.
    // fwidth would quantise it to 2x2 quads and would need an extension.
    expect(code).not.toMatch(/fwidth\s*\(/)
    expect(code).not.toMatch(/#extension/)
  })

  it('stays cheap: one atan, one log2, one exp2, no loop, no branch, no texture', () => {
    expect(count(/\batan\s*\(/g)).toBe(1)
    expect(count(/\blog2\s*\(/g)).toBe(1)
    expect(count(/\bexp2\s*\(/g)).toBe(1)
    expect(count(/\bpow\s*\(/g)).toBe(1) // linearToSrgb
    expect(count(/\blength\s*\(/g)).toBe(2) // the radius, and the stone's distance field
    for (const banned of [/\bfor\s*\(/, /\bif\s*\(/, /\bsin\s*\(/, /\bcos\s*\(/, /\blog\s*\(/, /\bexp\s*\(/, /texture2D/]) {
      expect(code, String(banned)).not.toMatch(banned)
    }
  })

  it('holds still: it never reads the clock', () => {
    expect(code).not.toMatch(/\biTime\b/)
  })

  it('composites in linear light and encodes once at the end', () => {
    expect(src).toContain('linearToSrgb(col)')
    expect(count(/linearToSrgb/g)).toBe(2) // the definition and the one use
  })

  it('is grey, and dark enough to be furniture', () => {
    const tones = [...src.matchAll(/const vec3 (GROUND|MORTAR|STONE_DARK|STONE_LIGHT) += vec3\(([^)]*)\);/g)]
    expect(tones.map(([, name]) => name).sort()).toEqual(['GROUND', 'MORTAR', 'STONE_DARK', 'STONE_LIGHT'])
    for (const [, name, triple] of tones) {
      const [r, g, b] = triple.split(',').map(Number)
      // Grayscale means grayscale: equal channels, to the printed precision.
      expect(g, name).toBe(r)
      expect(b, name).toBe(r)
      // Linear light, so these are small numbers. The lightest stone is 0.19
      // in sRGB — about 0.03 linear — before it is lit; the ground the floor
      // fades to is darker than any other ground this repo ships.
      expect(r, name).toBeGreaterThan(0.001)
      expect(r, name).toBeLessThan(0.035)
    }
    const ground = tones.find(([, name]) => name === 'GROUND')?.[2].split(',').map(Number)[0] ?? 1
    expect(ground).toBeLessThan(0.006)
  })
})
