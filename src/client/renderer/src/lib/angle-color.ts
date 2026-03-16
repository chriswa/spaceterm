/**
 * Position-based color utilities: derives colors from a node's world-space
 * position using the same radial-rainbow hue as the canvas background.
 */

import type { ColorPreset } from './color-presets'

const PI = Math.PI

// --- OkLab → linear RGB (ported from CanvasBackground.tsx GLSL lines 48-60) ---
function oklab2linearRGB(L: number, a: number, b: number): [number, number, number] {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b
  const l = l_ * l_ * l_
  const m = m_ * m_ * m_
  const s = s_ * s_ * s_
  return [
    +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  ]
}

// --- OkLCh → linear RGB (ported from GLSL lines 62-64) ---
function oklch2linearRGB(L: number, C: number, h: number): [number, number, number] {
  return oklab2linearRGB(L, C * Math.cos(h), C * Math.sin(h))
}

// --- Linear → sRGB gamma (standard transfer function) ---
function linearToSRGB(c: number): number {
  if (c <= 0.0031308) return 12.92 * c
  return 1.055 * Math.pow(c, 1.0 / 2.4) - 0.055
}

// --- W3C soft-light channel (ported from GLSL lines 150-158) ---
function softLightChannel(backdrop: number, source: number): number {
  if (source <= 0.5) {
    return backdrop - (1.0 - 2.0 * source) * backdrop * (1.0 - backdrop)
  }
  const d = backdrop <= 0.25
    ? ((16.0 * backdrop - 12.0) * backdrop + 4.0) * backdrop
    : Math.sqrt(backdrop)
  return backdrop + (2.0 * source - 1.0) * (d - backdrop)
}

// --- Clamp & hex ---
function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v))
}

function toHex(v: number): string {
  return Math.round(clamp01(v) * 255).toString(16).padStart(2, '0')
}

/**
 * Returns a CSS hex color for a focus border based on the node's world-space
 * position. The hue follows the canvas background's radial rainbow; the color
 * is softened by a soft-light blend with white (same as edge lines).
 *
 * @param x   World-space x coordinate of the node center
 * @param y   World-space y coordinate of the node center
 * @param boost  Optional chroma/lightness multiplier for scroll-mode (default 1)
 */
export function angleBorderColor(x: number, y: number, boost = 1): string {
  // Angle → hue (same formula as shader line 99)
  // Negate y: the shader's gl_FragCoord.y increases upward, but world-space y
  // increases downward, so we flip to match the background's color mapping.
  const theta = Math.atan2(-y, x)
  const hue = PI * 8 / 12 - theta

  // OkLCh base values — brighter/more saturated than the background's 0.51/0.06
  // so the border is visible against dark card backgrounds.
  const L = 0.75 * boost
  const C = 0.15 * boost

  // OkLCh → linear RGB
  const [lr, lg, lb] = oklch2linearRGB(L, C, hue)

  // Linear → sRGB
  const sr = linearToSRGB(clamp01(lr))
  const sg = linearToSRGB(clamp01(lg))
  const sb = linearToSRGB(clamp01(lb))

  // Apply W3C soft-light blend with white (source = 1.0) per channel
  const r = softLightChannel(sr, 1.0)
  const g = softLightChannel(sg, 1.0)
  const b = softLightChannel(sb, 1.0)

  return `#${toHex(r)}${toHex(g)}${toHex(b)}`
}

// --- OkLCh → hex (no soft-light, used for node theme colors) ---
function oklchToHex(L: number, C: number, hue: number): string {
  const [lr, lg, lb] = oklch2linearRGB(L, C, hue)
  return `#${toHex(linearToSRGB(clamp01(lr)))}${toHex(linearToSRGB(clamp01(lg)))}${toHex(linearToSRGB(clamp01(lb)))}`
}

const presetCache = new Map<string, ColorPreset>()
const WARM_HUE = 80 * PI / 180 // fixed amber hue for markdownHighlight

/**
 * Generate a full ColorPreset from a node's world-space position.
 * Hue follows the canvas background's radial rainbow. OKLCH parameters
 * match the design language of the 7 hand-tuned chromatic presets.
 *
 * Positions are quantized to a 50px grid so dragging doesn't churn objects.
 */
export function angleColorPreset(x: number, y: number): ColorPreset {
  const qx = Math.round(x / 50) * 50
  const qy = Math.round(y / 50) * 50
  const key = `${qx},${qy}`
  const cached = presetCache.get(key)
  if (cached) return cached

  const theta = Math.atan2(-qy, qx)
  const hue = PI * 8 / 12 - theta

  const preset: ColorPreset = {
    id: '__dynamic__',
    label: 'Dynamic',
    titleBarBg:        oklchToHex(0.78, 0.16, hue),
    titleBarFg:        '#1a1a1a',
    terminalBg:        oklchToHex(0.20, 0.03, hue),
    markdownFg:        oklchToHex(0.86, 0.04, hue),
    markdownAccent:    oklchToHex(0.74, 0.11, hue),
    markdownHighlight: oklchToHex(0.88, 0.06, WARM_HUE),
  }
  presetCache.set(key, preset)
  return preset
}
