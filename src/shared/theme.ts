/** Catppuccin Mocha ANSI palette — indices 0-7 normal, 8-15 bright */
export const ANSI_COLORS: readonly string[] = [
  '#45475a', '#f38ba8', '#a6e3a1', '#f9e2af', '#89b4fa', '#f5c2e7', '#94e2d5', '#bac2de',
  '#585b70', '#f38ba8', '#a6e3a1', '#f9e2af', '#89b4fa', '#f5c2e7', '#94e2d5', '#a6adc8'
]

export const DEFAULT_FG = '#cdd6f4'
export const DEFAULT_BG = '#1e1e2e'

/** xterm 6×6×6 color cube channel steps for palette indices 16-231 */
export const CUBE_STEPS: readonly number[] = [0x00, 0x5f, 0x87, 0xaf, 0xd7, 0xff]

/** xterm.js theme object for the live Terminal instance */
export const XTERM_THEME = {
  foreground: DEFAULT_FG,
  cursor: '#f5e0dc',
  selectionBackground: '#585b70',
  black: ANSI_COLORS[0],
  red: ANSI_COLORS[1],
  green: ANSI_COLORS[2],
  yellow: ANSI_COLORS[3],
  blue: ANSI_COLORS[4],
  magenta: ANSI_COLORS[5],
  cyan: ANSI_COLORS[6],
  white: ANSI_COLORS[7],
  brightBlack: ANSI_COLORS[8],
  brightRed: ANSI_COLORS[9],
  brightGreen: ANSI_COLORS[10],
  brightYellow: ANSI_COLORS[11],
  brightBlue: ANSI_COLORS[12],
  brightMagenta: ANSI_COLORS[13],
  brightCyan: ANSI_COLORS[14],
  brightWhite: ANSI_COLORS[15],
} as const
