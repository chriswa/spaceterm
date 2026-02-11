export const DEFAULT_COLS = 80
export const DEFAULT_ROWS = 24
export const GRID_GAP = 40
export const GRID_COLS = 3

export const MIN_ZOOM = 0.1
export const MAX_ZOOM = 3
export const ZOOM_SENSITIVITY = 0.002

// xterm.js cell pixel dimensions for Menlo 14px.
// Measured via: (term as any)._core._renderService.dimensions.css.cell
// Slightly overestimated to avoid single-character wrapping; check console logs to calibrate.
export const CELL_WIDTH = 8.4375
export const CELL_HEIGHT = 16

// Card chrome (borders + header + body padding) around the terminal area.
// Horizontal: 2px border × 2 + 2px body padding × 2 + 8px scrollbar gutter = 16px
// Vertical: 2px border × 2 + 28px header + 1px header border-bottom + 2px body padding-top = 35px
export const CHROME_W = 16
export const CHROME_H = 35

export function terminalPixelSize(cols: number, rows: number): { width: number; height: number } {
  return {
    width: Math.ceil(cols * CELL_WIDTH + CHROME_W),
    height: Math.ceil(rows * CELL_HEIGHT + CHROME_H)
  }
}
