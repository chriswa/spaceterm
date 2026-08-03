/**
 * The sRGB transfer function — the one place that knows a shader's output is
 * *encoded* colour rather than light.
 *
 * ## Why a background shader needs this
 *
 * Coverage antialiasing is a statement about energy: a pixel half covered by a
 * line emits half the line's light and half the background's. That only holds
 * if the halves are mixed in linear light. Mixing the encoded values instead —
 * `base + coverage * (line - base)` written straight to the framebuffer — is
 * the usual shortcut, and against a dark background it loses roughly a third
 * of a line's output when the line straddles two pixels. Coverage can be exact
 * to floating point and the line will still pulse as it drifts across the pixel
 * grid, because it is the *light* that is not being conserved.
 *
 * So: decode the constants once, composite in linear, encode at the end.
 *
 * The exact IEC 61966-2-1 curve rather than a gamma-2.2 approximation, because
 * the interesting values here are near black, where the two disagree most — a
 * near-black background decodes to about 1.8× more light under the real curve
 * than under pure 2.2, and the background is the thing every line is measured
 * against.
 */

export type Rgb = readonly [number, number, number]

/** sRGB (0–1) → linear light. */
export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

/** Linear light → sRGB (0–1). */
export function linearToSrgb(c: number): number {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055
}

export const rgbToLinear = (c: Rgb): Rgb => [srgbToLinear(c[0]), srgbToLinear(c[1]), srgbToLinear(c[2])]

/**
 * The linear light `tone` adds on top of `base`, both given as sRGB.
 *
 * This is the quantity a coverage fraction is allowed to scale: a pixel with
 * coverage `c` of a line emits `linear(base) + c * emission`, which is affine
 * in `c` and therefore sums to the same total however the line is split.
 */
export const linearEmission = (base: Rgb, tone: Rgb): Rgb => [
  srgbToLinear(tone[0]) - srgbToLinear(base[0]),
  srgbToLinear(tone[1]) - srgbToLinear(base[1]),
  srgbToLinear(tone[2]) - srgbToLinear(base[2]),
]

/**
 * A triple as a GLSL literal, for baking a decoded constant into a shader.
 *
 * WebGL 1 has no `pow` in constant expressions, so the alternative is decoding
 * per fragment — the same three constants recomputed for every pixel of a
 * full-screen quad. Decoding here keeps the GLSL free of transfer-function
 * arithmetic it would only ever produce one answer for.
 */
export const glslVec3 = (c: Rgb): string => `vec3(${c.map((v) => v.toFixed(6)).join(', ')})`

/** GLSL: linear light → the sRGB encoding the framebuffer expects. */
export const LINEAR_TO_SRGB_GLSL = `
vec3 linearToSrgb(vec3 c) {
  c = max(c, 0.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
}
`
