export interface ColorPreset {
  id: string
  label: string
  titleBarBg: string      // bright — title bar background
  titleBarFg: string      // off-black — title bar text
  terminalBg: string      // dark tinted — xterm background
  markdownFg: string      // light pastel — markdown body text
  markdownAccent: string  // mid-sat — markdown headings, links, bold, list markers
  markdownHighlight: string // warm contrasting — markdown italic, emphasis
}

// 7 chromatic presets: equidistant hues in OKLCH (perceptually uniform),
// rotated to start at 25° (true red). Per-hue lightness rides each color's
// natural peak — yellow-adjacent hues are brighter, blue is darker.
// terminalBg: OKLCH(0.20, 0.03, h) for all hues
// markdownFg: very light pastel tint (~L0.86, C0.04) per hue
// markdownAccent: mid-lightness vivid (~L0.74, C0.11) per hue
// markdownHighlight: warm contrasting tone per hue
export const COLOR_PRESETS: ColorPreset[] = [
  { id: 'default', label: 'Default', titleBarBg: '#ffffff', titleBarFg: '#1a1a1a', terminalBg: '#1e1e2e', markdownFg: '#cdd6f4', markdownAccent: '#4d9eff', markdownHighlight: '#ffc94d' },
  { id: 'red',     label: 'Red',     titleBarBg: '#FF8181', titleBarFg: '#1a1a1a', terminalBg: '#22100f', markdownFg: '#f0c8c4', markdownAccent: '#e88878', markdownHighlight: '#f0d0a8' },
  { id: 'orange',  label: 'Orange',  titleBarBg: '#F7B954', titleBarFg: '#1a1a1a', terminalBg: '#1e1406', markdownFg: '#ecd8c0', markdownAccent: '#d8a050', markdownHighlight: '#f0e8a0' },
  { id: 'green',   label: 'Green',   titleBarBg: '#A5D550', titleBarFg: '#1a1a1a', terminalBg: '#121909', markdownFg: '#c4dcb0', markdownAccent: '#88c058', markdownHighlight: '#e8e0a8' },
  { id: 'teal',    label: 'Teal',    titleBarBg: '#50D4BE', titleBarFg: '#1a1a1a', terminalBg: '#041a16', markdownFg: '#b4dcd0', markdownAccent: '#50c0a8', markdownHighlight: '#e8d8a8' },
  { id: 'blue',    label: 'Blue',    titleBarBg: '#54B9EB', titleBarFg: '#1a1a1a', terminalBg: '#061821', markdownFg: '#b8d0ec', markdownAccent: '#60a8e0', markdownHighlight: '#e8d8b0' },
  { id: 'violet',  label: 'Violet',  titleBarBg: '#A799FC', titleBarFg: '#1a1a1a', terminalBg: '#141423', markdownFg: '#ccc4ec', markdownAccent: '#9488d8', markdownHighlight: '#e8d0b8' },
  { id: 'pink',    label: 'Pink',    titleBarBg: '#E788D3', titleBarFg: '#1a1a1a', terminalBg: '#1e111c', markdownFg: '#e4c0d8', markdownAccent: '#d068b8', markdownHighlight: '#e8d8b0' },
]

export const COLOR_PRESET_MAP: Record<string, ColorPreset> = Object.fromEntries(
  COLOR_PRESETS.map((p) => [p.id, p])
)

export const DEFAULT_PRESET = COLOR_PRESETS[0]

const dimCache = new Map<string, string>()

/**
 * Dim a '#rrggbb' hex color by pulling each channel toward black (0).
 * `amount` is the fraction to dim by (0–1).
 * E.g. amount = 0.10 moves each channel 10% closer to 0.
 */
export function dimHex(hex: string, amount: number): string {
  const key = hex + amount
  const cached = dimCache.get(key)
  if (cached) return cached

  const scale = 1 - amount
  const r = Math.round(parseInt(hex.slice(1, 3), 16) * scale)
  const g = Math.round(parseInt(hex.slice(3, 5), 16) * scale)
  const b = Math.round(parseInt(hex.slice(5, 7), 16) * scale)

  const result = `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`
  dimCache.set(key, result)
  return result
}

/** Blend `fg` over `bg` at the given alpha (0–1). All values are '#rrggbb' hex strings. */
export function blendHex(fg: string, bg: string, alpha: number): string {
  const fr = parseInt(fg.slice(1, 3), 16)
  const fg2 = parseInt(fg.slice(3, 5), 16)
  const fb = parseInt(fg.slice(5, 7), 16)
  const br = parseInt(bg.slice(1, 3), 16)
  const bg2 = parseInt(bg.slice(3, 5), 16)
  const bb = parseInt(bg.slice(5, 7), 16)
  const r = Math.round(fr * alpha + br * (1 - alpha))
  const g = Math.round(fg2 * alpha + bg2 * (1 - alpha))
  const b = Math.round(fb * alpha + bb * (1 - alpha))
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`
}
