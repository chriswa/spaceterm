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
import { glslVec3, LINEAR_TO_SRGB_GLSL, linearEmission, rgbToLinear, type Rgb } from './srgb'

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
  // uIntensity > 1 overshoots past soft-light toward brighter
  vec3 result = mix(bg.rgb, blended, alpha * uIntensity);
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
uniform float uZoom;

${OKLAB_GLSL}
${CHEVRON_GLSL}

void main() {
  float alpha = chevronAlpha(vec2(vUV.x, fract(vUV.y)));
  if (alpha < 0.004) discard;

  vec2 canvasOffset = (gl_FragCoord.xy - uBgOrigin) / uZoom;
  vec3 rgb = max(oklch2rgb(0.75, 0.08, angularHue(canvasOffset)), 0.0);
  gl_FragColor = vec4(rgb, alpha * 0.35 * uIntensity);
}
`

/* ------------------------------------------------------------------ */
/*  Concentric — a radial ramp that resets at each root radius         */
/* ------------------------------------------------------------------ */

/**
 * The two greys the ramp runs between, as sRGB.
 *
 * Both are dark, and neither is black: a black trough next to a grey crest
 * makes the crest read as *lit*, which is exactly the sort of thing a
 * background should not be doing behind a canvas full of cards. Two shades of
 * the same cool grey read instead as one surface with a gradient in it.
 *
 * The step between them (about 0.045 in sRGB, a little over 4% of the range)
 * is the only thing on screen with no meaning attached to it, so it is set to
 * the smallest one that still resolves as an edge at the cliff rather than as
 * a banding artefact on a wide flat area. Both carry the same slight blue cast
 * the rest of the theme's neutrals do — the hue must match, or the ramp reads
 * as a shift in material rather than in tone.
 *
 * Given as endpoints rather than as `base` plus a tone: a gradient between two
 * colours is what this is, and a pair is what you actually pick when tuning it.
 */
export const CONCENTRIC_DARK: Rgb = [0.098, 0.110, 0.133]
export const CONCENTRIC_PALE: Rgb = [0.141, 0.157, 0.188]

/** Linear light the top of the ramp adds to the bottom. */
const rampEmission = (): Rgb => linearEmission(CONCENTRIC_DARK, CONCENTRIC_PALE)

/**
 * A radial ramp: the grey brightens smoothly with distance from the origin,
 * then drops back in one step at every whole multiple of the root node's
 * radius. Concentric, evenly spaced, and only one hard edge per period — with
 * the brightening held back until near the cliff, so most of the canvas is the
 * darker grey. See `EASE`.
 *
 * ## The geometry
 *
 * `r = |world|`, and the tone is `fract(r / PERIOD)` eased by `EASE` — 0 at
 * the bottom of each ramp, approaching 1 just before the next cliff. The
 * period is constant, so the cliffs are evenly spaced from the origin out
 * however far you pan, and there is no tier structure because there are no
 * decades to mark.
 *
 * The asymmetry is the point. A symmetric gradient (out and back) reads as
 * soft concentric blur with no fixed features in it; a ramp that resets hard
 * gives every period one crisp circle to locate yourself against, and the
 * gradient between them tells you which way is out.
 *
 * ## Why `PERIOD` is the root node's radius
 *
 * The root node is a disc at the origin, and it is the one fixed landmark on
 * the canvas — so the ramp is hung off it rather than off a number picked to
 * look right on its own. At `PERIOD = ROOT_DISC_RADIUS` the first cliff lands
 * exactly on the node's rim: the ramp under the node brightens out to its
 * edge, and the step down happens precisely where the node ends. Every cliff
 * after that is a whole number of root radii out, so the background reads as
 * *that circle, repeated*, instead of as a pattern the node happens to sit in
 * front of.
 *
 * `ROOT_DISC_RADIUS`, not `ROOT_NODE_RADIUS`: the latter is the node's *box*,
 * which is larger than the circle drawn in it, and hanging the ramp off it put
 * every cliff about 40% too far out. Anything aligning to what is on screen
 * wants the disc.
 *
 * It also means resizing the root node rescales the background with it, which
 * is the behaviour `ROOT_FOCUS_RADIUS` already has for the camera.
 *
 * ## What a fixed pitch costs
 *
 * The log grid this replaced was scale-free — it looked the same at every
 * zoom, because its spacing grew with radius. A fixed pitch cannot be, so the
 * ramp has a zoom range and `MIN_PX` fades it out below it. A root radius
 * happens to suit the comfortable range (`ZOOM_SNAP_LOW` to `ZOOM_SNAP_HIGH`):
 * a couple of periods across the screen zoomed in, tens of them zoomed out,
 * and flat only in the rubber-band region past `MIN_ZOOM` where nothing else
 * is readable either.
 *
 * ## Why the cliff does not crawl
 *
 * The first version of this background point-sampled a `smoothstep` of the
 * distance to the nearest line, which is the usual way and is wrong: it asks
 * "what colour is this pixel's centre" when the question is "what is the
 * average colour over this pixel". Those differ as an edge drifts against the
 * pixel grid, so the boundary shimmered as you zoomed.
 *
 * The ramp is integrated analytically over the pixel footprint instead — an
 * exact box filter along the radial direction, where all the variation is.
 * `rampIntegral` is the antiderivative of the sawtooth, so a pixel's tone is
 * the difference of two evaluations over its footprint. That spends exactly
 * one pixel on the cliff wherever it falls, and it degrades correctly: once a
 * period is thinner than a pixel the integral converges on the ramp's mean
 * rather than turning into moiré.
 *
 * The footprint is exact rather than an `fwidth`, for the same reason.
 * `fwidth` is a finite difference across a 2×2 quad, so it quantises the
 * transition in 2-pixel blocks; `|grad r| = 1` everywhere away from the
 * origin, so the exact figure is just the pixel size in world units and the
 * shader does not need the derivatives extension at all.
 *
 * ## Why the gradient does not band
 *
 * An exact tone is necessary and not sufficient. It says where in the ramp a
 * pixel sits; turning that into a colour is a second step, and the obvious way
 * to do it — `mix(DARK, PALE, tone)`, written straight to the framebuffer —
 * mixes *encoded* values, not light. Against colours this dark that bends the
 * ramp away from a straight line in light, which over a gradient this wide and
 * this shallow is exactly the condition that shows up as contour banding.
 *
 * So the pair is decoded to linear light once, in TypeScript, as the amount
 * the top of the ramp *adds* to the bottom. A pixel emits
 * `DARK_LIN + tone * emission`, which is affine in the tone and therefore
 * averages correctly, and the shader encodes to sRGB once at the end. See
 * `./srgb`.
 */
export const CONCENTRIC_BG_FRAG = `
precision highp float;
uniform vec2 uOrigin;
uniform float uZoom;
uniform float uDpr;

/** The bottom of the ramp, in linear light. */
const vec3 DARK_LIN = ${glslVec3(rgbToLinear(CONCENTRIC_DARK))};
/** Linear light the top of the ramp adds to it. */
const vec3 E_RAMP   = ${glslVec3(rampEmission())};

/** World units per ramp: the root node's radius — see above. */
const float PERIOD     = ${ROOT_DISC_RADIUS.toFixed(1)};
/** Device pixels per ramp below which the pattern fades out. */
const float MIN_PX     = 3.0;

${LINEAR_TO_SRGB_GLSL}

/**
 * Mean tone over one period, and so the average brightness of the entire
 * background. 1 / (EASE + 1) for the cubic below — turn the easing and this
 * turns with it.
 */
const float MEAN = 0.25;

/**
 * Antiderivative of the ramp, which is the cubic f^3 — the tone sits near the
 * dark grey for most of a period and swings to the pale one only as it
 * approaches the cliff.
 *
 * A linear ramp spent half of every period above the midpoint, which read as a
 * pale canvas with dark rings cut into it: the gradient was the figure and the
 * dark was the gap. Easing it moves the balance the other way, so the canvas
 * *is* the dark grey and each cliff gets a highlight leaning into it.
 *
 * ## Why the exponent is spelled out rather than a constant
 *
 * The integral of f^3 is f^4/4, written here as two multiplications. Raising f
 * to a constant exponent reads better and costs a transcendental — and this is
 * called three times per fragment, on a full-screen quad, plus once more per
 * fragment of every card mask. Some drivers strength-reduce a constant exponent
 * to multiplications and some do not, and there is no way to tell which one a
 * user got.
 *
 * The price is that the easing now lives in two places: change the curve and
 * MEAN, this function, and the port in the tests all move together. Three lines
 * in exchange for the shader's cost not depending on the driver.
 *
 * The constant term is dropped because this is only ever used as a difference.
 */
float rampIntegral(float x) {
    float i = floor(x);
    float f = x - i;
    float f2 = f * f;
    return (i + f2 * f2) * MEAN;
}

/**
 * Exact average tone over one pixel. u is the radius in periods, du the pixel
 * footprint in periods.
 */
float rampTone(float u, float du) {
    float h  = 0.5 * du;
    float lo = u - h;
    float hi = u + h;

    // The pixel on the origin has no negative radius to average over: its
    // footprint folds back on itself, and the part that would sit at r < 0
    // reads the same ramp outward again. Without this the centre pixel
    // averages in the period *behind* the origin — the bright end of a ramp
    // that is not there — and the origin picks up a lit speck.
    float folded = max(-lo, 0.0);
    lo = max(lo, 0.0);

    // Both ends shifted by the same whole period, so the arithmetic stays near
    // zero however far out the pixel is instead of differencing two large
    // numbers. Sound because the ramp has period 1 in u, which is also what
    // makes this continuous where the shift changes.
    float n = floor(lo);

    float area = rampIntegral(hi - n) - rampIntegral(lo - n) + rampIntegral(folded);
    return clamp(area / du, 0.0, 1.0);
}

void main() {
    float worldPerPx = 1.0 / (uZoom * uDpr);
    vec2 world = (gl_FragCoord.xy - uOrigin) * worldPerPx;

    // |grad r| = 1, so a pixel's footprint in periods is its world size over
    // the period — exact, and the same everywhere.
    float u    = length(world) / PERIOD;
    float du   = worldPerPx / PERIOD;
    float tone = rampTone(u, du);

    // Aesthetic, not an aliasing fix: the integral above already handles
    // periods thinner than a pixel by converging on the ramp's mean. But a
    // canvas that settles to a flat wash as you zoom out is worse than one
    // that goes quiet, so past that point it fades to the bottom of the ramp
    // instead.
    tone *= smoothstep(MIN_PX, MIN_PX * 2.5, PERIOD / worldPerPx);

    // The tone scales emission, not an encoded colour: the term is affine in
    // it, so the gradient is a straight line in light from one grey to the other.
    gl_FragColor = vec4(linearToSrgb(DARK_LIN + tone * E_RAMP), 1.0);
}
`

/**
 * Chevrons in one neutral tone, held still, outlined in near-black.
 *
 * Direction is the part of the animated edge worth keeping — which way a tree
 * runs is genuinely load-bearing — so the arrow shape is unchanged and only
 * the motion and the hue are gone. Colour is left to the node presets, which
 * is the only place in this theme where colour means anything.
 *
 * ## Why these are outlined and the other themes' are not
 *
 * A pale chevron over a pale band is invisible, and half the canvas is a pale
 * band. An accent hue would fix it
 * and would also be the only chromatic thing in a theme whose whole point is
 * that colour means what you say it means, so it would read as significant
 * when it is not.
 *
 * A dark rim fixes it achromatically: the same chevron is drawn twice, once
 * grown by `OUTLINE_W`, and the difference between the two coverages is the
 * outline. The arrow is then legible against either band alike, which is what an accent colour would have bought without spending the
 * theme's one meaningful signal on it.
 */
export const CONCENTRIC_EDGE_FRAG = `
#extension GL_OES_standard_derivatives : enable
precision highp float;
varying vec2 vUV;
uniform float uIntensity;

${CHEVRON_GLSL}

/**
 * Opaque, so brightness is set by the colour rather than by how much of the
 * background shows through.
 *
 * An earlier version carried its weight in alpha, which made the chevrons
 * translucent — the bands read straight through them, and their apparent colour
 * changed depending on which band happened to be underneath. Alpha is
 * now coverage only: antialiasing at the silhouette, fully opaque inside. The
 * core is therefore about the luminance the translucent version *averaged* to,
 * not the value it was written with.
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

  gl_FragColor = vec4(rgb, outline);
}
`
