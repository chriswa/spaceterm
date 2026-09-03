/**
 * GLSL for the `background` and `edges` facets.
 *
 * Sources only — which shader a theme uses is `./facets`, and which theme is
 * active is `./themes`. `CanvasBackground` compiles whatever it is handed, so
 * a new look is a string here plus a facet entry there, and the renderer does
 * not change.
 *
 * ## The contract a fragment shader must satisfy
 *
 * Both stages are given the same uniforms regardless of which ones they use —
 * `getUniformLocation` returns `null` for a uniform the shader omitted, and
 * `gl.uniform*(null, …)` is a documented no-op. A shader may therefore ignore
 * `uBgTime` (as two of the three edge shaders below do) without the renderer
 * knowing.
 *
 * - **Background** (drawn as a full-screen quad *and* as the card-masking
 *   quads): `iTime`, `uOrigin`, `uZoom`, `uDpr`. It must be a pure function of
 *   `gl_FragCoord` — the mask quads rely on a quad drawn anywhere on screen
 *   reproducing exactly the pixels the full-screen pass produced, so nothing
 *   may depend on the quad's own geometry.
 * - **Edge** (drawn as chevron-textured quads along tree edges): `uBgTime`,
 *   `uBgOrigin`, `uZoom`, `uDpr`, `uIntensity`, plus `vUV` from a vertex
 *   shader. `uIntensity` is 1.0 for ordinary edges and 3.0 for the
 *   selected/reparent-preview highlight, so a shader has to stay legible when
 *   its output is pushed well past its normal brightness.
 *
 * ## Screen space, and why `uDpr` exists
 *
 * `(gl_FragCoord.xy - uOrigin) / uZoom` is world space **times the device
 * pixel ratio**, because `uOrigin` is in framebuffer pixels while `uZoom` is
 * CSS-pixels-per-world-unit. Shaders that only need an angle or a relative
 * radius can ignore that factor, and the noise ones do. A shader whose
 * constants are real world distances — a grid spacing, say — cannot: it would
 * draw at half scale on a non-retina display. Divide by `uDpr` for true world
 * units.
 *
 * A background and an edge shader are *separate* facets and need not come from
 * the same family — the nebula edge shader is the only one that evaluates the
 * background field, and it is the only pairing that is not free to mix.
 */

import { ROOT_DISC_RADIUS } from '../../../../../shared/node-size'
import { glslVec3, LINEAR_TO_SRGB_GLSL, rgbToLinear, type Rgb } from './srgb'

/** OKLab → sRGB, for the shaders that tint by polar angle. Concentric does not. */
const OKLAB_GLSL = `
const float PI = 3.14159265358979;

vec3 oklab2rgb(vec3 lab) {
    float l_ = lab.x + 0.3963377774 * lab.y + 0.2158037573 * lab.z;
    float m_ = lab.x - 0.1055613458 * lab.y - 0.0638541728 * lab.z;
    float s_ = lab.x - 0.0894841775 * lab.y - 1.2914855480 * lab.z;
    float l = l_*l_*l_;
    float m = m_*m_*m_;
    float s = s_*s_*s_;
    return vec3(
        +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
        -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
        -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s
    );
}

vec3 oklch2rgb(float L, float C, float h) {
    return oklab2rgb(vec3(L, C * cos(h), C * sin(h)));
}

/** The canvas-wide hue ramp: hue is a function of angle about the origin. */
float angularHue(vec2 canvasOffset) {
    return PI * 8.0 / 12.0 - atan(canvasOffset.y, canvasOffset.x);
}
`

/**
 * The chevron an edge quad is textured with, as a signed-distance field.
 *
 * Identical in every theme — only the colour poured into it, and whether it
 * moves, differ — so it is shared rather than pasted per theme. Which way a
 * tree runs is load-bearing information, so no theme is free to drop it.
 * Requires `GL_OES_standard_derivatives` for `fwidth`, which each edge shader
 * enables.
 */
const CHEVRON_GLSL = `
float sdSegment(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h);
}

const vec2  APEX   = vec2(0.5, 0.125);
const vec2  BASE_L = vec2(0.15, 0.82);
const vec2  BASE_R = vec2(0.85, 0.82);
const float HALF_W = 0.06;

// Signed distance to the chevron's centre line.
float chevronDistance(vec2 uv) {
  return min(sdSegment(uv, APEX, BASE_L), sdSegment(uv, APEX, BASE_R));
}

// Coverage of the chevron grown to an arbitrary half-width, antialiased to one
// pixel. Exposed separately so a theme can draw the same chevron twice at two
// widths and get an outline out of the difference.
float chevronCoverage(float d, float halfWidth) {
  float aa = fwidth(d) * 0.75;
  return 1.0 - smoothstep(halfWidth - aa, halfWidth + aa, d);
}

// Coverage of the chevron at uv, antialiased to one pixel.
float chevronAlpha(vec2 uv) {
  return chevronCoverage(chevronDistance(uv), HALF_W);
}
`

/** Shared by every theme's background pass: a clip-space full-screen quad. */
export const BG_VERT_SRC = `
attribute vec2 a_position;
void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`

/**
 * The default edge vertex shader: world-space quad → clip space, with a V
 * coordinate that scrolls over time so the chevrons crawl parent-to-child.
 *
 * An edge facet may supply its own instead — the scroll is applied here, before
 * interpolation, so a fragment shader cannot opt out of it.
 */
export const EDGE_VERT_SRC = `
attribute vec2 a_position;
attribute vec2 a_uv;
uniform vec2 uPan;
uniform float uZoom;
uniform vec2 uResolution;
uniform float uTime;
varying vec2 vUV;

void main() {
  vec2 screen = a_position * uZoom + uPan;
  float ndcX = 2.0 * screen.x / uResolution.x - 1.0;
  float ndcY = 1.0 - 2.0 * screen.y / uResolution.y;
  gl_Position = vec4(ndcX, ndcY, 0.0, 1.0);
  vUV = vec2(a_uv.x, a_uv.y + uTime);
}
`

/**
 * The same, without the time term: chevrons that point but do not crawl.
 *
 * Motion in the periphery is the most expensive thing a background can do to
 * someone's attention. A theme meant to be worked in front of all day can
 * still show direction without asking for a glance every second.
 */
export const EDGE_VERT_STATIC_SRC = `
attribute vec2 a_position;
attribute vec2 a_uv;
uniform vec2 uPan;
uniform float uZoom;
uniform vec2 uResolution;
varying vec2 vUV;

void main() {
  vec2 screen = a_position * uZoom + uPan;
  float ndcX = 2.0 * screen.x / uResolution.x - 1.0;
  float ndcY = 1.0 - 2.0 * screen.y / uResolution.y;
  gl_Position = vec4(ndcX, ndcY, 0.0, 1.0);
  vUV = a_uv;
}
`

/* ------------------------------------------------------------------ */
/*  Nebula — seven octaves of 3D noise                                 */
/* ------------------------------------------------------------------ */

/**
 * The expensive one. Shared between the nebula background and its edge shader,
 * because the edges soft-light against the *same* field rather than an
 * approximation of it — which is why the edge pass has to evaluate all seven
 * octaves a second time.
 */
const NEBULA_FIELD_GLSL = `
float snoise(vec3 uv, float res) {
    const vec3 s = vec3(1e0, 1e2, 1e3);
    uv *= res;
    vec3 uv0 = floor(mod(uv, res))*s;
    vec3 uv1 = floor(mod(uv+vec3(1.), res))*s;
    vec3 f = fract(uv); f = f*f*(3.0-2.0*f);
    vec4 v = vec4(uv0.x+uv0.y+uv0.z, uv1.x+uv0.y+uv0.z,
                    uv0.x+uv1.y+uv0.z, uv1.x+uv1.y+uv0.z);
    vec4 r = fract(sin(v*1e-1)*1e3);
    float r0 = mix(mix(r.x, r.y, f.x), mix(r.z, r.w, f.x), f.y);
    r = fract(sin((v + uv1.z - uv0.z)*1e-1)*1e3);
    float r1 = mix(mix(r.x, r.y, f.x), mix(r.z, r.w, f.x), f.y);
    return mix(r0, r1, f.z)*2.-1.;
}

vec4 computeBackground(vec2 fragCoord, float bgTime, vec2 bgOrigin, float bgZoom, float lumFloor) {
    vec2 canvasOffset = (fragCoord - bgOrigin) / bgZoom;
    float r = length(canvasOffset) * 0.5;
    float theta = atan(canvasOffset.y, canvasOffset.x);
    float logR = log(1.0 + r / 100.0) * 0.16;
    vec2 p = vec2(cos(theta), sin(theta)) * logR;
    float d = length(p) / 3.0;
    float color = 3.0 - (3. * d * 2.4);
    vec3 coord = vec3(atan(p.x,p.y)/6.2832+.5, d*.4, .5);
    for(int i = 1; i <= 7; i++) {
        float power = pow(2.0, float(i));
        color += (1.5 / power) * snoise(coord + vec3(0.,bgTime*.05/9., -bgTime*.01/9.), power*16.);
    }
    float c = max(color, 0.0);
    float lum = smoothstep(0.0, 0.5, c) * 0.4
              + smoothstep(0.5, 1.5, c) * 0.3
              + smoothstep(1.5, 2.5, c) * 0.3;
    float base = max(lum, lumFloor);
    vec3 tint = max(oklch2rgb(0.51, 0.06, angularHue(canvasOffset)), 0.0);
    return vec4(tint * base * 1.2, 1.0);
}
`

// Based on shader by Trisomie21 — https://www.shadertoy.com/view/lsf3RH
export const NEBULA_BG_FRAG = `
precision highp float;
uniform float iTime;
uniform vec2 uOrigin;
uniform float uZoom;
${OKLAB_GLSL}
${NEBULA_FIELD_GLSL}
void main() {
    gl_FragColor = computeBackground(gl_FragCoord.xy, iTime, uOrigin, uZoom, 0.0);
}
`

export const NEBULA_EDGE_FRAG = `
#extension GL_OES_standard_derivatives : enable
precision highp float;
varying vec2 vUV;
uniform float uBgTime;
uniform vec2 uBgOrigin;
uniform float uIntensity;
uniform float uBrightness;
uniform float uZoom;

${OKLAB_GLSL}
${NEBULA_FIELD_GLSL}
${CHEVRON_GLSL}

// W3C soft-light compositing (Figma-compatible)
float softLightChannel(float backdrop, float source) {
  if (source <= 0.5) {
    return backdrop - (1.0 - 2.0 * source) * backdrop * (1.0 - backdrop);
  } else {
    float d = (backdrop <= 0.25)
      ? ((16.0 * backdrop - 12.0) * backdrop + 4.0) * backdrop
      : sqrt(backdrop);
    return backdrop + (2.0 * source - 1.0) * (d - backdrop);
  }
}

vec3 softLight(vec3 backdrop, vec3 source) {
  return vec3(
    softLightChannel(backdrop.r, source.r),
    softLightChannel(backdrop.g, source.g),
    softLightChannel(backdrop.b, source.b)
  );
}

void main() {
  float alpha = chevronAlpha(vec2(vUV.x, fract(vUV.y)));
  if (alpha < 0.004) discard;

  vec4 bg = computeBackground(gl_FragCoord.xy, uBgTime, uBgOrigin, uZoom, 0.15);
  vec3 blended = softLight(bg.rgb, vec3(1.0));
  // uIntensity > 1 overshoots past soft-light toward brighter. Age darkens
  // the finished chevron toward black without making it more transparent.
  vec3 result = mix(bg.rgb, blended, alpha * uIntensity) * uBrightness;
  gl_FragColor = vec4(result, bg.a);
}
`

/* ------------------------------------------------------------------ */
/*  Ember — two 1D noise lookups                                       */
/* ------------------------------------------------------------------ */

/**
 * Smooth 1D value noise. The cheapest field that still looks organic: two
 * octaves along the angle only, so cost per pixel is a pair of `sin` calls
 * rather than the sixteen-lookup 3D noise the nebula runs seven times.
 */
const NOISE_1D_GLSL = `
float noise1d(float x) {
    float f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    float a = fract(sin(floor(x) * 127.1) * 43758.5);
    float b = fract(sin((floor(x) + 1.0) * 127.1) * 43758.5);
    return mix(a, b, f);
}
`

export const EMBER_BG_FRAG = `
precision highp float;
uniform float iTime;
uniform vec2 uOrigin;
uniform float uZoom;

${OKLAB_GLSL}
${NOISE_1D_GLSL}

void main() {
    vec2 canvasOffset = (gl_FragCoord.xy - uOrigin) / uZoom;
    float theta = atan(canvasOffset.y, canvasOffset.x);

    // Organic radial streaks — two octaves along the angle, drifting in time
    float slow = iTime * 0.03;
    float streak = 0.8 + 0.2 * (noise1d(theta * 12.0 + slow) * 0.6
                              + noise1d(theta * 31.0 - slow * 0.7) * 0.4);

    vec3 rgb = max(oklch2rgb(0.45 * streak, 0.06, angularHue(canvasOffset)), 0.0);
    gl_FragColor = vec4(rgb, 1.0);
}
`

export const EMBER_EDGE_FRAG = `
#extension GL_OES_standard_derivatives : enable
precision highp float;
varying vec2 vUV;
uniform vec2 uBgOrigin;
uniform float uIntensity;
uniform float uBrightness;
uniform float uZoom;

${OKLAB_GLSL}
${CHEVRON_GLSL}

void main() {
  float alpha = chevronAlpha(vec2(vUV.x, fract(vUV.y)));
  if (alpha < 0.004) discard;

  vec2 canvasOffset = (gl_FragCoord.xy - uBgOrigin) / uZoom;
  vec3 rgb = max(oklch2rgb(0.75, 0.08, angularHue(canvasOffset)), 0.0);
  gl_FragColor = vec4(rgb * uBrightness, alpha * 0.35 * uIntensity);
}
`

/* ------------------------------------------------------------------ */
/*  Still edges, for the backgrounds that hold still                   */
/* ------------------------------------------------------------------ */

/**
 * Chevrons in one neutral tone, held still, outlined in near-black.
 *
 * Direction is the part of the animated edge worth keeping — which way a tree
 * runs is genuinely load-bearing — so the arrow shape is unchanged and only
 * the motion and the hue are gone. Colour is left to the node presets, which
 * is the only place in this theme where colour means anything.
 *
 * ## Why these are outlined and the animated themes' are not
 *
 * The still backgrounds are patterned — stone, weave — and a pale chevron over
 * a pale patch of pattern is invisible. An accent hue would fix it and would
 * also be the only chromatic thing in a theme whose whole point is that colour
 * means what you say it means, so it would read as significant when it is not.
 *
 * A dark rim fixes it achromatically: the same chevron is drawn twice, once
 * grown by `OUTLINE_W`, and the difference between the two coverages is the
 * outline. The arrow is then legible against light and dark ground alike,
 * which is what an accent colour would have bought without spending the
 * theme's one meaningful signal on it.
 */
export const STATIC_EDGE_FRAG = `
#extension GL_OES_standard_derivatives : enable
precision highp float;
varying vec2 vUV;
uniform float uIntensity;
uniform float uBrightness;

${CHEVRON_GLSL}

/**
 * Opaque at full brightness, so its normal colour does not depend on the
 * background showing through.
 *
 * An earlier version carried its weight in alpha, which made the chevrons
 * translucent — the bands read straight through them, and their apparent colour
 * changed depending on which band happened to be underneath. Alpha is normally
 * coverage only: antialiasing at the silhouette, fully opaque inside. The core
 * is therefore about the luminance the translucent version *averaged* to, not
 * the value it was written with. uBrightness intentionally darkens the
 * finished chevron toward black while preserving that coverage.
 */
const vec3  CORE       = vec3(0.42, 0.45, 0.52);
const vec3  OUTLINE    = vec3(0.02, 0.02, 0.03);
/**
 * Rim thickness, in the same UV units as HALF_W.
 *
 * The ceiling is 0.065: the chevron's apex sits at v = 0.125 in the tile, so a
 * total half-width past that clips the tip against the tile boundary. A
 * thicker rim than this needs the chevron geometry moved down the tile, which
 * CHEVRON_GLSL shares with the other themes.
 */
const float OUTLINE_W  = 0.06;

void main() {
  float d = chevronDistance(vec2(vUV.x, fract(vUV.y)));

  float outline = chevronCoverage(d, HALF_W + OUTLINE_W);
  if (outline < 0.004) discard;
  float core = chevronCoverage(d, HALF_W);

  // One fragment, not two passes: colour runs from rim to core across the same
  // two coverages. Compositing them as separate draws would need the outline
  // pass to avoid the core, which this gets for free — and costs one extra
  // smoothstep rather than a second set of geometry.
  //
  // uIntensity (3.0 on the selected edge) brightens the core rather than the
  // alpha, since alpha is no longer free to carry it. The rim stays black, so
  // a highlighted edge is still legible over a pale band.
  vec3 rgb = mix(OUTLINE, min(CORE * uIntensity, vec3(1.0)), core);

  gl_FragColor = vec4(rgb * uBrightness, outline);
}
`


/* ------------------------------------------------------------------ */
/*  Medallion — a woven interlace, fixed in world space                */
/* ------------------------------------------------------------------ */

/**
 * The Medallion palette: one fabric, under a light.
 *
 * Not two dyes. Two low-saturation dyes at this brightness always went muddy —
 * madder against indigo read as dirt, violet against teal as swamp — because at
 * a lightness this low the eye has no room to separate two hues and just
 * averages them.
 *
 * So the canvas is one indigo cloth, and the colour comes from *lighting* it:
 * the shadow at the bottom of the weave is deep and cool, the body of a thread
 * is slate, and the crown catching the light is warm brass. Cool shadow, warm
 * highlight is how any real lit surface behaves, and it buys a much wider swing
 * of hue than two flat dyes ever did while staying a single believable material.
 *
 * The two thread families are then separated by a whisper of tint rather than by
 * their own colours — enough to tell warp from weft, not enough to read as two
 * different things.
 */
export const MEDALLION_SHADOW: Rgb = [0.056, 0.063, 0.092]
export const MEDALLION_MID: Rgb = [0.094, 0.102, 0.132]
export const MEDALLION_HIGH: Rgb = [0.138, 0.133, 0.122]

const MEDALLION_SHADE_LO = 0.50
const MEDALLION_SHADE_HI = 1.42

/**
 * Angular divisions of the coarsest lattice ring.
 *
 * Six, the other canonical division a rosette is built on, and deliberately not
 * eight: a lattice ring then spans a factor of `e^(2*PI/6)`, about 2.9, in
 * radius before the geometry comes round again. Nothing here is tied to the
 * root node's radius, so the pattern is free to take as much radius as it wants
 * before it repeats.
 */
const MEDALLION_SECTORS = 6

/**
 * The lean given to both thread families, in lattice cells per cell — the twist
 * that turns a ring into a shallow spiral and a spoke into a leaning ray.
 *
 * At zero there is no twist at all: rings are exact circles and spokes exact
 * rays, and the weave reads as a bullseye broken up only by the interlace and by
 * the four nested octaves.
 *
 * The only other value that works is `1 / MEDALLION_SECTORS` — a ring then gains
 * exactly one thread of radius per turn, about ten degrees off circular. That is
 * the value at which the sheared lattice still closes on itself at every octave:
 * a full turn advances the lattice by `SECTORS * 2^k` cells, so the ring
 * coordinate advances by `SWIRL * SECTORS * 2^k`, and unless that is a whole
 * number of threads the rings miss where the angle wraps and one ragged seam
 * runs out to infinity. Zero clears that trivially; anything between the two
 * does not.
 */
export const MEDALLION_SWIRL = 0

/**
 * How fast the weave coarsens with distance from the origin: cell size goes as
 * `r ** MEDALLION_GROWTH`.
 *
 * At zero the lattice level rises exactly in step with `log2(r)` and a cell is
 * the same world size everywhere. A quarter is a gentle flare — ten times
 * further out is about 1.8 times coarser, sixty times out about 2.8 — which is
 * enough to feel like a fabric opening up toward its edge without ever becoming
 * a different fabric.
 *
 * It also turns feature size into a reading of distance: the weave is at its
 * tightest at the origin, so how fine the cloth is against a card of known size
 * says roughly how far from home you are.
 */
const MEDALLION_GROWTH = 0.25

/**
 * The radius the weave is calibrated at, as a multiple of the root disc.
 *
 * A radius has to be named now that cell size varies with one, and it cannot be
 * the rim itself: inside about one and a half root radii the octave window is
 * against its floor — it may not ask for an octave coarser than one division of
 * the circle, or the sheared lattice stops closing on itself — so the weave
 * there runs finer than any calibration would say. Four root radii is clear of
 * that and still somewhere you actually look.
 */
const MEDALLION_REFERENCE_RADII = 4

/**
 * World units across a cell of the finest octave drawn, at that radius.
 *
 * A world distance, not a pixel count — the pattern is painted on the canvas
 * and the camera moves over it. With four octaves the weave carries structure
 * from here up to sixteen times this, which is the range a rug's knot, motif,
 * field and border cover.
 */
const MEDALLION_FINEST_CELL = 80

/** Octaves of weave drawn at once. The window's width, and most of the cost. */
const MEDALLION_OCTAVES = 4

/**
 * A woven interlace on a log-polar lattice: rings crossing spokes, over and
 * under, drawn at four nested octaves and flaring gently outward.
 *
 * ## It is a painting, not an effect
 *
 * Everything below is a function of world position alone. Zoom appears in
 * exactly one place — the pixel footprint `fq`, which decides only how hard to
 * blur, never what to draw. Zooming in magnifies the weave; zooming out shrinks
 * it and lets the finest octaves filter away, the way any texture behaves.
 *
 * An earlier draft chose which octave to draw from the zoom, which held the
 * weave at a constant *apparent* size — a Droste effect, where zooming in gained
 * you a subdivision instead of a bigger pattern. This is the correction: the
 * detail lives in the pattern, permanently, at every scale at once.
 *
 * ## Why log-polar
 *
 * The lattice coordinate is `(theta, log r)`. That map is conformal — both axes
 * scale by `1/r` — so a square cell in lattice space is a square on screen at
 * every radius. Cells are never slivers near the origin or ribbons far out,
 * which is what the doubling ladders in earlier drafts existed to patch and
 * which this gets for nothing.
 *
 * Cells would otherwise grow in proportion to `r`, so the lattice *level* rises
 * with `log2(r)`. It rises slightly slower than that on purpose — see
 * `MEDALLION_GROWTH` — which leaves the cloth a little more open the further out
 * you go.
 *
 * ## Why rings and spokes, and not two diagonals
 *
 * The first version of this ran both thread families along the lattice
 * diagonals, so both were 45-degree spirals. It had no circumferential structure
 * whatsoever: every line on screen ran off toward the edge, following one took
 * you further from the origin rather than around it, and there was nothing left
 * to read direction from.
 *
 * So one family runs *around* and the other runs *outward* — the ring-and-spoke
 * skeleton the concentric theme is liked for. Three things then stop it reading
 * as a bullseye, none of which the concentric theme could do:
 *
 * - **Both families lean** by `MEDALLION_SWIRL`, so a ring is a shallow spiral
 *   rather than an exact circle — currently set to zero, which turns the lean
 *   off and leaves the other two to do the work.
 * - **They interlace.** Ring and spoke pass over and under alternately, so no
 *   ring is ever a continuous line — it is a run of segments ducking behind
 *   every spoke it meets.
 * - **They nest.** Four octaves at once, so a ring at one scale is subdivided by
 *   rings at the next.
 *
 * ## Why four octaves
 *
 * A single octave is one scale of pattern, which looks right over about two
 * octaves of zoom and turns to noise or to blocks outside that. Four nested
 * octaves put structure at roughly 80, 160, 320 and 640 world units at the
 * calibration radius — knot, motif, field and border.
 *
 * The octaves nest exactly: doubling the coordinate halves the cell in both
 * directions, so each is a refinement of the one below rather than an unrelated
 * pattern laid on top. Their weights come from a smooth curve on the octave's
 * distance from the nominal one, which vanishes at *both* ends of the window —
 * so as the window slides outward nothing ever appears or disappears — and which
 * peaks toward the coarse end, so the big weave carries the structure and the
 * fine ones only roughen it. A symmetric profile instead lets two octaves of
 * comparable strength cancel each other into mush.
 *
 * They are *summed* as shading rather than composited as layers. Compositing
 * lets the finest opaque layer hide everything beneath it, which wasted three
 * quarters of an earlier draft; summing lets all four scales show at once, which
 * is what makes it fractal rather than merely multi-pass.
 *
 * ## How you find your way home
 *
 * - **The rings go around.** The whole circumferential family is visible as a
 *   family, and it encircles the origin.
 * - **The weave is lit from the origin.** Each ring is shaded across its width,
 *   bright on the face turned inward and dark on the face turned out. This is
 *   the cue that survives being zoomed in a long way from home, where a ring is
 *   far too big for its curvature to show — you need one thread, not a whole arc.
 * - **The spokes converge.** Follow one inward and it takes you there.
 * - **The weave opens outward.** Feature size grows with distance from the
 *   origin, so how coarse the cloth is against a card of known size says roughly
 *   how far out you are.
 *
 * ## Cost
 *
 * One `atan`, one `log`, one `log2`, one `exp2`, one `sqrt`, and the `pow` in
 * `linearToSrgb`. Four passes of `fract`/`abs`/`mix` arithmetic on top — no
 * noise, no texture, no branch, so there is no worst case. Roughly four times a
 * single-octave weave, and still well under the nebula, which runs seven octaves
 * of sixteen-tap 3D noise twice over.
 */
export const MEDALLION_BG_FRAG = `
precision highp float;
uniform vec2 uOrigin;
uniform float uZoom;
uniform float uDpr;

/** The lighting ramp, decoded to linear light once — see ./srgb. */
const vec3 SHADOW = ${glslVec3(rgbToLinear(MEDALLION_SHADOW))};
const vec3 MID    = ${glslVec3(rgbToLinear(MEDALLION_MID))};
const vec3 HIGH   = ${glslVec3(rgbToLinear(MEDALLION_HIGH))};

const float TAU = 6.28318530718;

/** Lattice cells per radian in the coarsest ring. */
const float CELLS_PER_RADIAN = ${MEDALLION_SECTORS}.0 / TAU;

/**
 * How much of log2(r) the lattice level follows. One would hold a cell at a
 * fixed world size; less than one lets the weave coarsen outward — see
 * MEDALLION_GROWTH.
 */
const float FOLLOW = ${(1 - MEDALLION_GROWTH).toFixed(4)};

/**
 * The level offset that puts a finest-octave cell on MEDALLION_FINEST_CELL world
 * units at the root node's rim. Baked because WebGL 1 has no transcendental
 * functions in constant expressions, and this would otherwise be recomputed for
 * every pixel of a full-screen quad.
 */
const float KBIAS = ${(() => {
  const ref = ROOT_DISC_RADIUS * MEDALLION_REFERENCE_RADII
  return (
    Math.log2((Math.PI * 2 * ref) / (MEDALLION_SECTORS * MEDALLION_FINEST_CELL))
    - (1 - MEDALLION_GROWTH) * Math.log2(ref)
  )
})().toFixed(6)};

/** Octaves drawn at once, and so the width of the sliding window. */
const float WINDOW = ${MEDALLION_OCTAVES}.0;

/**
 * Half-width of a thread, in the coordinate where consecutive threads of a
 * family are exactly 1.0 apart. At 0.42 the two families between them cover most
 * of the ground and leave the small eyes a plain weave has.
 */
const float STRAP = 0.42;

/** The lean given to both families, in lattice cells per cell — see MEDALLION_SWIRL. */
const float SWIRL = ${MEDALLION_SWIRL.toFixed(6)};
const float SHEAR_LEN = ${Math.hypot(1, MEDALLION_SWIRL).toFixed(6)};

/** How far the rings' highlight is pushed onto the face turned toward home. */
const float RING_BIAS = 0.75;

/**
 * How far apart the two thread families are tinted, as a multiplier on linear
 * light. Warm for the rings, cool for the spokes, and small enough that it reads
 * as which way a thread is lying rather than as a change of yarn.
 */
const vec3 WARP_TINT = vec3(1.07, 1.02, 0.93);
const vec3 WEFT_TINT = vec3(0.93, 0.99, 1.08);

/** Where along the lighting ramp the cloth's body ends and its crown begins. */
const float CROWN = 0.80;


${LINEAR_TO_SRGB_GLSL}

/**
 * One octave of the weave, as (shading, which yarn).
 *
 * x is signed shading: -1 in the shadowed eyes between threads, +1 along a
 * thread's lit crown. y is 0 for a ring thread and 1 for a spoke.
 *
 * q is the lattice coordinate in cells; fq is the pixel footprint in the same
 * units, and is the shader's only use of zoom.
 *
 * ## The two families, and why they are not both diagonals
 *
 * The first cut of this ran both families along the lattice diagonals, so both
 * were 45-degree spirals. It had no circumferential structure at all: every line
 * on screen ran off toward the edge, and following one took you further from the
 * origin rather than around it, which left nothing to read direction from.
 *
 * So one family runs *around* — lines of constant radius — and the other runs
 * *outward*. That is the ring-and-spoke skeleton the concentric theme is liked
 * for, restored, and then broken up three ways so it never reads as a bullseye:
 *
 * - **Sheared.** Both families are tilted by SWIRL in lattice space, so a ring
 *   is a shallow spiral rather than an exact circle and a spoke leans with it.
 *   At SWIRL = 0 — where it currently sits — the shear is off.
 * - **Interrupted.** Ring and spoke cross over and under alternately, so no ring
 *   is ever a continuous line — it is a run of segments passing behind every
 *   spoke it meets.
 * - **Nested.** Four octaves at once, so a ring at one scale is subdivided by
 *   rings at the next.
 *
 * SWIRL has to leave the sheared lattice closing on itself: a full turn advances
 * the lattice by SECTORS * 2^k cells, so the ring coordinate advances by
 * SWIRL * SECTORS * 2^k, and that must be a whole number of threads at every
 * octave. Zero and one over SECTORS are the values that do — see MEDALLION_SWIRL.
 */
vec2 weaveOctave(vec2 q, float fq) {
  // Rings and spokes, each leaning by SWIRL so neither is a circle or a ray.
  float s = q.y + SWIRL * q.x;
  float d = q.x - SWIRL * q.y;

  // Signed offset from the nearest thread of each family. Signed, not absolute,
  // because which side of a ring a pixel is on is what carries the lighting.
  float es = fract(s + 0.5) - 0.5;
  float ed = fract(d + 0.5) - 0.5;

  // The shear lengthens both gradients by the same factor, so one footprint
  // still serves both families.
  float aa = fq * SHEAR_LEN + 1e-5;

  float covRing  = 1.0 - smoothstep(STRAP - aa, STRAP + aa, abs(es));
  float covSpoke = 1.0 - smoothstep(STRAP - aa, STRAP + aa, abs(ed));

  float ns = es / STRAP;
  float nd = ed / STRAP;

  // A rounded cross-section, bright along the crown and falling to the edges,
  // which is what makes a thread read as a laid yarn rather than a painted band.
  // The rings carry an extra bias that pushes the highlight to the face turned
  // toward the origin — outward is +s — so a single ring says which way home is
  // even when it is far too big for its curvature to show.
  float litRing  = clamp(1.0 - 2.0 * ns * ns - RING_BIAS * ns, -1.0, 1.0);
  float litSpoke = clamp(1.0 - 2.0 * nd * nd, -1.0, 1.0);

  // Over and under, alternating at every crossing — a plain weave. The parity of
  // the two thread indices is a checkerboard over the crossings, which is
  // exactly the alternation, and it costs one mod.
  float over = mod(floor(s + 0.5) + floor(d + 0.5), 2.0);

  float covTop = mix(covRing, covSpoke, over);
  float covBot = mix(covSpoke, covRing, over);
  float litTop = mix(litRing, litSpoke, over);
  float litBot = mix(litSpoke, litRing, over);

  // The thread on top wins where it covers, the one under it shows in between,
  // and what neither reaches is the shadow at the bottom of the weave.
  return vec2(mix(mix(-1.0, litBot, covBot), litTop, covTop),
              mix(mix(0.5, 1.0 - over, covBot), over, covTop));
}

void main() {
    float worldPerPx = 1.0 / (uZoom * uDpr);
    vec2 world = (gl_FragCoord.xy - uOrigin) * worldPerPx;

    float raw = length(world);
    float r   = max(raw, 1e-4);
    // atan(0, 0) is undefined; the single pixel on the origin is nudged onto the
    // +x axis. It sits under the root node, but a NaN there would survive every
    // fade below and show up as a lit speck.
    float theta = atan(world.y, world.x + step(raw, 1e-5));
    float lnr = log(r);

    // The lattice. Conformal, so one footprint serves both axes.
    vec2  base = vec2(theta, lnr) * CELLS_PER_RADIAN;
    float fq0  = worldPerPx * CELLS_PER_RADIAN / r;

    // Which level the weave sits at here. A function of position only — no zoom
    // — so the pattern is painted on the canvas and the camera merely moves over
    // it. FOLLOW below one is what lets the cloth coarsen outward. Clamped where
    // the innermost octave would want fewer than a whole division of the circle.
    float kf = max(FOLLOW * log2(r) + KBIAS, WINDOW - 1.0);
    float k0 = floor(kf);
    float t  = kf - k0;

    float sumShade = 0.0;
    float sumWeight = 0.0;
    float sumYarn = 0.0;
    float sumYarnWeight = 0.0;

    float e = exp2(k0 - (WINDOW - 1.0));
    for (int j = 0; j < ${MEDALLION_OCTAVES}; j++) {
        // Amplitude falls off toward the fine end, the way every octave-summed
        // texture is built: the coarse weave carries the structure and the finer
        // ones only roughen it. A symmetric profile instead lets two octaves of
        // comparable strength cancel each other into mush, which is what the
        // first cut of this did.
        //
        // Still zero at *both* ends of the window, which is what matters for
        // continuity: as the window slides outward with log2(r), an octave fades
        // in at the coarse end exactly as its neighbour fades out at the fine
        // one, so nothing ever appears or vanishes. m runs 0 at the finest to 1
        // at the coarsest.
        float m = (float(${MEDALLION_OCTAVES} - 1 - j) + t) / WINDOW;
        float w = 6.75 * m * m * (1.0 - m);

        // ...and drop an octave once its cells are finer than a pixel. This is
        // filtering, not composition: it changes how hard the same painting is
        // blurred, never what the painting is.
        float fq = fq0 * e;
        w *= smoothstep(0.55, 0.22, fq);

        vec2 oct = weaveOctave(base * e, fq);
        sumShade += w * oct.x;
        sumWeight += w;
        // The yarn is taken from the dominant octave rather than averaged flat
        // across them: squaring the weight sharpens the window enough that the
        // colour follows the octave you are actually reading.
        sumYarn += w * w * oct.y;
        sumYarnWeight += w * w;

        e *= 2.0;
    }

    // Normalised, so the weave has the same depth everywhere rather than
    // breathing as the window slides. Below the point where every octave is
    // sub-pixel it fades to flat yarn instead of to moire.
    float amp = smoothstep(0.0, 0.6, sumWeight);
    float shade = sumShade / max(sumWeight, 1e-4) * amp;
    float yarn = sumYarn / max(sumYarnWeight, 1e-4);

    // The lighting ramp: shadow to body over the lower half of the shading, body
    // to lit crown over the upper. Two stops rather than one, because the whole
    // point of the palette is that the shadow end is cool and the lit end is
    // warm — a single mix between two colours would pass through the average of
    // them instead of through the cloth's own slate.
    // Most of the cloth sits at MID and only the crown of a thread reaches the
    // warm stop. Splitting the ramp evenly instead put the whole canvas in the
    // top half of it and turned everything olive — a highlight has to be a
    // highlight, not the base colour.
    float lp = shade * 0.5 + 0.5;
    vec3 col = mix(SHADOW, MID, smoothstep(0.0, CROWN, lp));
    col = mix(col, HIGH, smoothstep(CROWN, 1.0, lp));

    // ...and a whisper of tint to say which family a thread belongs to, so the
    // rings read as one continuous system going round.
    gl_FragColor = vec4(linearToSrgb(col * mix(WARP_TINT, WEFT_TINT, yarn)), 1.0);
}
`
