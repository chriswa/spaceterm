export interface ColorPreset {
  id: string
  label: string
  titleBarBg: string   // bright — title bar background
  titleBarFg: string   // off-black — title bar text
  terminalBg: string   // dark tinted — xterm background
}

// 7 chromatic presets: equidistant hues in OKLCH (perceptually uniform),
// rotated to start at 25° (true red). Per-hue lightness rides each color's
// natural peak — yellow-adjacent hues are brighter, blue is darker.
// terminalBg: OKLCH(0.20, 0.03, h) for all hues
export const COLOR_PRESETS: ColorPreset[] = [
  { id: 'default', label: 'Default', titleBarBg: '#ffffff', titleBarFg: '#1a1a1a', terminalBg: '#1e1e2e' },
  { id: 'red',     label: 'Red',     titleBarBg: '#ff4c4d', titleBarFg: '#1a1a1a', terminalBg: '#22100f' },
  { id: 'orange',  label: 'Orange',  titleBarBg: '#ef9e00', titleBarFg: '#1a1a1a', terminalBg: '#1e1406' },
  { id: 'green',   label: 'Green',   titleBarBg: '#85c100', titleBarFg: '#1a1a1a', terminalBg: '#121909' },
  { id: 'teal',    label: 'Teal',    titleBarBg: '#00c0a8', titleBarFg: '#1a1a1a', terminalBg: '#041a16' },
  { id: 'blue',    label: 'Blue',    titleBarBg: '#00a1e6', titleBarFg: '#1a1a1a', terminalBg: '#061821' },
  { id: 'violet',  label: 'Violet',  titleBarBg: '#857aff', titleBarFg: '#1a1a1a', terminalBg: '#141423' },
  { id: 'pink',    label: 'Pink',    titleBarBg: '#de5fca', titleBarFg: '#1a1a1a', terminalBg: '#1e111c' },
]

export const COLOR_PRESET_MAP: Record<string, ColorPreset> = Object.fromEntries(
  COLOR_PRESETS.map((p) => [p.id, p])
)

export const DEFAULT_PRESET = COLOR_PRESETS[0]
