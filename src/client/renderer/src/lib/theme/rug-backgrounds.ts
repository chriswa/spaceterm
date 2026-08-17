/**
 * The Rug family: concentric ornament on a growing polar lattice.
 *
 * Three `background` facets that share one skeleton and differ only in the
 * motif drawn in a cell. See `./shaders` for the uniform contract they satisfy;
 * `./facets` names them and `./themes` assembles them into themes.
 *
 * ## What this keeps from Medallion, and what it throws away
 *
 * Medallion's two good ideas are kept. The pattern is a **painting in world
 * space** — zoom reaches exactly one quantity, the pixel footprint, which
 * decides how hard to blur and never what to draw. And feature size **grows
 * with distance from the origin**, so how coarse the ornament is against a card
 * of known size says roughly how far out you are.
 *
 * What is thrown away is how Medallion got a pattern that survives being zoomed:
 * four octaves of the same weave, summed as shading through a sliding window.
 * Summing is what made it look sloppy. Four scales of the same motif at
 * comparable strength is the recipe for noise — no octave is ever the figure,
 * every edge is crossed by a fainter edge at half the size, and nothing in it
 * has a silhouette. It reads as texture, not as ornament.
 *
 * This family draws **one** crisp pattern instead, and buys its scale range
 * structurally rather than by superposition:
 *
 * - **Rows** — concentric bands whose spacing grows exactly as `r ** GROWTH`.
 *   Continuous in radius, so nothing fades in or out and nothing breathes.
 * - **A row's kind** — border, guard or field, on a period of `TIER` rows. One
 *   band in every four is a border, so there is coarse structure to read when
 *   the cell-scale ornament has gone sub-pixel and blurred away.
 * - **Cells** — a whole number of them around each row, doubling at rows where
 *   they would otherwise have stretched too wide.
 *
 * ## Why the row coordinate is `r ** (1 - GROWTH)`
 *
 * Rows should be spaced `dr ∝ r ** GROWTH` apart, so the ornament opens up
 * outward. The coordinate whose *integers* land on those radii is the integral
 * of `dr / r ** GROWTH`, which is `r ** (1 - GROWTH)` up to a constant. So
 * `v = ROWS_AT_DISC * (r / ROOT_DISC_RADIUS) ** FOLLOW` is the row coordinate,
 * and a row boundary is a whole value of `v`.
 *
 * That is one `exp2` and no window, which is the whole reason the rings here are
 * hard-edged where Medallion's were a moving average of four soft ones.
 *
 * ## Why the cell count doubles, and why that seam is not a scar
 *
 * A row `n` carries `N = SECTORS * 2 ** level` cells. Held fixed, cells would
 * stretch: their width is `TAU * r / N` and grows like `r`, while their height
 * only grows like `r ** GROWTH`. So `N` doubles every time `v` does, which keeps
 * a cell between about 0.79 and 1.57 times as wide as it is tall — a range that
 * reads as a lozenge throughout rather than as a shape that is drifting.
 *
 * A doubling has to land *somewhere*, and wherever it lands the ornament above
 * it is half the width of the ornament below. Two things make that a feature
 * instead of a defect. It lands exactly on a row boundary — `v` doubles at
 * whole values of `v` whenever `GROUP` is a whole number, so the change of pitch
 * happens at a line that was going to be drawn anyway. And the row it lands on
 * is drawn as a **border**: a rug changes its pattern at a border, so a change
 * of pattern at a border is what the eye already expects there.
 *
 * This is the seam that log-polar was chosen to avoid in Medallion, taken on
 * deliberately. Medallion paid for avoiding it with the octave sum; the price
 * here is one visible ring every factor of 2.52 in radius, dressed as a border.
 *
 * ## Cost
 *
 * One `sqrt`, one `atan`, one `log2`, two `exp2` and the `pow` inside
 * `linearToSrgb` — the same six transcendentals Medallion spends, and then *no
 * loop at all* where Medallion runs four passes of weave arithmetic. These are
 * cheaper than the theme they are modelled on, not dearer.
 *
 * ## Thin lines, and why they are widened instead of sharpened
 *
 * Every line here is drawn through `lineCoverage`, which never lets a line get
 * thinner than a pixel: below that it holds the width and drops the opacity in
 * proportion. A half-pixel line rendered honestly is a dotted, crawling mess as
 * it drifts against the pixel grid, because point-sampling a line narrower than
 * the sample spacing is aliasing by definition. Widening and fading conserves
 * the line's total light instead, so a ring that is too fine to draw becomes a
 * faint even ring rather than a row of sparks. It is what lets the same pattern
 * be zoomed from one row filling the screen out to fifty rows in a screen
 * without ever shimmering.
 */

import { ROOT_DISC_RADIUS } from '../../../../../shared/node-size'
import { glslVec3, LINEAR_TO_SRGB_GLSL, rgbToLinear, type Rgb } from './srgb'

/* ------------------------------------------------------------------ */
/*  The lattice                                                        */
/* ------------------------------------------------------------------ */

/**
 * How fast the ornament opens up with distance from the origin: row spacing,
 * and with it cell size, goes as `r ** GROWTH`.
 *
 * Medallion's value, kept because it is the part of Medallion that worked. Ten
 * times further out is about 1.8 times coarser and sixty times out about 2.8 —
 * a fabric opening toward its edge rather than a different fabric.
 */
const GROWTH = 0.25

/** How much of `log2(r)` the lattice follows. The row coordinate is `r ** FOLLOW`. */
const FOLLOW = 1 - GROWTH

/**
 * Rows between the origin and the root node's rim.
 *
 * This is the whole family's scale control: it fixes how many bands there are
 * anywhere, since every other radius is measured in the same coordinate. Lower
 * is bigger — a row is `ROOT_DISC_RADIUS / (FOLLOW * ROWS_AT_DISC)` thick at the
 * rim, so halving this doubles every feature on the canvas.
 *
 * Two puts a row boundary exactly on the rim of the root disc — the one landmark
 * the canvas has — and makes a row about 210 world units thick there, growing to
 * roughly 300 out where the tree actually lives.
 *
 * ## Why not lower still
 *
 * It was five, which drew a rug that read beautifully with a card in shot and
 * dissolved into muddy half-resolved noise when the canvas was zoomed out to
 * find something. Everything about that failure says *make it bigger*, and the
 * only question is how far it can go.
 *
 * The floor is `GROUP`, and it is a hard one. The doubling level is clamped at
 * zero — a ring may never be cut into fewer than `SECTORS` cells, or the pattern
 * stops meeting itself at the angular seam — and that clamp bites below
 * `v = GROUP`, which is the radius
 * `ROOT_DISC_RADIUS * (GROUP / ROWS_AT_DISC) ** (1 / FOLLOW)`. Inside it cells
 * go on narrowing without ever subdividing, which shows up as a crowded spiky
 * knot around the origin. At `ROWS_AT_DISC = GROUP` that region ends exactly at
 * the rim of the root disc, so the node covers all of it; any lower and the knot
 * pokes out past the node and onto the canvas, which is precisely what a
 * background may not do at the one place the eye uses to navigate.
 *
 * So two is not a compromise between the two zoom ends — it is the largest this
 * family goes before it breaks. Bigger than this needs `GROUP` lowered with it,
 * and `GROUP` sets the cell aspect ratio, so that is a redesign rather than a
 * knob.
 */
const ROWS_AT_DISC = 2

/**
 * Cells around the innermost ring, and the unit the pattern's seam is aligned
 * to.
 *
 * Twelve, so that a full turn is a whole number of cells at every level: the
 * angular coordinate jumps by `SECTORS * 2 ** level` where `theta` wraps, and
 * unless that is an integer the ornament fails to meet itself along one ray out
 * to infinity.
 */
const SECTORS = 12

/**
 * The row coordinate at which the cell count first doubles. Doublings then fall
 * at `GROUP`, `2 * GROUP`, `4 * GROUP` and so on.
 *
 * A whole number, so that every doubling lands on a row boundary rather than
 * part-way up a band. Two, with `SECTORS = 12`, puts the aspect ratio of a cell
 * between 0.79 and 1.57 — centred close enough to square that the lozenges read
 * as one shape throughout, and leaning wide, which is how a rug's lozenges lean.
 *
 * It is also the floor on `ROWS_AT_DISC`, and so on how large the ornament can
 * be drawn. See there.
 */
const GROUP = 2

/**
 * Rows in one tier of the row rhythm: border, then `TIER - 1` field rows.
 *
 * The reason there is any coarse structure at all. Cell-scale ornament goes
 * sub-pixel when the canvas is zoomed out far, and a background that dissolves
 * into a flat wash exactly when you most need to know where you are is the one
 * failure this family cannot have. Borders every fourth row are four times the
 * pitch of the ornament inside them, so they are still legible about two octaves
 * of zoom after the ornament has blurred away — and when they finally blur too,
 * they blur into plain concentric rings, which is the cue itself.
 */
const TIER = 4

/**
 * The lattice, as GLSL. Defines everything a motif needs and nothing about what
 * is drawn in it.
 *
 * Leaves in scope: `v` (row coordinate), `row`, `fy` (position up the row),
 * `cell`, `fx` (position across the cell, centred), `fpx`/`fpy` (the pixel
 * footprint on each axis, in cell units), `tier` and `border`.
 */
const RUG_LATTICE_GLSL = `
const float TAU = 6.28318530718;

const float FOLLOW   = ${FOLLOW.toFixed(4)};
const float SECTORS  = ${SECTORS}.0;
const float TIER     = ${TIER}.0;
const float ROWS_AT_DISC = ${ROWS_AT_DISC}.0;

/** log2 of the radius at which the row coordinate is 1. */
const float INV_DISC = ${(1 / ROOT_DISC_RADIUS).toFixed(9)};

/**
 * Level offset: \`floor(FOLLOW * log2(r / disc) + LEVEL_BIAS)\` is the doubling
 * level, which is \`floor(log2(v / GROUP))\` written without a second log.
 */
const float LEVEL_BIAS = ${Math.log2(ROWS_AT_DISC / GROUP).toFixed(6)};

/**
 * Coverage of a line of half-width \`halfWidth\` at signed offset \`x\`, with pixel
 * footprint \`fp\` — all in the same units.
 *
 * Never thinner than a pixel: below that the width is held and the opacity
 * drops in proportion, which conserves the line's light instead of sampling it
 * away. See the note at the top of this file.
 */
float lineCoverage(float x, float halfWidth, float fp) {
  float aa = 0.5 * fp + 1e-6;
  float w = max(halfWidth, aa);
  return (1.0 - smoothstep(w - aa, w + aa, abs(x))) * min(halfWidth / w, 1.0);
}

/** Coverage of the region \`d < edge\`, antialiased over one footprint. */
float fillCoverage(float d, float edge, float fp) {
  float aa = 0.5 * fp + 1e-6;
  return 1.0 - smoothstep(edge - aa, edge + aa, d);
}

/**
 * Quasi-distance to a four-pointed star inscribed in the unit cell.
 *
 * \`c\` is the position in the cell, centred and spanning ±0.5. The value is 1
 * at the middle of each cell edge — the star's points — and \`pinch\` pulls the
 * four edges between them inward: 0 is a plain lozenge, 1 a sharp star whose
 * waist is a third of the way out. The straight-line edges are what makes this
 * read as cut cloth rather than as a blob, and they antialias exactly, since
 * the gradient is piecewise constant.
 */
float starField(vec2 c, float pinch) {
  vec2 q = abs(c) * 2.0;
  return q.x + q.y + pinch * min(q.x, q.y);
}
`

/**
 * The block of `main()` every rug background starts with: world position, the
 * row and cell it falls in, and the pixel footprint on each axis.
 *
 * Shared as text rather than as a function because WebGL 1 has no output
 * parameters worth the trouble and no struct returns without a copy — and this
 * is the hot path of a full-screen quad.
 */
const RUG_SETUP_GLSL = `
  float worldPerPx = 1.0 / (uZoom * uDpr);
  vec2 world = (gl_FragCoord.xy - uOrigin) * worldPerPx;

  float raw = length(world);
  float r = max(raw, 1e-4);
  // atan(0, 0) is undefined; the one pixel on the origin is nudged onto the +x
  // axis. It sits under the root node, but a NaN there survives every mix below
  // and shows up as a lit speck.
  float theta = atan(world.y, world.x + step(raw, 1e-5));
  float lr = log2(r * INV_DISC);

  // Rows: whole values of v, spaced dr ~ r^GROWTH apart.
  float v = ROWS_AT_DISC * exp2(FOLLOW * lr);
  float row = floor(v);
  float fy = v - row;

  // Cells: a whole number of them around the ring, doubling where v does.
  float level = max(floor(FOLLOW * lr + LEVEL_BIAS), 0.0);
  float cells = SECTORS * exp2(level);

  // Alternate rows are offset half a cell, so the ornament runs in a brick bond
  // rather than in radial columns — columns would add a second family of lines
  // that nothing in the design asked for.
  float a = theta * (cells / TAU) + 0.5 * mod(row, 2.0);
  float cell = floor(a);
  float fx = fract(a) - 0.5;

  // Footprints. dv/dr = FOLLOW * v / r and da/dtheta = cells / TAU, so both are
  // exact — no derivative extension, and no quantising to 2x2 quads.
  float fpy = worldPerPx * FOLLOW * v / r;
  float fpx = worldPerPx * cells / (TAU * r);
  float fq = max(fpx, fpy);

  // Where in the tier's rhythm this row falls, and whether it is a border.
  float tier = mod(row, TIER);
  float border = 1.0 - min(tier, 1.0);

  // How much of each scale of ornament survives the pixel footprint.
  //
  // Conserving a shrinking line's light is the right answer for *one* line and
  // the wrong one for a field of them. Averaged over a pixel, a pattern converges
  // on its own mean — and the mean of ivory ornament on a dark ground is a pale
  // wash, at exactly the same luminance whether it is one cell filling the screen
  // or ten thousand. Locally that mean reads as "dark, with bright ornament";
  // once a cell is a few pixels across it reads as a beige sheet. A background
  // that turns into a bright flat sheet the moment it is zoomed out is the one
  // failure this family may not have.
  //
  // So each scale is deliberately retired *before* it stops being resolvable,
  // fading to the ground rather than to its own average, coarsest last: cell
  // ornament goes at about six pixels a cell, the row lines at three pixels a
  // row, and the borders last of all. What is left when the canvas is zoomed all
  // the way out is dark ground with plain concentric rings on it — which is the
  // navigation cue itself, not a degraded copy of it.
  //
  // This is filtering and not composition, in the sense Medallion's notes use:
  // it changes how much of the painting is shown, never what the painting is.
  float quietCell = smoothstep(0.16, 0.05, fq);
  float quietRow = smoothstep(0.30, 0.10, fpy);
  float quietBorder = smoothstep(0.90, 0.35, fpy);
`

/* ------------------------------------------------------------------ */
/*  Palettes                                                           */
/* ------------------------------------------------------------------ */

/**
 * A rug palette: a ground, the ink its lines are drawn in, and three dyes.
 *
 * Given as sRGB and decoded once at build time, because compositing coverage is
 * a statement about energy — see `./srgb`. Everything below is mixed in linear
 * light and encoded once at the end.
 *
 * The constraint every one of these is tuned against is that it is furniture:
 * the ground stays near 0.1 in sRGB, and the bright end is spent on *thin*
 * things — a line an eighth of a cell wide can be twice the luminance of
 * anything Medallion allowed itself and still leave the canvas darker overall,
 * because almost none of the canvas is that line.
 */
interface RugPalette {
  /** The field, and the darker of the two alternating tier grounds. */
  ground: Rgb
  /** The field on alternate doubling groups — a few percent apart, no more. */
  groundAlt: Rgb
  /** Lines: borders, outlines, hairlines. The brightest thing on the canvas. */
  ink: Rgb
  /** The three dyes, in order of how much canvas they are allowed to cover. */
  dyeA: Rgb
  dyeB: Rgb
  dyeC: Rgb
}

const paletteGlsl = (p: RugPalette): string => `
const vec3 GROUND    = ${glslVec3(rgbToLinear(p.ground))};
const vec3 GROUND_ALT = ${glslVec3(rgbToLinear(p.groundAlt))};
const vec3 INK       = ${glslVec3(rgbToLinear(p.ink))};
const vec3 DYE_A     = ${glslVec3(rgbToLinear(p.dyeA))};
const vec3 DYE_B     = ${glslVec3(rgbToLinear(p.dyeB))};
const vec3 DYE_C     = ${glslVec3(rgbToLinear(p.dyeC))};
`

/** Uniforms and preamble every background in the family declares. */
const rugPreamble = (palette: RugPalette): string => `
precision highp float;
uniform vec2 uOrigin;
uniform float uZoom;
uniform float uDpr;

${paletteGlsl(palette)}
${RUG_LATTICE_GLSL}
${LINEAR_TO_SRGB_GLSL}
`

/* ------------------------------------------------------------------ */
/*  Kilim — stepped lozenges in banded rows                            */
/* ------------------------------------------------------------------ */

/**
 * Madder, indigo and ivory on a charcoal that leans blue.
 *
 * The three dyes are the ones a flat-woven rug is actually made of, at about
 * half the saturation they have in wool — enough that a lozenge reads as *red*
 * or as *blue* at a glance, not enough that the canvas competes with a card.
 */
const KILIM_PALETTE: RugPalette = {
  ground: [0.086, 0.082, 0.110],
  groundAlt: [0.104, 0.098, 0.129],
  ink: [0.706, 0.643, 0.510],
  dyeA: [0.478, 0.216, 0.157],
  dyeB: [0.180, 0.294, 0.478],
  dyeC: [0.612, 0.435, 0.180],
}

/**
 * A field of stepped lozenges on a four-row rhythm.
 *
 * The motif is one shape at three sizes: a four-pointed star, outlined in ivory
 * on the major rows, dropped in small and solid on the minor row between them,
 * and studded along the border. Rugs are built this way — one motif, restated at
 * whatever scale the band it is in allows — and it is also what keeps the shader
 * to a single distance field with three thresholds on it.
 *
 * ## Why the rows have a rhythm rather than all being the field
 *
 * The first cut gave every non-border row the same outlined star, which turned
 * out to be the same mistake Medallion made in a different currency: an even
 * field of identical ornament at one scale has nothing for the eye to group, so
 * it reads as busy rather than as designed. A rug never does that. It alternates
 * a *charged* band with a *quiet* one, and the alternation is what makes the
 * charged band read as the figure.
 *
 * So the four rows of a tier are border, major, minor, major. Two thirds of the
 * canvas is now either quiet or ground, and the outlined stars have somewhere to
 * sit.
 *
 * The dyes alternate on a checkerboard of cell and row, which is the oldest
 * trick in flat-weave and does more here than a fourth shape would: it puts a
 * diagonal rhythm across the concentric one without drawing a single extra line.
 */
export const KILIM_BG_FRAG = `
${rugPreamble(KILIM_PALETTE)}

/** How far the star's edges are pulled in between its points. */
const float PINCH = 0.55;
/** Where a major row's outline sits, and how heavy it is drawn. */
const float RING = 0.74;
const float RING_W = 0.05;
/** The dyed heart inside that outline. */
const float CORE = 0.30;
/** The solid lozenge that is all a minor row carries. */
const float MINOR_STAR = 0.40;
/** The stud repeated along a border row. */
const float BORDER_STAR = 0.46;
/** Hairline on every row boundary; the border rows get the heavier one. */
const float HAIR_W = 0.016;
const float BORDER_W = 0.05;

void main() {
${RUG_SETUP_GLSL}

  // The tier's rhythm: border, major, minor, major.
  float minor = 1.0 - min(abs(tier - 2.0), 1.0);
  float major = (1.0 - border) * (1.0 - minor);

  // The star's gradient is at most 1 + PINCH per unit of cell, doubled by the
  // ±0.5 cell spanning 1.0 in the field's units.
  float aaStar = fq * 2.0 * (1.0 + PINCH);

  float d = starField(vec2(fx, fy - 0.5), PINCH);

  // Ground: the two tiers of it are a few percent apart, so a doubling group
  // reads as a change of tone across a border rather than as a stripe.
  vec3 col = mix(GROUND, GROUND_ALT, mod(level, 2.0));

  // The dye for this cell: a checkerboard of the two field dyes, with the
  // borders always carrying the third.
  vec3 dye = mix(DYE_A, DYE_B, mod(cell + row, 2.0));

  float ring = lineCoverage(d - RING, RING_W, aaStar) * major;
  float heart = fillCoverage(d, CORE, aaStar) * major;
  float bead = fillCoverage(d, MINOR_STAR, aaStar) * minor;
  float stud = fillCoverage(d, BORDER_STAR, aaStar) * border;

  // Row boundaries. Drawn from the row coordinate rather than the cell, so they
  // are true circles and stay circles when everything above has blurred out.
  float edge = min(fy, 1.0 - fy);
  float hair = lineCoverage(edge, HAIR_W, fpy) * (1.0 - border) * quietRow;
  float rim = lineCoverage(edge, BORDER_W, fpy) * border * quietBorder;

  col = mix(col, dye, heart * 0.92 * quietCell);
  col = mix(col, dye, bead * 0.80 * quietCell);
  col = mix(col, mix(DYE_C, dye, 0.35), stud * 0.92 * quietCell);
  col = mix(col, INK, ring * 0.78 * quietCell);
  col = mix(col, INK, hair * 0.55);
  col = mix(col, INK, rim * 0.7);

  gl_FragColor = vec4(linearToSrgb(col), 1.0);
}
`

/* ------------------------------------------------------------------ */
/*  Serration — jagged rings, interlocked                              */
/* ------------------------------------------------------------------ */

/**
 * Verdigris and copper on near-black slate.
 *
 * Cooler and barer than Kilim's: this design is nearly all line, so the palette
 * is two metals and a ground rather than a set of dyes to fill areas with.
 */
const SERRATION_PALETTE: RugPalette = {
  ground: [0.071, 0.082, 0.086],
  groundAlt: [0.086, 0.098, 0.098],
  ink: [0.588, 0.663, 0.635],
  dyeA: [0.286, 0.502, 0.463],
  dyeB: [0.643, 0.404, 0.239],
  dyeC: [0.412, 0.451, 0.529],
}

/**
 * Concentric rings that zigzag instead of closing, crossed into a chain.
 *
 * The literal answer to "jagged lines rather than circles": a ring is a triangle
 * wave in the radial coordinate, so following one takes you around the origin
 * while it climbs and falls a third of a band.
 *
 * ## Why each ring is two lines and not one
 *
 * One line per ring was the first cut, and from close range it was a screen of
 * parallel wavy stripes — a fabric swatch, not a rug. The fix is the oldest
 * border in weaving: strike the ring *twice*, mirrored, so the pair crosses
 * itself four times a cell and encloses a chain of lozenges between the
 * crossings.
 *
 * That single change buys three things at once. The ring is now a braid, and a
 * braid is a thing the eye follows around a corner. The chain gives every cell
 * an interior to put a knot in, so there is something to read when a ring is far
 * too big to see as a ring. And the crossings are *hard corners* at fixed points
 * of the cell, which is what makes the whole thing read as struck rather than as
 * drifting — the failure a lone sine-ish line always has.
 *
 * The lozenges' outline is exactly the two lines, so the interior costs one
 * comparison and no extra geometry: a point is inside the chain when it is
 * between the two zigzags, which is `|fy - 0.5| < AMP * |tri - 0.5|`.
 */
export const SERRATION_BG_FRAG = `
${rugPreamble(SERRATION_PALETTE)}

/** How far a ring climbs and falls across one cell, in rows. */
const float AMP = 0.40;
/** The braid's stroke, and the hairline struck along its middle. */
const float STROKE = 0.070;
const float INNER = 0.022;
/** The ivory pip in the eye of each link of the chain. */
const float PIP = 0.10;

void main() {
${RUG_SETUP_GLSL}

  // A triangle wave across the cell: 0 at the centre, 1 at either edge.
  float tri = abs(fx) * 2.0;

  // The two mirrored rings. Their gradient is steeper than 1 by the lean, so the
  // footprint is scaled to match — otherwise the diagonals blur soft while the
  // peaks stay hard, which is the tell of an unconsidered zigzag.
  float lean = sqrt(1.0 + 4.0 * AMP * AMP);
  float wob = AMP * (tri - 0.5);
  float up = fy - 0.5 - wob;
  float down = fy - 0.5 + wob;
  float aaZ = fq * lean;

  // Union of the two strokes: whichever is nearer owns the pixel.
  float near = min(abs(up), abs(down));
  float heavy = lineCoverage(near, STROKE, aaZ);
  float light = lineCoverage(near, INNER, aaZ);

  // Inside a link of the chain: between the two lines, which is where their
  // signs disagree.
  float link = fillCoverage(abs(fy - 0.5) - abs(wob), 0.0, aaZ);
  // ...and the knot at its centre, where the link is at its widest.
  float pip = fillCoverage(max(abs(fy - 0.5), abs(tri - 0.5) * 1.6) - PIP, 0.0, aaZ);

  // Borders are the same ring drawn straight — the one row in four that closes,
  // so the pattern has something truly circular in it to measure by.
  float straight = lineCoverage(fy - 0.5, STROKE * 1.4, fpy);

  vec3 col = mix(GROUND, GROUND_ALT, mod(level, 2.0));
  vec3 metal = mix(DYE_A, DYE_B, mod(row, 2.0));

  float field = (1.0 - border) * quietCell;
  col = mix(col, DYE_C, link * 0.45 * field);
  col = mix(col, metal, heavy * 0.9 * field);
  col = mix(col, INK, light * 0.75 * field);
  col = mix(col, INK, pip * 0.6 * field);
  col = mix(col, INK, straight * border * 0.8 * quietBorder);

  gl_FragColor = vec4(linearToSrgb(col), 1.0);
}
`

/* ------------------------------------------------------------------ */
/*  Sunburst — rings of interleaved spikes                             */
/* ------------------------------------------------------------------ */

/**
 * Ochre and plum on a warm near-black.
 *
 * The warmest of the three, and the most restrained: this design fills whole
 * areas with dye where the other two only draw lines, so the dyes themselves are
 * taken down to little more than a tinted shadow. The first cut used them at the
 * strength Kilim uses for a lozenge an eighth this size, and a canvas of solid
 * plum and ochre wedges is a carpet showroom, not a backdrop.
 */
const SUNBURST_PALETTE: RugPalette = {
  ground: [0.078, 0.067, 0.075],
  groundAlt: [0.094, 0.080, 0.090],
  ink: [0.702, 0.639, 0.522],
  dyeA: [0.314, 0.216, 0.098],
  dyeB: [0.239, 0.137, 0.192],
  dyeC: [0.153, 0.204, 0.204],
}

/**
 * Rings of triangular teeth, each row's rising from its inner edge and the next
 * row's hanging into it, meshed half a cell apart.
 *
 * Where Serration draws a jagged *line*, this cuts a shape: a row is a crown of
 * teeth in one dye, and the row above hangs its own crown down into the gaps —
 * the lattice offsets alternate rows by half a cell, so the two mesh rather than
 * collide, and the boundary between two rows becomes a continuous saw edge of
 * dye against dye rather than a line.
 *
 * ## Why only one crown is dyed
 *
 * Both were, at first, and the result was a canvas of solid colour wedges with
 * no ground left anywhere. Dyeing the rising crown and leaving the falling one
 * as ground halves the colour on the canvas and *keeps the whole silhouette*:
 * the saw edge still runs all the way round, now as dye against the dark, which
 * is both quieter and a stronger read.
 *
 * It is also the reading that survives furthest into being zoomed out. A
 * silhouette between two tones blurs to a two-tone band; a lattice of lines
 * blurs to grey.
 */
export const SUNBURST_BG_FRAG = `
${rugPreamble(SUNBURST_PALETTE)}

/** How far up the row a tooth reaches. Past 0.5 the two crowns interlock. */
const float TOOTH = 0.78;
/** The hairline along the saw edge, and the border's heavier ring. */
const float HAIR_W = 0.012;
const float BORDER_W = 0.045;
/** The stud dropped in the eye of each border tooth. */
const float STUD = 0.26;
const float PINCH = 0.4;

void main() {
${RUG_SETUP_GLSL}

  float tri = abs(fx) * 2.0;

  // The crown rising from this row's inner edge: inside where fy is below the
  // tooth's profile, which is a triangle peaking over the cell's centre.
  float rise = TOOTH * (1.0 - tri) - fy;
  // ...and the crown of the row above, hanging into this one — half a cell out
  // of phase, because the lattice bricks alternate rows.
  float fall = fy - (1.0 - TOOTH * tri);

  float lean = sqrt(1.0 + 4.0 * TOOTH * TOOTH);
  float aa = fq * lean;

  float up = fillCoverage(-rise, 0.0, aa);

  vec3 col = mix(GROUND, GROUND_ALT, mod(level, 2.0));

  // The dye cycles through all three by row. Three against the four-row tier
  // gives a twelve-row super-period, so a band of crowns is never quite the band
  // three rows below it — which is the difference between a woven thing and a
  // tiled one, and costs two steps and two mixes.
  float k = mod(row, 3.0);
  vec3 dye = mix(DYE_A, DYE_B, step(0.5, k));
  dye = mix(dye, DYE_C, step(1.5, k));

  col = mix(col, dye, up * quietCell);

  // Both saw edges picked out in ink, so the interlock is a drawn line and not
  // only a change of colour — this is what keeps the teeth legible once the dye
  // is this close to the ground.
  float seam = min(abs(rise), abs(fall));
  col = mix(col, INK, lineCoverage(seam, HAIR_W, aa) * 0.42 * quietCell);

  // A stud in the eye of each border tooth, and the border's own ring.
  float stud = fillCoverage(starField(vec2(fx, fy - 0.5), PINCH), STUD, fq * 2.0 * (1.0 + PINCH));
  col = mix(col, INK, stud * border * 0.7 * quietCell);
  col = mix(col, INK, lineCoverage(min(fy, 1.0 - fy), BORDER_W, fpy) * border * 0.65 * quietBorder);

  gl_FragColor = vec4(linearToSrgb(col), 1.0);
}
`

/** The family, for previewing and for `./facets` to name. */
export const RUG_BG_FRAGS = {
  kilim: KILIM_BG_FRAG,
  serration: SERRATION_BG_FRAG,
  sunburst: SUNBURST_BG_FRAG,
} as const

/**
 * The lattice's parameters, exported so the tests measure the shader's own
 * numbers rather than a second copy of them.
 *
 * The GLSL is still the source of truth for the *arithmetic* — `./rug-lattice.test`
 * ports that, as `medallion-lattice.test` does, and pins the ported form against
 * the generated source. What is shared here is only the handful of constants
 * both would otherwise spell out, where a silent disagreement would mean the
 * tests were describing a design nobody is running.
 */
export const RUG_LATTICE = { GROWTH, FOLLOW, ROWS_AT_DISC, SECTORS, GROUP, TIER } as const
