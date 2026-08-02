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

export const ROOT_NODE_RADIUS = 90

// Markdown node dimensions
export const MARKDOWN_DEFAULT_WIDTH = 400
export const MARKDOWN_DEFAULT_HEIGHT = 300
export const MARKDOWN_MIN_WIDTH = 200
export const MARKDOWN_MIN_HEIGHT = 88
export const MARKDOWN_DEFAULT_MAX_WIDTH = 600
export const MARKDOWN_MIN_MAX_WIDTH = 100

/**
 * Directory and title nodes are label-scale objects: they exist to mark a
 * region of the canvas legibly, not to be read up close. They used to grow as
 * you zoomed out, via a `--zoom-boost` CSS transform capped at 6.75×. A
 * transform is invisible to layout, so their world footprint disagreed with
 * the constants below — placement, camera-fit, snap guides and drag-select all
 * measured something other than what was drawn, and the disagreement varied
 * with the camera. The boost is gone, replaced by the fixed factor below —
 * chosen by eye, not derived from anything — applied here where measureCard()
 * can see it rather than in a transform that layout cannot.
 *
 * The base values below are the pre-scale numbers, kept visible because they
 * document intent (font sizes, leading, padding). The matching CSS multiplies
 * the same base values by `--label-node-scale` on :root, which must equal this.
 */
export const LABEL_NODE_SCALE = 5

// Directory node dimensions
export const DIRECTORY_WIDTH = 300 * LABEL_NODE_SCALE
export const DIRECTORY_HEIGHT = 144 * LABEL_NODE_SCALE
/** Native height of the folder artwork's coordinate space, before scaling. */
export const DIR_FOLDER_ART_HEIGHT = 144
export const DIR_CWD_CHAR_WIDTH = CELL_WIDTH * (44 / 14) * LABEL_NODE_SCALE   // Menlo 44px bold
export const DIR_GIT_CHAR_WIDTH = CELL_WIDTH * (11 / 14) * LABEL_NODE_SCALE   // Menlo 11px
export const DIR_FOLDER_H_PADDING = 80 * LABEL_NODE_SCALE
export const DIR_MIN_FOLDER_WIDTH = 180 * LABEL_NODE_SCALE

// File node dimensions
export const FILE_WIDTH = 300
export const FILE_HEIGHT = 144

// Title node dimensions — see LABEL_NODE_SCALE above.
export const TITLE_DEFAULT_WIDTH = 600 * LABEL_NODE_SCALE
export const TITLE_HEIGHT = 120 * LABEL_NODE_SCALE
export const TITLE_LINE_HEIGHT = 80 * LABEL_NODE_SCALE                      // 66px font + 14px leading
export const TITLE_CHAR_WIDTH = CELL_WIDTH * (66 / 14) * LABEL_NODE_SCALE   // Menlo 66px bold
export const TITLE_H_PADDING = 72 * LABEL_NODE_SCALE                        // 36px padding on each side
export const TITLE_MIN_WIDTH = 360 * LABEL_NODE_SCALE

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

// The pixel footprint of a card is computed in card-types.ts, which imports
// the constants above. Deliberately not re-exported from here: card-types
// already depends on this module, and a re-export would close the cycle — the
// constants would then be in their temporal dead zone while card-types
// evaluated its module-level default sizes.
