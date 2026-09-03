/**
 * Pavers: radial stone brickwork around the root node.
 *
 * The default `background` facet. See `./shaders` for the uniform contract it
 * satisfies; `./facets` names it and `./themes` assembles it into a theme.
 *
 * ## What it is
 *
 * The floor of a circular courtyard: concentric courses of stone, each course a
 * whole number of pavers around, laid in a running bond so no joint lines up
 * with the one in the course below. Grey stone, dark mortar, and every stone
 * lit across a chamfered edge from one fixed direction so the floor reads as
 * relief rather than as a diagram of one.
 *
 * ## The courses open up outward
 *
 * Course depth grows as `r ** GROWTH`, at the same rate Medallion's weave
 * coarsens — ten times further out is about 1.8 times deeper, sixty times out
 * about 2.8. So how large the stones are against a card of known size says
 * roughly how far from home you are, which is the one navigation cue a still
 * background can give that rings alone cannot.
 *
 * The coordinate whose *integers* land on those course boundaries is
 * `r ** (1 - GROWTH)` — the integral of `dr / r ** GROWTH` — so the course
 * coordinate is `v = RIM_COURSE * (r / ROOT_DISC_RADIUS) ** FOLLOW`, and a
 * course boundary is a whole value of `v`. One `log2` and one `exp2`, the same
 * as the rug lattice this is descended from.
 *
 * ## Every course takes as many stones as fit
 *
 * A course at coordinate `v` carries `round(TAU * FOLLOW * v / ASPECT)`
 * stones — whatever whole number puts a stone nearest `ASPECT` times as wide
 * as the course is deep. That is the *normalize* option of Blender's radial
 * tiling node, and it is what real radial paving does. No doubling ladder, no
 * seam where the pitch halves: a stone is never more than half a stone's width
 * from nominal, and past the first few courses the difference is a few
 * percent. The count falls out of `v` alone, since the arc a course subtends
 * and its depth both scale with `r` in the same proportion.
 *
 * ## The first few courses
 *
 * A stone in a course of six is a wedge, not a brick. That is unavoidable —
 * six stones around a circle *are* wedges — and it is also invisible, because
 * `RIM_COURSE` is a whole number, so a course boundary lands on the root disc's
 * rim and every course whose stones are badly out of shape lies under the root
 * node. The first course past the rim has nine stones, a little wedge-shaped
 * still; the next has twelve and looks like paving.
 *
 * ## Where the texture comes from
 *
 * No image. Each stone samples four octaves of value noise in *its own frame*
 * — cell-local coordinates offset by the stone's hash — so the grain is
 * different on every stone and breaks at every joint, which is the one thing
 * that most says "separate stones" rather than "a photo of stones with lines
 * drawn on it". The same field, coarser, mottles the mortar. And the whole
 * floor is pushed about by one octave of vector noise before it is laid out,
 * so no stone is quite square and no joint is quite a circle or a ray — see
 * `WARP`.
 *
 * The joint, the chamfer, the grain and the warp are all a fixed size in world
 * units, and only the stones grow. A mason's joint does not widen because the
 * stone is bigger, and grain is a property of the rock — so a stone far out is
 * a *larger stone*, not a closer view of the same one.
 *
 * ## Zoom
 *
 * A painting in world space, like every still background here: zoom reaches the
 * pixel footprint and nothing else. Each scale of detail is retired *before* it
 * goes sub-pixel, coarsest last: grain first, then the chamfer, then the
 * stones themselves, fading to the ground rather than to their own average.
 * Zoomed all the way out the canvas is dark ground with the soft rhythm of the
 * soldier courses on it, which is what a floor looks like from a long way up.
 *
 * ## Cost
 *
 * Two `sqrt`s, one `atan`, one `log2`, one `exp2`, the `pow` in `linearToSrgb`,
 * and twenty-two hashes (one per stone for its identity, one per course for
 * its stagger, four for the warp and sixteen for four octaves of grain). No
 * loop, no branch, no texture. Comfortably under the nebula, which runs seven
 * octaves of sixteen-tap 3D noise.
 */

import { ROOT_DISC_RADIUS } from '../../../../../shared/node-size'
import { glslVec3, LINEAR_TO_SRGB_GLSL, rgbToLinear, type Rgb } from './srgb'

/* ------------------------------------------------------------------ */
/*  The lattice                                                        */
/* ------------------------------------------------------------------ */

/**
 * How fast the courses open up with distance from the origin: course depth,
 * and with it stone size, goes as `r ** GROWTH`.
 *
 * Medallion's value, so the two still themes agree on what "far out" looks
 * like. Ten times further out is about 1.8 times coarser and sixty times out
 * about 2.8 — a floor opening toward its edge rather than a different floor.
 */
const GROWTH = 0.25

/** How much of `log2(r)` the lattice follows. The course coordinate is `r ** FOLLOW`. */
const FOLLOW = 1 - GROWTH

/**
 * Courses between the origin and the root disc's rim.
 *
 * The whole background's scale control: it fixes how deep a course is
 * anywhere, since every other radius is measured in the same coordinate. A
 * course is `ROOT_DISC_RADIUS / (FOLLOW * RIM_COURSE)` deep at the rim, so
 * halving this doubles every stone on the canvas.
 *
 * Two puts a course boundary exactly on the rim — the one landmark the canvas
 * has — and makes a course 210 units deep there, growing to about 300 out
 * where the tree actually lives. Half that drew a floor of cobbles that read
 * as texture rather than as stones.
 *
 * It is also what hides the wedges. Courses 0 and 1 lie inside the rim and
 * are cut into `MIN_PAVERS` wedges each; course 2 is the first outside it.
 */
const RIM_COURSE = 2

/** Depth of a course at the root disc's rim, in world units. */
const COURSE_AT_RIM = ROOT_DISC_RADIUS / (FOLLOW * RIM_COURSE)

/**
 * How much wider than deep a stone aims to be.
 *
 * Four to three: a paver rather than a tile, leaning wide the way brickwork
 * does, and never so wide that a stone reads as a slab. The count that best
 * hits this is rounded to a whole number per course, so a real stone is within
 * `1 / (2 * count)` of it.
 */
const ASPECT = 4 / 3

/**
 * The fewest stones a course may have.
 *
 * Six is where a wedge stops being a stone at all, and every course that would
 * otherwise want fewer is under the root disc anyway. Any whole number here
 * closes the ring; this one only decides how the hidden courses are cut.
 */
const MIN_PAVERS = 6

/** Half the width of a mortar joint, in world units — the gap round each stone. */
const JOINT = 6

/** Radius of a stone's rounded corners, in world units. */
const CORNER = 15

/** How far in from a stone's edge its chamfer reaches, in world units. */
const CHAMFER = 18

/**
 * The warp: how far, in world units, the whole floor is pushed about, and the
 * wavelength of the field that pushes it.
 *
 * Hand-laid stone is never on a true grid. Rather than roughen each stone's
 * outline on its own — which would also vary the width of every joint — the
 * *position* is warped before anything is laid out, by one octave of vector
 * noise in world space. A stone's edges then bow gently, its corners are not
 * quite right angles, and a joint between two stones stays one joint of one
 * width, because both stones were moved together.
 *
 * The push is small and the field turns over several times within one stone,
 * so an edge is *rough* rather than bowed: the first cut used ten units on a
 * wavelength of 120, and stones that bulge and lean by a twentieth of their
 * width look like a cartoon of paving rather than paving. Four units on a
 * wavelength of 36 is the difference between a cut edge and a drawn one, and
 * no more. The wavelength is a fixed size in world space, so the warp is part
 * of the painting and does not breathe with zoom.
 */
const WARP = 4
const WARP_WAVELENGTH = 36

/**
 * The grain's octaves: wavelength in world units, and weight.
 *
 * Four, from a mottle a quarter of a stone across down to a speckle a couple of
 * units wide. Each is retired on its own as its wavelength approaches the pixel
 * footprint, so the fine ones go first and nothing sparkles. Weights sum to
 * one, so the grain is a signed fraction of the stone's tone.
 */
const GRAIN_OCTAVES: readonly (readonly [wavelength: number, weight: number])[] = [
  [52, 0.40],
  [18, 0.28],
  [6.5, 0.20],
  [2.4, 0.12],
]

/** Courses per band: every `BAND`th course is laid a shade darker. */
const BAND = 6

/* ------------------------------------------------------------------ */
/*  Palette                                                            */
/* ------------------------------------------------------------------ */

/**
 * Greys, given in sRGB and decoded once at build time — see `./srgb`.
 *
 * Grayscale, and dark enough to be furniture: the lightest stone is under a
 * fifth of the way to white before it is lit, and only the lit chamfer goes
 * above that. This is a background that fills area with tone where a woven
 * one only draws lines, so every value here is well under what Medallion
 * spends on its highlights. These are exactly half, in linear light, of the
 * first cut's values — which read as a floor in daylight next to cards that
 * are lit like a room at night.
 */
interface PaverPalette {
  /** What the canvas fades to when the stones are too small to draw. */
  ground: Rgb
  /** The joints between stones. */
  mortar: Rgb
  /** The darkest and lightest a stone is cut from; each stone picks a tone between. */
  stoneDark: Rgb
  stoneLight: Rgb
}

const PALETTE: PaverPalette = {
  ground: [0.048, 0.048, 0.048],
  mortar: [0.060, 0.060, 0.060],
  stoneDark: [0.110, 0.110, 0.110],
  stoneLight: [0.188, 0.188, 0.188],
}

const paletteGlsl = (p: PaverPalette): string => `
const vec3 GROUND      = ${glslVec3(rgbToLinear(p.ground))};
const vec3 MORTAR      = ${glslVec3(rgbToLinear(p.mortar))};
const vec3 STONE_DARK  = ${glslVec3(rgbToLinear(p.stoneDark))};
const vec3 STONE_LIGHT = ${glslVec3(rgbToLinear(p.stoneLight))};
`

/* ------------------------------------------------------------------ */
/*  The shader                                                         */
/* ------------------------------------------------------------------ */

export const PAVER_BG_FRAG = `
precision highp float;
uniform vec2 uOrigin;
uniform float uZoom;
uniform float uDpr;

${paletteGlsl(PALETTE)}

const float TAU = 6.28318530718;
const float FOLLOW  = ${FOLLOW.toFixed(4)};
const float RIM_COURSE = ${RIM_COURSE}.0;
/** 1 / the radius at which the course coordinate is RIM_COURSE. */
const float INV_RIM = ${(1 / ROOT_DISC_RADIUS).toFixed(9)};
const float ASPECT  = ${ASPECT.toFixed(4)};
const float MIN_PAVERS = ${MIN_PAVERS}.0;
const float JOINT   = ${JOINT.toFixed(2)};
const float CORNER  = ${CORNER.toFixed(2)};
const float CHAMFER = ${CHAMFER.toFixed(2)};
const float BAND    = ${BAND}.0;
const float WARP    = ${WARP.toFixed(2)};
const float WARP_SCALE = ${(1 / WARP_WAVELENGTH).toFixed(6)};

/** Where the light comes from, in world space. Up and to the left on screen. */
const vec2 LIGHT = vec2(-0.5547, 0.8321);

/**
 * Hashes without trig. Small integer inputs throughout — stone and course
 * indices, and noise lattice points in a stone's own frame — so there is no
 * precision cliff far from the origin, where a hash of the raw world position
 * would have run out of fraction bits.
 */
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}

vec3 hash32(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yxz + 33.33);
  return fract((p3.xxy + p3.yzz) * p3.zyx);
}

/** Value noise, one octave: four hashes and a bilinear blend. */
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash12(i);
  float b = hash12(i + vec2(1.0, 0.0));
  float c = hash12(i + vec2(0.0, 1.0));
  float d = hash12(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

/** The same, for a vector field: one octave of the warp costs four hashes. */
vec2 vnoise2(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  vec2 a = hash22(i);
  vec2 b = hash22(i + vec2(1.0, 0.0));
  vec2 c = hash22(i + vec2(0.0, 1.0));
  vec2 d = hash22(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

/**
 * How much of a grain octave of the given wavelength survives the pixel
 * footprint: all of it at six pixels a wavelength, none at two. Retired before
 * it goes sub-pixel, so a fine octave fades rather than sparkles.
 */
float grainAlive(float wavelength, float fp) {
  return smoothstep(wavelength * 0.5, wavelength * 0.17, fp);
}

${LINEAR_TO_SRGB_GLSL}

void main() {
  float worldPerPx = 1.0 / (uZoom * uDpr);
  vec2 world = (gl_FragCoord.xy - uOrigin) * worldPerPx;

  // The warp: the floor is pushed about a little before it is laid out, so
  // that nothing below sits on a true grid. See WARP.
  vec2 warped = world + (vnoise2(world * WARP_SCALE) - 0.5) * (2.0 * WARP);

  float raw = length(warped);
  float r = max(raw, 1e-4);
  // atan(0, 0) is undefined; the one pixel on the origin is nudged onto the +x
  // axis. It sits under the root node, but a NaN there survives every mix below.
  float theta = atan(warped.y, warped.x + step(raw, 1e-5));

  // Courses: whole values of v, spaced dr ~ r^GROWTH apart, with a boundary
  // on the root disc's rim.
  float lr = log2(r * INV_RIM);
  float v = RIM_COURSE * exp2(FOLLOW * lr);
  float row = floor(v);
  float fy = v - row;

  // How deep the course is here: dr/dv. Grows with r, so a stone far out is a
  // larger stone.
  float depth = r / (FOLLOW * v);

  // Stones around this course: as many as fit at the target aspect, always a
  // whole number so the ring closes on itself at the angular seam. The arc a
  // course subtends and its depth both scale with r, so the count depends on
  // the course alone.
  float count = max(floor(TAU * FOLLOW * (row + 0.5) / ASPECT + 0.5), MIN_PAVERS);

  // Running bond: every course starts at its own random angle, so the radial
  // joints of one course never line up with the next.
  float phase = hash12(vec2(row, 7.0));
  float a = theta * count / TAU + phase;
  float cell = mod(floor(a), count);
  float fx = fract(a) - 0.5;

  // The stone's own frame, in world units: across the course, and up it. The
  // width is the arc at *this* radius, so a stone is a true wedge — a little
  // wider at its outer edge, as a stone cut for a circle is.
  float width = TAU * r / count;
  vec2 p = vec2(fx * width, (fy - 0.5) * depth);

  // Three random numbers per stone: its tone, and where its grain is sampled.
  vec3 id = hash32(vec2(cell, row));

  // The stone's footprint: a rounded box inset from the cell by the joint. Each
  // stone is also cut a touch smaller or larger than its neighbours, which is
  // most of what stops the joints reading as a drawn grid.
  vec2 ext = vec2(0.5 * width, 0.5 * depth) - JOINT - (id.x - 0.5) * 6.0;
  vec2 q = abs(p) - ext + CORNER;
  float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - CORNER;

  // The edge's outward normal, in the stone's frame — the axis of the larger
  // component inside, the corner's direction where the rounding takes over.
  vec2 axisN = mix(vec2(0.0, sign(p.y)), vec2(sign(p.x), 0.0), step(q.y, q.x));
  vec2 cornerN = sign(p) * normalize(max(q, 0.0) + 1e-5);
  vec2 nrm = mix(axisN, cornerN, step(0.0, max(q.x, q.y)));

  // The light, expressed in the stone's frame. The frame turns with theta, so
  // the two basis vectors are the radial direction and its perpendicular — no
  // trig, just the position over its own length.
  vec2 radial = warped / r;
  vec2 tangent = vec2(-radial.y, radial.x);
  vec2 light = vec2(dot(LIGHT, tangent), dot(LIGHT, radial));
  float facing = dot(nrm, light);

  // How much of each scale of detail survives the pixel footprint — every
  // gradient here is in world units, so the footprint is worldPerPx itself.
  // Retired coarsest last, and each before it goes sub-pixel, so the canvas
  // fades to its ground rather than to a pale average of itself. The stones'
  // own fade is measured against the local course depth, since that is what
  // grows.
  float quietChamfer = smoothstep(CHAMFER, CHAMFER * 0.25, worldPerPx);
  float quietStone = smoothstep(depth / 3.0, depth / 14.0, worldPerPx);

  // Grain: four octaves in the stone's own frame. The offset is the stone's
  // hash, so no two stones share a patch of it and it breaks at every joint.
  // Each octave fades on its own as its wavelength closes on the footprint.
  vec2 gp = p + id.yz * 1024.0;
  float grain = 0.0;
${GRAIN_OCTAVES.map(([wavelength, weight], i) => `  grain += (vnoise(gp * ${(1 / wavelength).toFixed(5)} + ${(i * 7.3).toFixed(1)}) - 0.5)
    * ${weight.toFixed(2)} * grainAlive(${wavelength.toFixed(1)}, worldPerPx);`).join('\n')}

  // Coverage of the stone, antialiased over one pixel, and the chamfer: a
  // bevel from the edge inward, squared so it is a lip rather than a cushion.
  float aa = 0.5 * worldPerPx + 1e-6;
  float stone = 1.0 - smoothstep(-aa, aa, d);
  float chamfer = smoothstep(-CHAMFER, 0.0, d);
  chamfer *= chamfer * quietChamfer;

  // Every BANDth course is laid darker — a soldier course. Up close it is one
  // course of darker stones; from far enough away that no stone is visible it
  // is the only thing left, so the ground the floor fades to carries the same
  // rhythm as a soft ring, which is what a floor looks like from a long way up
  // and is the one navigation cue this background keeps at the zoom floor.
  float band = 1.0 - min(mod(row, BAND), 1.0);
  float bandWave = abs(fract((v - 0.5) / BAND) - 0.5) * 2.0;
  vec3 ground = GROUND * (1.0 - (bandWave - 0.5) * 0.22);

  vec3 tone = mix(STONE_DARK, STONE_LIGHT, id.x * 0.85 + 0.075);
  tone *= 1.0 - band * 0.22;
  tone *= 1.0 + grain * 0.7;
  // The chamfer: lit on the faces turned to the light, in shadow on the others,
  // and a little darker all round where the stone meets the joint.
  tone *= 1.0 + chamfer * (facing * 0.45 - 0.10);

  vec3 mortar = MORTAR * (1.0 + grain * 0.8);
  vec3 col = mix(mortar, tone, stone);
  col = mix(ground, col, quietStone);

  gl_FragColor = vec4(linearToSrgb(col), 1.0);
}
`

/**
 * The lattice's parameters, exported so the tests measure the shader's own
 * numbers rather than a second copy of them — see `./paver-lattice.test`.
 */
export const PAVER_LATTICE = {
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
} as const
