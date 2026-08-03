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

import { glslVec3, LINEAR_TO_SRGB_GLSL, linearEmission, rgbToLinear, type Rgb } from './srgb'

/** OKLab → sRGB, for the shaders that tint by polar angle. The grid does not. */
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
/*  Grid — a logarithmic technical grid                                */
/* ------------------------------------------------------------------ */

/** The unlit background of the grid theme, as sRGB. */
export const GRID_BASE: Rgb = [0.055, 0.058, 0.075]
/** The colour a line would reach at tone 1.0 is `GRID_BASE + GRID_LINE`. */
export const GRID_LINE: Rgb = [0.62, 0.67, 0.8]

/**
 * How far each kind of line lifts the base toward `GRID_LINE`.
 *
 * Deliberately in sRGB, which is the space these are legible and tunable in —
 * `bright` at 0.29 looks about twice as far from the background as `mid` at
 * 0.19, which is what you want when picking them, and is not at all what the
 * corresponding linear-light numbers (0.119 and 0.059) would suggest. The
 * decode to light happens in `gridEmission`, once, at module load.
 *
 * The spread between them is the whole hierarchy, so they move together: the
 * grid reads by *contrast* between tiers, not by absolute brightness, and
 * three tiers plus a brighter axis was more competing bright lines than a
 * background should put in front of someone all day.
 */
export const GRID_TONES = {
  dim: 0.11,
  mid: 0.19,
  bright: 0.29,
  /** Only just above `bright`: an axis is a decade line with a wider stroke. */
  axis: 0.33,
} as const

/** sRGB colour of a fully covered line at the given tone. */
export const gridTone = (tone: number): Rgb => [
  GRID_BASE[0] + GRID_LINE[0] * tone,
  GRID_BASE[1] + GRID_LINE[1] * tone,
  GRID_BASE[2] + GRID_LINE[2] * tone,
]

/** Linear light a fully covered line at the given tone adds to the background. */
const gridEmission = (tone: number): Rgb => linearEmission(GRID_BASE, gridTone(tone))

/**
 * A true logarithmic grid: line positions are evenly spaced in log space, so
 * they crowd toward the origin and spread without limit going out.
 *
 * ## The warp
 *
 * Each axis is mapped through `u = sign(w) * log(1 + |w| / S0) / log(B)`, and
 * a line is drawn wherever `u` hits an integer. Near the origin that map is
 * very nearly linear, so the lines there look like ordinary graph paper; far
 * out each successive line sits `B` times further than the last. There is no
 * level set and no threshold to cross — the spacing is one continuous
 * function, which is what an earlier version of this shader got wrong by
 * switching between fixed-spacing levels at a radius.
 *
 * `B` is the tenth root of ten, so ten lines make a decade and the bright ones
 * land on powers of ten.
 *
 * ## The three tones
 *
 * One family of lines, not three layers: every line has an integer index, and
 * the index decides its tone — every tenth bright, every fifth mid, the rest
 * dim. Because spacing grows exponentially, the tiers also fade at different
 * radii on their own: approaching the origin the dim lines crowd below a pixel
 * and drop out, then the mid ones, leaving the decade lines. The hierarchy of
 * detail comes out of the geometry rather than being scheduled.
 *
 * A log grid also bounds its own cost: a viewport spanning a million world
 * units contains about forty lines per axis, not a million.
 *
 * ## Why the lines do not flicker
 *
 * The first version drew each line by point-sampling a `smoothstep` of the
 * distance to it, which is the usual way and is wrong: it asks "how bright is
 * this line at the pixel's centre" when the question is "how much of this
 * pixel does the line cover". Those differ as the line drifts against the
 * pixel grid, so a line's total brightness pulsed as you zoomed — brightest
 * when it sat on a pixel centre, dimmest when it straddled two.
 *
 * Both grid and axis lines are now integrated analytically over the pixel
 * footprint — an exact box filter. `boxIntegral` is the antiderivative of the
 * periodic line indicator, so coverage is the difference of two evaluations,
 * and adjacent pixels perpendicular to a line always sum to the same total
 * (`2 * HALF_PX`) no matter where the line falls between them. It also
 * degrades correctly: once lines are closer together than a pixel the integral
 * converges on their average density, so a crowded grid greys out smoothly
 * instead of turning into moiré.
 *
 * The derivative of the warp is taken in closed form rather than with
 * `fwidth`, for the same reason. `fwidth` is a finite difference across a 2×2
 * quad, so it quantises the line width in 2-pixel blocks and spikes on the
 * quad straddling an axis, where the warp's sign flips. The exact derivative
 * has neither problem, and the shader no longer needs the derivatives
 * extension at all.
 *
 * ## Why the lines do not pulse either
 *
 * Exact coverage is necessary and not sufficient. Coverage says what fraction
 * of a pixel a line lights; turning that into a colour is a second step, and
 * the obvious way to do it — `BASE + LINE * coverage`, written straight to the
 * framebuffer — mixes *encoded* values, not light. Against a background this
 * dark that costs a decade line about a fifth of its output when it lands
 * between two pixels rather than on one, which is a visible pulse while
 * panning even with coverage exact to floating point.
 *
 * So the tones below are decoded to linear light once, in TypeScript, as the
 * amount a fully covered line *adds* to the base. A pixel emits
 * `BASE_LIN + coverage * emission`, which is affine in coverage and therefore
 * sums to the same total however the line is split, and the shader encodes to
 * sRGB once at the end. See `./srgb`.
 *
 * ## The axes
 *
 * The axes are lines of this same family — index 0 is a multiple of ten, so an
 * axis always sits on a decade line — drawn in linear pixel space rather than
 * through the warp, and only slightly brighter than the decade lines they lie
 * on. They used to be a separate paler colour composited on top, which made
 * them by some way the brightest thing on the canvas; with three tiers plus an
 * axis tone that was one bright line too many to read anything against.
 *
 * `AXIS_HALF_PX >= HALF_PX` is load-bearing rather than aesthetic: it means an
 * axis's coverage is never less than that of the decade line beneath it, so
 * the `max` below always resolves to the axis term there. Two conserved terms
 * crossing over would not be conserved through the crossing.
 */
export const GRID_BG_FRAG = `
precision highp float;
uniform vec2 uOrigin;
uniform float uZoom;
uniform float uDpr;

/** The unlit background, in linear light. */
const vec3 BASE_LIN = ${glslVec3(rgbToLinear(GRID_BASE))};
/** Linear light a fully covered line of each tone adds to it. */
const vec3 E_DIM    = ${glslVec3(gridEmission(GRID_TONES.dim))};
const vec3 E_MID    = ${glslVec3(gridEmission(GRID_TONES.mid))};
const vec3 E_BRIGHT = ${glslVec3(gridEmission(GRID_TONES.bright))};
const vec3 E_AXIS   = ${glslVec3(gridEmission(GRID_TONES.axis))};

/** World units at the first line out from the origin; sets the near-origin pitch. */
const float S0         = 120.0;
/** 1 / ln(10^(1/10)): ten line indices per decade. */
const float INV_LN_B   = 4.342944819;
/** Half-width of a grid line, in device pixels. */
const float HALF_PX    = 0.5;
/** Half-width of an axis, in device pixels. Never below HALF_PX — see above. */
const float AXIS_HALF_PX = 0.6;
/** Screen pixels below which a tier is faded out rather than left as a wash. */
const float MIN_PX     = 6.0;

${LINEAR_TO_SRGB_GLSL}

/** World coordinate to line-index space. Signed, so it is symmetric about 0. */
vec2 logCoord(vec2 w) {
    return sign(w) * log(1.0 + abs(w) / S0) * INV_LN_B;
}

/**
 * Antiderivative of the periodic line indicator: lines of half-width w
 * centred on every integer. The constant term is dropped because this is only
 * ever used as a difference.
 */
float boxIntegral(float x, float w) {
    float i = floor(x + 0.5);
    return i * 2.0 * w + clamp(x - i, -w, w);
}

/**
 * Exact fraction of one pixel covered by a unit-spaced family of lines.
 * t is the coordinate in units where lines sit on integers, dt the pixel
 * footprint in those units, w the half-width in those units.
 */
float lineCoverage(float t, float dt, float w) {
    // Measured from the nearest line, so the integer term cancels exactly
    // instead of being recovered by subtracting two large numbers.
    float f = t - floor(t + 0.5);
    float h = 0.5 * dt;
    return clamp((boxIntegral(f + h, w) - boxIntegral(f - h, w)) / dt, 0.0, 1.0);
}

/** Exact coverage by a single line at 0, with everything measured in pixels. */
float axisCoverage(float xPx, float halfPx) {
    return clamp(xPx + 0.5, -halfPx, halfPx) - clamp(xPx - 0.5, -halfPx, halfPx);
}

/** Coverage by the lines whose index is a multiple of period, both axes. */
float tier(vec2 u, vec2 du, float period) {
    vec2 dt = du / period;
    vec2 w = dt * HALF_PX;
    vec2 cov = vec2(
        lineCoverage(u.x / period, dt.x, w.x),
        lineCoverage(u.y / period, dt.y, w.y)
    );
    // Aesthetic, not an aliasing fix: the integral above already handles
    // crowding by converging on the average. This is what makes a tier drop
    // out so the coarser one reads, instead of leaving a grey wash.
    vec2 legible = smoothstep(vec2(MIN_PX), vec2(MIN_PX * 2.5), vec2(period) / du);
    return max(cov.x * legible.x, cov.y * legible.y);
}

void main() {
    float worldPerPx = 1.0 / (uZoom * uDpr);
    vec2 world = (gl_FragCoord.xy - uOrigin) * worldPerPx;
    vec2 u = logCoord(world);

    // d(logCoord)/d(world) in closed form. Continuous through zero, unlike the
    // fwidth of the same quantity.
    vec2 du = INV_LN_B * worldPerPx / (S0 + abs(world));

    vec2 axisPx = gl_FragCoord.xy - uOrigin;
    float axis = max(
        axisCoverage(axisPx.x, AXIS_HALF_PX),
        axisCoverage(axisPx.y, AXIS_HALF_PX)
    );

    // Coverage scales emission, not an encoded colour: each term is affine in
    // its coverage, so a line's total output is the same however it falls
    // between pixels. Brightest tone wins where lines coincide — the max is
    // componentwise, which is exact here because the tones share a hue.
    vec3 emission = max(
        max(tier(u, du,  1.0) * E_DIM,    tier(u, du, 5.0) * E_MID),
        max(tier(u, du, 10.0) * E_BRIGHT, axis             * E_AXIS)
    );

    gl_FragColor = vec4(linearToSrgb(BASE_LIN + emission), 1.0);
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
 * A pale chevron over a pale grid line is invisible, and on the decade lines
 * and axes — the brightest lines on the canvas, and the ones edges most often
 * run along — that is exactly where it happened. An accent hue would fix it
 * and would also be the only chromatic thing in a theme whose whole point is
 * that colour means what you say it means, so it would read as significant
 * when it is not.
 *
 * A dark rim fixes it achromatically: the same chevron is drawn twice, once
 * grown by `OUTLINE_W`, and the difference between the two coverages is the
 * outline. The arrow is then legible against a bright line and against the
 * dark field alike, which is what an accent colour would have bought without
 * spending the theme's one meaningful signal on it.
 */
export const GRID_EDGE_FRAG = `
#extension GL_OES_standard_derivatives : enable
precision highp float;
varying vec2 vUV;
uniform float uIntensity;

${CHEVRON_GLSL}

/**
 * Opaque, so brightness is set by the colour rather than by how much grid
 * shows through.
 *
 * An earlier version carried its weight in alpha, which made the chevrons
 * translucent — the grid read straight through them, and their apparent colour
 * changed depending on whether a grid line happened to be underneath. Alpha is
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
  // a highlighted edge is still legible over a bright grid line.
  vec3 rgb = mix(OUTLINE, min(CORE * uIntensity, vec3(1.0)), core);

  gl_FragColor = vec4(rgb, outline);
}
`
