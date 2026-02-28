/**
 * Resolve xterm IBufferCell color attributes to hex strings.
 * Shared by the server snapshot-manager and the client proportional overlay.
 */
import { ANSI_COLORS, DEFAULT_FG, DEFAULT_BG, CUBE_STEPS } from './theme'

/** Minimal interface matching the subset of IBufferCell used for color resolution.
 *  Works with both @xterm/xterm (client) and @xterm/headless (server). */
export interface CellColorInfo {
  getFgColor(): number
  getBgColor(): number
  isFgRGB(): boolean
  isFgPalette(): boolean
  isBgRGB(): boolean
  isBgPalette(): boolean
  isBold?(): number
}

function resolveRGB(color: number): string {
  const r = (color >> 16) & 0xFF
  const g = (color >> 8) & 0xFF
  const b = color & 0xFF
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`
}

function resolvePalette(idx: number): string | null {
  if (idx >= 0 && idx < 16) return ANSI_COLORS[idx]
  if (idx >= 16 && idx < 232) {
    const n = idx - 16
    const r = CUBE_STEPS[Math.floor(n / 36) % 6]
    const g = CUBE_STEPS[Math.floor((n % 36) / 6)]
    const b = CUBE_STEPS[n % 6]
    return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`
  }
  if (idx >= 232 && idx < 256) {
    const grey = (idx - 232) * 10 + 8
    return `#${grey.toString(16).padStart(2, '0')}${grey.toString(16).padStart(2, '0')}${grey.toString(16).padStart(2, '0')}`
  }
  return null
}

export function resolveFg(cell: CellColorInfo): string {
  try {
    const fgColor = cell.getFgColor()
    if (cell.isFgRGB()) return resolveRGB(fgColor)
    if (cell.isFgPalette()) {
      const hex = resolvePalette(fgColor)
      if (hex) return hex
    }
    if (cell.isBold && cell.isBold() && fgColor >= 0 && fgColor < 8) {
      return ANSI_COLORS[fgColor + 8]
    }
  } catch {
    // fallthrough
  }
  return DEFAULT_FG
}

export function resolveBg(cell: CellColorInfo): string {
  try {
    const bgColor = cell.getBgColor()
    if (cell.isBgRGB()) return resolveRGB(bgColor)
    if (cell.isBgPalette()) {
      const hex = resolvePalette(bgColor)
      if (hex) return hex
    }
  } catch {
    // fallthrough
  }
  return DEFAULT_BG
}
