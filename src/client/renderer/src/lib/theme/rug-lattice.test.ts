import { describe, it, expect } from 'vitest'
import { ROOT_DISC_RADIUS } from '../../../../../shared/node-size'
import { RUG_BG_FRAGS, RUG_LATTICE } from './rug-backgrounds'

/**
 * What the Rug family has to keep being.
 *
 * Almost nothing here is about how a motif looks — that is taste, and taste is
 * checked by looking. What is pinned is the skeleton all three backgrounds hang
 * on, because every one of its properties is load-bearing and none of them shows
 * up in a single screenshot:
 *
 * - the ornament opens up outward at a stated rate, which is how far-from-home
 *   reads off the canvas;
 * - the pattern closes on itself at the angular seam, or one ragged ray runs out
 *   to infinity;
 * - the cell count's doublings land on row boundaries, which is the whole reason
 *   this family can afford crisp ornament where Medallion had to blur four
 *   octaves together;
 * - a cell stays roughly square, so a lozenge is a lozenge everywhere;
 * - the footprints are exact, so nothing has to guess at a derivative;
 * - and the ornament retires *before* it goes sub-pixel, so a zoomed-out canvas
 *   is dark ground with rings on it and never a pale wash.
 *
 * The shader is GLSL, so its arithmetic is ported here — exactly as
 * `medallion-lattice.test.ts` ports the weave. The GLSL is the source of truth
 * and the two move together, with `is what the shader actually does` below
 * pinning the parts a port cannot follow.
 */

const { GROWTH, FOLLOW, ROWS_AT_DISC, SECTORS, GROUP, TIER } = RUG_LATTICE
const TAU = Math.PI * 2
const LEVEL_BIAS = Math.log2(ROWS_AT_DISC / GROUP)

/* ------------------------------------------------------------------ */
/*  Ported from RUG_SETUP_GLSL                                         */
/* ------------------------------------------------------------------ */

/** The row coordinate: rows are its whole values. */
const rowCoord = (r: number): number => ROWS_AT_DISC * (r / ROOT_DISC_RADIUS) ** FOLLOW

/** The doubling level, and the cells around the ring at that level. */
const level = (r: number): number =>
  Math.max(Math.floor(FOLLOW * Math.log2(r / ROOT_DISC_RADIUS) + LEVEL_BIAS), 0)
const cells = (r: number): number => SECTORS * 2 ** level(r)

/** World units from one row boundary to the next, at this radius. */
const rowHeight = (r: number): number => r / (FOLLOW * rowCoord(r))

/** How much wider than tall a cell is here. */
const aspect = (r: number): number => (TAU * FOLLOW * rowCoord(r)) / cells(r)

/** The pixel footprint on each axis, in cell units. */
const footprintY = (r: number, worldPerPx: number): number => (worldPerPx * FOLLOW * rowCoord(r)) / r
const footprintX = (r: number, worldPerPx: number): number => (worldPerPx * cells(r)) / (TAU * r)

/** Radii spread over the whole range the canvas is ever panned across. */
const RADII = [400, 1_000, 2_512, 6_310, 15_800, 39_800, 100_000, 251_000, 1e6]

describe('the outward growth', () => {
  it('opens the ornament up as r ** GROWTH, which is what says how far out you are', () => {
    // The one property of Medallion this family was told to keep. Row spacing —
    // and with it every cell, since cells are square-ish — grows at exactly this
    // rate, with no sawtooth of any kind in it: the coordinate is continuous in
    // r, so there is no window sliding and nothing to breathe.
    for (const r of RADII) {
      expect(rowHeight(r * 10) / rowHeight(r), `r = ${r}`).toBeCloseTo(10 ** GROWTH, 9)
    }
  })

  it('flares gently rather than running away', () => {
    // Ten times further out is under twice as coarse, and a thousand times out
    // under six. Across the whole canvas the cloth opens by a few times, not by
    // orders of magnitude.
    expect(rowHeight(ROOT_DISC_RADIUS * 10) / rowHeight(ROOT_DISC_RADIUS)).toBeLessThan(2)
    expect(rowHeight(ROOT_DISC_RADIUS * 1000) / rowHeight(ROOT_DISC_RADIUS)).toBeLessThan(6)
  })

  it('is calibrated off the root node, the one landmark the canvas has', () => {
    // A row boundary lands exactly on the rim of the root disc, so the ornament
    // reads as hung off that circle rather than as a pattern the node happens to
    // sit in front of. The same choice, for the same reason, as the concentric
    // background's first cliff.
    expect(rowCoord(ROOT_DISC_RADIUS)).toBeCloseTo(ROWS_AT_DISC, 9)
    expect(Number.isInteger(ROWS_AT_DISC)).toBe(true)
  })

  it('keeps a row a workable size at the radii the tree lives at', () => {
    // Rows are the pitch of everything, so this is the whole family's scale. Too
    // fine and the ornament dissolves into noise the moment the canvas is zoomed
    // out; too coarse and a screen holds two of them.
    expect(rowHeight(ROOT_DISC_RADIUS)).toBeGreaterThan(150)
    expect(rowHeight(ROOT_DISC_RADIUS)).toBeLessThan(350)
    expect(rowHeight(ROOT_DISC_RADIUS * 100)).toBeLessThan(900)
  })

  it('hides the crowded inner knot under the root node', () => {
    // The constraint that decides how large the ornament may be drawn, and the
    // reason ROWS_AT_DISC cannot simply keep going down.
    //
    // The level is clamped at zero, so below v = GROUP the cells go on narrowing
    // without ever subdividing — a spiky crowded knot around the origin. That is
    // fine where the root node covers it and ugly anywhere else, since the
    // origin is the one place the eye uses to navigate.
    expect(GROUP).toBeLessThanOrEqual(ROWS_AT_DISC)
    // Stated as the radius it actually reaches, which is what has to be inside
    // the disc.
    const knotEdge = ROOT_DISC_RADIUS * (GROUP / ROWS_AT_DISC) ** (1 / FOLLOW)
    expect(knotEdge).toBeLessThanOrEqual(ROOT_DISC_RADIUS)
    // ...and it really is the clamp that ends there, not a coincidence.
    expect(level(knotEdge * 1.01)).toBe(0)
    expect(level(knotEdge * 0.99)).toBe(0)
    expect(level(knotEdge * 4)).toBeGreaterThan(0)
  })
})

describe('the cell count', () => {
  it('closes the ring on itself, or one ragged seam runs out to infinity', () => {
    // The angular coordinate advances by exactly `cells` where theta wraps at
    // ±PI. Unless that is a whole number the ornament fails to meet itself along
    // the -x axis, at every radius, forever.
    for (const r of RADII) {
      expect(Number.isInteger(cells(r)), `r = ${r}`).toBe(true)
    }
  })

  it('doubles exactly on a row boundary, which is what hides the seam', () => {
    // The claim the whole design rests on: a change of angular pitch has to land
    // *somewhere*, and this family puts it on a line that was going to be drawn
    // anyway rather than part-way up a band. It works because v doubles at whole
    // values of v whenever GROUP is a whole number.
    expect(Number.isInteger(GROUP)).toBe(true)
    // From k = 1: the level is clamped at 0 below v = GROUP, so the first
    // doubling is the floor of the ladder rather than a step in it. That clamp
    // is deliberate — a ring may never be divided into fewer than SECTORS cells
    // or the seam stops closing — and everything it affects is inside the root
    // disc, which is what the test below pins.
    for (let k = 1; k < 16; k++) {
      const v = GROUP * 2 ** k
      // The radius at which the row coordinate reaches v.
      const r = ROOT_DISC_RADIUS * (v / ROWS_AT_DISC) ** (1 / FOLLOW)
      expect(rowCoord(r), `level ${k}`).toBeCloseTo(v, 6)
      // Stepping either side of it moves the level and the row together. The
      // step is a hundredth of a row rather than a fixed fraction of the radius:
      // rows crowd in log space as they go out, so a relative step that is small
      // at the disc spans several rows by the time v is in the thousands.
      const probe = rowHeight(r) * 0.01
      expect(level(r + probe) - level(r - probe), `level ${k}`).toBe(1)
      expect(Math.floor(rowCoord(r + probe)) - Math.floor(rowCoord(r - probe)), `row ${k}`).toBe(1)
    }
  })

  it('puts every doubling past the root disc on a border row', () => {
    // Better than merely landing on a boundary: it lands on the row that is
    // *drawn* as a border. A rug changes its pattern at a border, so a change of
    // pattern at a border is what the eye already expects to find there.
    //
    // The first doubling, at v = GROUP, is the exception — it is beneath the
    // root node, where nothing is visible anyway.
    for (let k = 1; k < 16; k++) {
      expect((GROUP * 2 ** k) % TIER, `doubling ${k}`).toBe(0)
    }
  })

  it('keeps a cell between three quarters and one and a half times as wide as tall', () => {
    // Cells would otherwise stretch without limit: their width grows like r and
    // their height only like r ** GROWTH. Doubling the count every time v
    // doubles bounds the drift at exactly a factor of two, and SECTORS is chosen
    // to centre that range on square.
    let lo = Infinity
    let hi = 0
    for (let r = ROOT_DISC_RADIUS; r < 1e7; r *= 1.02) {
      lo = Math.min(lo, aspect(r))
      hi = Math.max(hi, aspect(r))
    }
    expect(lo).toBeGreaterThan(0.7)
    expect(hi).toBeLessThan(1.6)
    // ...and the drift really is a factor of two, not something that happens to
    // stay in range because the sweep was short.
    expect(hi / lo).toBeCloseTo(2, 1)
  })
})

describe('the pixel footprint', () => {
  it('is exact on both axes, so nothing has to guess at a derivative', () => {
    // fwidth quantises to 2x2 quads; both Jacobians here are known in closed
    // form. Compared against a numerical derivative of the coordinate the shader
    // actually uses.
    // Compared as a ratio rather than a difference: a finite difference taken
    // at r = 1e6 has only so many digits left, and an absolute tolerance tight
    // enough to mean anything at r = 400 is below the noise floor there.
    for (const r of RADII) {
      const step = r * 1e-7
      const dv = rowCoord(r + step) - rowCoord(r)
      expect(footprintY(r, step) / dv, `r = ${r}`).toBeCloseTo(1, 6)
      // The angular one: a pixel subtends step / r radians.
      const da = (step / r) * (cells(r) / TAU)
      expect(footprintX(r, step) / da, `r = ${r}`).toBeCloseTo(1, 9)
    }
  })

  it('agrees with the aspect ratio, since they are the same statement twice', () => {
    for (const r of RADII) {
      expect(footprintX(r, 1) / footprintY(r, 1), `r = ${r}`).toBeCloseTo(1 / aspect(r), 9)
    }
  })
})

describe('going quiet', () => {
  // Ported from the fades in RUG_SETUP_GLSL.
  const smoothstep = (a: number, b: number, x: number): number => {
    const t = Math.min(Math.max((x - a) / (b - a), 0), 1)
    return t * t * (3 - 2 * t)
  }
  const quietCell = (fq: number): number => smoothstep(0.16, 0.05, fq)
  const quietBorder = (fpy: number): number => smoothstep(0.9, 0.35, fpy)

  it('retires cell ornament while it is still several pixels across', () => {
    // Before it goes sub-pixel, not after. A pattern averaged over a pixel
    // converges on its own mean, and this family's mean is a pale wash — so the
    // ornament has to be faded to the *ground* rather than left to average.
    expect(quietCell(1 / 30)).toBeGreaterThan(0.95) // 30px cells: fully drawn
    expect(quietCell(1 / 5)).toBe(0) // 5px cells: gone
  })

  it('keeps the borders long after the ornament between them has gone', () => {
    // What is left when the canvas is zoomed all the way out has to be plain
    // concentric rings on dark ground — the navigation cue itself, not a
    // degraded copy of it. Borders are TIER rows apart, so they outlive the
    // ornament by two octaves of zoom.
    const rowsPerPixel = 1 / 4 // rows 4px apart: cell ornament is long gone
    expect(quietCell(rowsPerPixel)).toBe(0)
    expect(quietBorder(rowsPerPixel)).toBeGreaterThan(0.9)
    // ...and they do eventually go, rather than aliasing into a moire.
    expect(quietBorder(1.2)).toBe(0)
  })
})

describe('every rug background', () => {
  const named = Object.entries(RUG_BG_FRAGS)
  const stripped = (src: string): string =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

  it('is what the port above assumes', () => {
    for (const [name, src] of named) {
      const code = stripped(src)
      expect(code, name).toContain('float v = ROWS_AT_DISC * exp2(FOLLOW * lr);')
      expect(code, name).toContain('float level = max(floor(FOLLOW * lr + LEVEL_BIAS), 0.0);')
      expect(code, name).toContain('float cells = SECTORS * exp2(level);')
      expect(code, name).toContain('float fpy = worldPerPx * FOLLOW * v / r;')
      expect(code, name).toContain('float fpx = worldPerPx * cells / (TAU * r);')
      expect(code, name).toContain(`const float FOLLOW   = ${FOLLOW.toFixed(4)};`)
      expect(code, name).toContain(`const float LEVEL_BIAS = ${LEVEL_BIAS.toFixed(6)};`)
      expect(code, name).toContain(`const float ROWS_AT_DISC = ${ROWS_AT_DISC}.0;`)
      expect(code, name).toContain(`const float SECTORS  = ${SECTORS}.0;`)
      expect(code, name).toContain(`const float TIER     = ${TIER}.0;`)
    }
  })

  it('is a painting: zoom reaches the footprint and nothing else', () => {
    // The correction that produced Medallion, kept. If the row a pixel is in, or
    // the number of cells around it, could be read off the camera, then zooming
    // in would gain you a subdivision instead of a bigger pattern — a Droste
    // effect. worldPerPx may reach the world position and the two footprints,
    // and those only decide how hard the same painting is blurred.
    for (const [name, src] of named) {
      const uses = stripped(src).match(/^.*worldPerPx.*$/gm) ?? []
      expect(uses.length, name).toBeGreaterThan(0)
      for (const use of uses) {
        expect(use.trim(), `${name}: ${use.trim()}`).toMatch(
          /^float worldPerPx = 1\.0 \/ \(uZoom \* uDpr\);$|^vec2 world = |^float fp[xy] = /,
        )
      }
      // ...and the camera is not smuggled in by another name.
      for (const line of stripped(src).split('\n')) {
        if (/\bfloat (v|row|level|cells) =/.test(line)) {
          expect(line, `${name}: ${line.trim()}`).not.toMatch(/uZoom|uDpr|worldPerPx|fp[xyq]/)
        }
      }
    }
  })

  it('antialiases analytically, and never with a derivative', () => {
    // |grad r| = 1 and |grad theta| = 1/r, so both footprints are exact. fwidth
    // would quantise them to 2x2 quads and would need an extension enabled.
    for (const [name, src] of named) {
      expect(stripped(src), name).not.toMatch(/fwidth\s*\(/)
      expect(stripped(src), name).not.toMatch(/#extension/)
    }
  })

  it('stays cheaper than the theme it is modelled on', () => {
    // One sqrt via length(), one atan, one log2, two exp2 and the pow inside
    // linearToSrgb — the six Medallion spends — and then no loop at all where
    // Medallion runs four passes of weave arithmetic. No noise, no texture, no
    // branch, so there is no worst case.
    for (const [name, src] of named) {
      const code = stripped(src)
      const count = (re: RegExp): number => (code.match(re) ?? []).length
      expect(count(/\batan\s*\(/g), name).toBe(1)
      expect(count(/\blog2\s*\(/g), name).toBe(1)
      expect(count(/\bexp2\s*\(/g), name).toBe(2)
      expect(count(/\bpow\s*\(/g), name).toBe(1)
      expect(count(/\blength\s*\(/g), name).toBe(1)
      expect(count(/\blog\s*\(/g), name).toBe(0)
      for (const banned of [/\bfor\s*\(/, /\bif\s*\(/, /\bsin\s*\(/, /\bcos\s*\(/, /texture2D/]) {
        expect(code, `${name} ${String(banned)}`).not.toMatch(banned)
      }
    }
  })

  it('composites in linear light and encodes once at the end', () => {
    // Coverage is a statement about energy — see ./srgb. Mixing encoded values
    // instead loses about a third of a line's output where it straddles two
    // pixels, and these designs are almost entirely lines.
    for (const [name, src] of named) {
      expect(src, name).toContain('linearToSrgb(col)')
      expect(stripped(src).match(/linearToSrgb/g)?.length, name).toBe(2) // the definition and the one use
    }
  })

  it('keeps its palette dark enough to be furniture', () => {
    // A background may be interesting to look at and may not ask to be looked
    // at. The grounds — which is most of the canvas — stay near black; only the
    // ink, which is spent on lines a twentieth of a cell wide, is allowed to be
    // bright.
    for (const [name, src] of named) {
      const grounds = [...src.matchAll(/const vec3 GROUND(?:_ALT)? += (vec3\(([^)]*)\));/g)]
      expect(grounds.length, name).toBe(2)
      for (const [, , triple] of grounds) {
        for (const channel of triple.split(',').map(Number)) {
          // Linear light, so these are small numbers: 0.01 linear is about 0.1
          // in sRGB and the ceiling here is about 0.15 — a shade under the top
          // of Medallion's whole palette, which is the darkest thing this repo
          // ships and a fair definition of "furniture".
          expect(channel, `${name} ground`).toBeGreaterThan(0.002)
          expect(channel, `${name} ground`).toBeLessThan(0.02)
        }
      }
    }
  })
})
