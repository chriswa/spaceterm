// Re-export shared size constants so existing client imports keep working.
export {
  DEFAULT_COLS,
  DEFAULT_ROWS,
  CELL_WIDTH,
  CELL_HEIGHT,
  CARD_BORDER,
  HEADER_PADDING_V,
  HEADER_CONTENT_H,
  HEADER_BORDER_BOTTOM,
  BODY_PADDING_TOP,
  FOOTER_HEIGHT,
  CHROME_W,
  CHROME_H,
  ROOT_NODE_RADIUS,
  DIRECTORY_HEIGHT,
  FILE_WIDTH,
  FILE_HEIGHT,
  TITLE_DEFAULT_WIDTH,
  TITLE_HEIGHT,
  TITLE_LINE_HEIGHT,
  TITLE_CHAR_WIDTH,
  TITLE_H_PADDING,
  TITLE_MIN_WIDTH,
  MARKDOWN_MIN_WIDTH,
  MARKDOWN_MIN_HEIGHT,
  MARKDOWN_DEFAULT_MAX_WIDTH,
  MARKDOWN_MIN_MAX_WIDTH,
  terminalPixelSize
} from '../../../../shared/node-size'

// Client-only markdown size constants (resize minimums used for UI)
export const MARKDOWN_DEFAULT_WIDTH = 200
export const MARKDOWN_DEFAULT_HEIGHT = 60
export const GRID_GAP = 40
export const GRID_COLS = 3

// Absolute bounds — zoom is hard-clamped to this range everywhere.
// No code path should ever produce a zoom outside [MIN_ZOOM, MAX_ZOOM].
export const MIN_ZOOM = 0.005
export const MAX_ZOOM = 2.0

// Elastic snap-back targets — the "comfortable" range.
// Rubber-banding allows momentary overshoot beyond these toward the absolute
// bounds, then snaps back.
export const ZOOM_SNAP_LOW = 0.015
export const ZOOM_SNAP_HIGH = 1.25
export const ZOOM_SNAP_HIGH_UNFOCUSED = 1.0
export const UNFOCUS_SNAP_ZOOM = 0.5
export const ZOOM_SENSITIVITY = 0.004
export const ZOOM_RUBBER_BAND_HIGH = 0.08
export const ZOOM_RUBBER_BAND_LOW = 0.02
export const ZOOM_SNAP_BACK_SPEED = 15
export const ZOOM_SNAP_BACK_DELAY = 150

export const FOCUS_SPEED = 40
export const UNFOCUS_SPEED = 24

export const WHEEL_DECAY_MS = 80
export const HORIZONTAL_SCROLL_THRESHOLD = 15
export const PINCH_ZOOM_THRESHOLD = 2

export const CHILD_PLACEMENT_DISTANCE = 1250

// Archive body sizing
export const ARCHIVE_BODY_MIN_WIDTH = 380
export const ARCHIVE_BODY_MAX_WIDTH = 500
export const ARCHIVE_POPUP_MAX_HEIGHT = 310

// Edge hover detection
export const EDGE_HOVER_THRESHOLD_PX = 12
export const EDGE_SPLIT_NODE_MARGIN_PX = 30

// Camera history: ms after last user input before recording a "settle" position
export const CAMERA_SETTLE_DELAY = 150

// Fly-to animation scaling: duration grows linearly with canvas-space distance
export const FLY_TO_BASE_DURATION = 300
export const FLY_TO_HALF_RANGE = 9000
export const FLY_TO_MAX_DURATION = 800

// Parabolic zoom arc: controls how much the camera zooms out during hopFlyTo.
// The arc operates in log-height space (h = -ln(z)) so zoom changes are multiplicative.
export const FLY_TO_ZOOM_HALF_RANGE = 25000  // canvas px where arc reaches half of max
export const FLY_TO_ZOOM_MAX_ARC = 4.605     // -ln(0.01), asymptotic zoom floor ~1%
