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
export const CHROME_H_NO_FOOTER =
  CARD_BORDER * 2 +
  HEADER_PADDING_V * 2 + HEADER_CONTENT_H + HEADER_BORDER_BOTTOM +
  BODY_PADDING_TOP
export const CHROME_H = CHROME_H_NO_FOOTER + FOOTER_HEIGHT

export const ROOT_NODE_RADIUS = 150

// Markdown node dimensions
export const MARKDOWN_DEFAULT_WIDTH = 400
export const MARKDOWN_DEFAULT_HEIGHT = 300
export const MARKDOWN_MIN_WIDTH = 200
export const MARKDOWN_MIN_HEIGHT = 88
export const MARKDOWN_DEFAULT_MAX_WIDTH = 600
export const MARKDOWN_MIN_MAX_WIDTH = 100

// Directory node dimensions
export const DIRECTORY_WIDTH = 300
export const DIRECTORY_HEIGHT = 144
export const DIR_CWD_CHAR_WIDTH = CELL_WIDTH * (44 / 14)   // Menlo 44px bold
export const DIR_GIT_CHAR_WIDTH = CELL_WIDTH * (11 / 14)   // Menlo 11px
export const DIR_FOLDER_H_PADDING = 80
export const DIR_MIN_FOLDER_WIDTH = 180

// File node dimensions
export const FILE_WIDTH = 300
export const FILE_HEIGHT = 144

// Title node dimensions
export const TITLE_DEFAULT_WIDTH = 600
export const TITLE_HEIGHT = 120
export const TITLE_LINE_HEIGHT = 80    // 66px font + 14px leading
export const TITLE_CHAR_WIDTH = 39.75  // Menlo 66px bold (CELL_WIDTH * 66/14)
export const TITLE_H_PADDING = 72      // 36px padding on each side
export const TITLE_MIN_WIDTH = 360

// Image node dimensions
export const IMAGE_DEFAULT_WIDTH = 300
export const IMAGE_DEFAULT_HEIGHT = 200

// Placement
export const PLACEMENT_MARGIN = 80

export function terminalPixelSize(cols: number, rows: number, hasFooter = true): { width: number; height: number } {
  return {
    width: Math.ceil(cols * CELL_WIDTH + CHROME_W),
    height: Math.ceil(rows * CELL_HEIGHT + (hasFooter ? CHROME_H : CHROME_H_NO_FOOTER))
  }
}

export type NodeLike =
  | { type: 'terminal'; cols: number; rows: number }
  | { type: 'directory'; cwd: string; gitStatus?: { branch: string | null; ahead: number; behind: number; staged: number; unstaged: number; untracked: number; conflicts: number } | null }
  | { type: 'file' }
  | { type: 'title'; text: string }
  | { type: 'markdown'; width: number; height: number }
  | { type: 'image'; width?: number; height?: number }

/** Compute the auto-scaled folder width for a directory node from its text content. */
export function directoryFolderWidth(cwd: string, gitStatus?: { branch: string | null; ahead: number; behind: number; staged: number; unstaged: number; untracked: number; conflicts: number } | null): number {
  const cwdWidth = cwd.length * DIR_CWD_CHAR_WIDTH

  let gitWidth = 0
  if (gitStatus === null) {
    gitWidth = 'not git controlled'.length * DIR_GIT_CHAR_WIDTH
  } else if (gitStatus) {
    // Mirror formatGitStatus: "branch ⇡N ⇣N +N !N ?N =N (XXm old)"
    const parts: string[] = [gitStatus.branch ?? 'detached']
    if (gitStatus.ahead > 0) parts.push(`x${gitStatus.ahead}`)    // ⇡ = 1 char in monospace
    if (gitStatus.behind > 0) parts.push(`x${gitStatus.behind}`)
    if (gitStatus.staged > 0) parts.push(`+${gitStatus.staged}`)
    if (gitStatus.unstaged > 0) parts.push(`!${gitStatus.unstaged}`)
    if (gitStatus.untracked > 0) parts.push(`?${gitStatus.untracked}`)
    if (gitStatus.conflicts > 0) parts.push(`=${gitStatus.conflicts}`)
    // Fetch age: worst case is "(never fetched)" = 15 chars
    const totalLen = parts.join(' ').length + 1 + 15
    gitWidth = totalLen * DIR_GIT_CHAR_WIDTH
  }

  return Math.max(DIR_MIN_FOLDER_WIDTH, Math.max(cwdWidth, gitWidth) + DIR_FOLDER_H_PADDING)
}

export function nodePixelSize(node: NodeLike): { width: number; height: number } {
  if (node.type === 'terminal') {
    return terminalPixelSize(node.cols, node.rows)
  }
  if (node.type === 'directory') {
    return { width: directoryFolderWidth(node.cwd, node.gitStatus), height: DIRECTORY_HEIGHT }
  }
  if (node.type === 'file') {
    return { width: FILE_WIDTH, height: FILE_HEIGHT }
  }
  if (node.type === 'title') {
    const lines = node.text ? node.text.split('\n') : ['']
    const lineCount = lines.length
    const longestLen = Math.max(...lines.map(l => l.length), 0)
    const width = Math.max(TITLE_MIN_WIDTH, longestLen * TITLE_CHAR_WIDTH + TITLE_H_PADDING)
    const height = TITLE_HEIGHT + (lineCount - 1) * TITLE_LINE_HEIGHT
    return { width, height }
  }
  if (node.type === 'image') {
    return { width: node.width ?? IMAGE_DEFAULT_WIDTH, height: node.height ?? IMAGE_DEFAULT_HEIGHT }
  }
  return { width: node.width, height: node.height }
}
