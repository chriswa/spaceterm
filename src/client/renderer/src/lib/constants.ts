export const DEFAULT_COLS = 80
export const DEFAULT_ROWS = 24
export const GRID_GAP = 40
export const GRID_COLS = 3

export const MIN_ZOOM = 0.05
export const MAX_ZOOM = 1.25
export const UNFOCUSED_MAX_ZOOM = 1.0
export const UNFOCUS_SNAP_ZOOM = 0.5
export const ZOOM_SENSITIVITY = 0.004
export const ZOOM_RUBBER_BAND_HIGH = 0.08   // max overshoot past maxZoom (asymptote)
export const ZOOM_RUBBER_BAND_LOW = 0.02    // max overshoot below MIN_ZOOM (asymptote)
export const ZOOM_SNAP_BACK_SPEED = 15      // ~200ms to 95%
export const ZOOM_SNAP_BACK_DELAY = 150     // ms after last wheel event before snap-back

// Exponential smoothing speeds: higher = snappier.
// 95% of the gap is covered in ~3/speed seconds.
// FOCUS_SPEED=10 → ~300ms to 95%. UNFOCUS_SPEED=6 → ~500ms to 95%.
export const FOCUS_SPEED = 10
export const UNFOCUS_SPEED = 6

export const WHEEL_DECAY_MS = 80                 // exponential decay time constant for gesture detection
export const HORIZONTAL_SCROLL_THRESHOLD = 15   // min accumulated |deltaX| in pixels
export const PINCH_ZOOM_THRESHOLD = 2           // min |deltaY| per event with ctrlKey

// xterm.js cell pixel dimensions for Menlo 14px.
// Measured via: (term as any)._core._renderService.dimensions.css.cell
// Slightly overestimated to avoid single-character wrapping; check console logs to calibrate.
export const CELL_WIDTH = 8.4375
export const CELL_HEIGHT = 16

// Card chrome sub-constants — update these when CSS changes.
// Terminal body gets an explicit height from CELL_HEIGHT × rows + BODY_PADDING_TOP,
// so if CHROME_H drifts the card border will visibly overflow rather than silently
// giving the terminal the wrong row count.
export const CARD_BORDER = 2
export const HEADER_PADDING_V = 6       // .card-shell__head padding top & bottom
export const HEADER_CONTENT_H = 20      // tallest child: 20px action buttons
export const HEADER_BORDER_BOTTOM = 1   // .card-shell__head border-bottom
export const BODY_PADDING_TOP = 2       // .terminal-card__body padding-top
export const FOOTER_HEIGHT = 20         // .terminal-card__footer height (border-box, includes 1px border-top)

// Horizontal: 2px border × 2 + 2px body padding × 2 + 8px scrollbar gutter = 16px
export const CHROME_W = 16
// Vertical: computed from sub-constants above
export const CHROME_H =
  CARD_BORDER * 2 +
  HEADER_PADDING_V * 2 + HEADER_CONTENT_H + HEADER_BORDER_BOTTOM +
  BODY_PADDING_TOP +
  FOOTER_HEIGHT

export const CHILD_PLACEMENT_DISTANCE = 1250
export const ROOT_NODE_RADIUS = 150

// Markdown node dimensions
export const MARKDOWN_DEFAULT_WIDTH = 200
export const MARKDOWN_DEFAULT_HEIGHT = 60
export const MARKDOWN_MIN_WIDTH = 200
export const MARKDOWN_MIN_HEIGHT = 60

// Directory node dimensions
export const DIRECTORY_WIDTH = 300
export const DIRECTORY_HEIGHT = 60

// Archive body sizing
export const ARCHIVE_BODY_MIN_WIDTH = 380
export const ARCHIVE_BODY_MAX_WIDTH = 500
export const ARCHIVE_POPUP_MAX_HEIGHT = 310  // 300 CSS max-height + border/gap

// Force-directed layout
export const FORCE_REPULSION_STRENGTH = 2.0
export const FORCE_ATTRACTION_STRENGTH = 0.3
export const FORCE_PADDING = 80
export const FORCE_DEFAULT_SPEED = 20
export const FORCE_MIN_SPEED = 5
export const FORCE_MAX_SPEED = 640

// Edge hover detection
export const EDGE_HOVER_THRESHOLD_PX = 12
export const EDGE_SPLIT_NODE_MARGIN_PX = 30

export function terminalPixelSize(cols: number, rows: number): { width: number; height: number } {
  return {
    width: Math.ceil(cols * CELL_WIDTH + CHROME_W),
    height: Math.ceil(rows * CELL_HEIGHT + CHROME_H)
  }
}
