export const DEFAULT_COLS = 80
export const DEFAULT_ROWS = 24
export const GRID_GAP = 40
export const GRID_COLS = 3

export const MIN_ZOOM = 0.05
export const MAX_ZOOM = 1.25
export const UNFOCUSED_MAX_ZOOM = 1.0
export const UNFOCUS_SNAP_ZOOM = 0.5
export const ZOOM_SENSITIVITY = 0.004

// Exponential smoothing speeds: higher = snappier.
// 95% of the gap is covered in ~3/speed seconds.
// FOCUS_SPEED=10 → ~300ms to 95%. UNFOCUS_SPEED=6 → ~500ms to 95%.
export const FOCUS_SPEED = 10
export const UNFOCUS_SPEED = 6

export const WHEEL_WINDOW_MS = 150              // accumulation window for gesture detection
export const HORIZONTAL_SCROLL_THRESHOLD = 15   // min accumulated |deltaX| in pixels over WHEEL_WINDOW_MS
export const PINCH_ZOOM_THRESHOLD = 2           // min |deltaY| per event with ctrlKey

// xterm.js cell pixel dimensions for Menlo 14px.
// Measured via: (term as any)._core._renderService.dimensions.css.cell
// Slightly overestimated to avoid single-character wrapping; check console logs to calibrate.
export const CELL_WIDTH = 8.4375
export const CELL_HEIGHT = 16

// Card chrome (borders + header + body padding + footer) around the terminal area.
// Horizontal: 2px border × 2 + 2px body padding × 2 + 8px scrollbar gutter = 16px
// Vertical: 2px border × 2 + 28px header + 1px header border-bottom + 2px body padding-top + 1px footer border-top + 4px footer padding + 16px footer line = 56px
export const CHROME_W = 16
export const CHROME_H = 56

export const CHILD_PLACEMENT_DISTANCE = 1250
export const ROOT_NODE_RADIUS = 150

// Markdown node dimensions
export const MARKDOWN_DEFAULT_WIDTH = 200
export const MARKDOWN_DEFAULT_HEIGHT = 60
export const MARKDOWN_MIN_WIDTH = 200
export const MARKDOWN_MIN_HEIGHT = 60

// Remnant node dimensions (dead terminal placeholder)
// Width matches default 80-col terminal for visual consistency
export const REMNANT_WIDTH = Math.ceil(DEFAULT_COLS * CELL_WIDTH + CHROME_W)
export const REMNANT_HEIGHT = 90

// Archive body sizing
export const ARCHIVE_BODY_MIN_WIDTH = 380
export const ARCHIVE_BODY_MAX_WIDTH = 500

// Force-directed layout
export const FORCE_REPULSION_STRENGTH = 2.0
export const FORCE_ATTRACTION_STRENGTH = 0.3
export const FORCE_PADDING = 80
export const FORCE_DEFAULT_SPEED = 20
export const FORCE_MIN_SPEED = 5
export const FORCE_MAX_SPEED = 640

export function terminalPixelSize(cols: number, rows: number): { width: number; height: number } {
  return {
    width: Math.ceil(cols * CELL_WIDTH + CHROME_W),
    height: Math.ceil(rows * CELL_HEIGHT + CHROME_H)
  }
}
