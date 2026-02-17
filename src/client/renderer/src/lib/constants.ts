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
  DIRECTORY_WIDTH,
  DIRECTORY_HEIGHT,
  FILE_WIDTH,
  FILE_HEIGHT,
  TITLE_DEFAULT_WIDTH,
  TITLE_HEIGHT,
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

export const MIN_ZOOM = 0.05
export const MAX_ZOOM = 1.25
export const UNFOCUSED_MAX_ZOOM = 1.0
export const UNFOCUS_SNAP_ZOOM = 0.5
export const ZOOM_SENSITIVITY = 0.004
export const ZOOM_RUBBER_BAND_HIGH = 0.08
export const ZOOM_RUBBER_BAND_LOW = 0.02
export const ZOOM_SNAP_BACK_SPEED = 15
export const ZOOM_SNAP_BACK_DELAY = 150

export const FOCUS_SPEED = 10
export const UNFOCUS_SPEED = 6

export const WHEEL_DECAY_MS = 80
export const HORIZONTAL_SCROLL_THRESHOLD = 15
export const PINCH_ZOOM_THRESHOLD = 2

export const CHILD_PLACEMENT_DISTANCE = 1250

// Archive body sizing
export const ARCHIVE_BODY_MIN_WIDTH = 380
export const ARCHIVE_BODY_MAX_WIDTH = 500
export const ARCHIVE_POPUP_MAX_HEIGHT = 310

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
