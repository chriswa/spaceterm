// Shared size constants and computation used by both client and server.

export const DEFAULT_COLS = 160
export const DEFAULT_ROWS = 45

// xterm.js cell pixel dimensions for Menlo 14px.
export const CELL_WIDTH = 8.4375
export const CELL_HEIGHT = 16

// Card chrome sub-constants — update these when CSS changes.
export const CARD_BORDER = 2
export const HEADER_PADDING_V = 6
export const HEADER_CONTENT_H = 20
export const HEADER_BORDER_BOTTOM = 1
export const BODY_PADDING_TOP = 2
export const FOOTER_HEIGHT = 20

// Horizontal: 2px border × 2 + 2px body padding × 2 + 8px scrollbar gutter = 16px
export const CHROME_W = 16
// Vertical: computed from sub-constants above
export const CHROME_H =
  CARD_BORDER * 2 +
  HEADER_PADDING_V * 2 + HEADER_CONTENT_H + HEADER_BORDER_BOTTOM +
  BODY_PADDING_TOP +
  FOOTER_HEIGHT

export const ROOT_NODE_RADIUS = 150

// Markdown node dimensions
export const MARKDOWN_DEFAULT_WIDTH = 400
export const MARKDOWN_DEFAULT_HEIGHT = 300
export const MARKDOWN_MIN_WIDTH = 200
export const MARKDOWN_MIN_HEIGHT = 60
export const MARKDOWN_DEFAULT_MAX_WIDTH = 600
export const MARKDOWN_MIN_MAX_WIDTH = 100

// Directory node dimensions
export const DIRECTORY_WIDTH = 300
export const DIRECTORY_HEIGHT = 144

// File node dimensions
export const FILE_WIDTH = 300
export const FILE_HEIGHT = 144

// Title node dimensions
export const TITLE_DEFAULT_WIDTH = 200
export const TITLE_HEIGHT = 40

// Placement
export const PLACEMENT_MARGIN = 80

export function terminalPixelSize(cols: number, rows: number): { width: number; height: number } {
  return {
    width: Math.ceil(cols * CELL_WIDTH + CHROME_W),
    height: Math.ceil(rows * CELL_HEIGHT + CHROME_H)
  }
}

export type NodeLike =
  | { type: 'terminal'; cols: number; rows: number }
  | { type: 'directory' }
  | { type: 'file' }
  | { type: 'title' }
  | { type: 'markdown'; width: number; height: number }

export function nodePixelSize(node: NodeLike): { width: number; height: number } {
  if (node.type === 'terminal') {
    return terminalPixelSize(node.cols, node.rows)
  }
  if (node.type === 'directory') {
    return { width: DIRECTORY_WIDTH, height: DIRECTORY_HEIGHT }
  }
  if (node.type === 'file') {
    return { width: FILE_WIDTH, height: FILE_HEIGHT }
  }
  if (node.type === 'title') {
    return { width: TITLE_DEFAULT_WIDTH, height: TITLE_HEIGHT }
  }
  return { width: node.width, height: node.height }
}
