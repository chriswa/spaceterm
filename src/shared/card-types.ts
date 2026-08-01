import { assertNever } from './exhaustive'
import {
  DIRECTORY_HEIGHT,
  FILE_WIDTH,
  FILE_HEIGHT,
  MARKDOWN_DEFAULT_WIDTH,
  MARKDOWN_DEFAULT_HEIGHT,
  TITLE_HEIGHT,
  TITLE_LINE_HEIGHT,
  TITLE_CHAR_WIDTH,
  TITLE_H_PADDING,
  TITLE_MIN_WIDTH,
  DEFAULT_COLS,
  DEFAULT_ROWS,
  terminalPixelSize,
  directoryFolderWidth,
  type NodeLike
} from './node-size'

/**
 * The kinds of card that can sit on the canvas.
 *
 * The union was previously only implicit in `NodeData`'s discriminant, so the
 * list of card types was something you reconstructed by reading five other
 * files. `MODDING.md` counts adding one as touching state.ts, protocol.ts,
 * node-size.ts, node-placement, state-manager, App.tsx's card maps and
 * AddNodeBody — this names it once and makes the size rules exhaustive.
 */
export type CardType = 'terminal' | 'markdown' | 'directory' | 'file' | 'title'

/** Every card type, in add-menu order. */
export const CARD_TYPES: readonly CardType[] = ['terminal', 'markdown', 'directory', 'file', 'title']

export function isCardType(value: unknown): value is CardType {
  return typeof value === 'string' && (CARD_TYPES as readonly string[]).includes(value)
}

export interface Size {
  width: number
  height: number
}

export interface CardTypeSpec {
  readonly type: CardType
  /** Human-readable name, for menus and log lines. */
  readonly label: string
  /**
   * Size a freshly created card of this type occupies, before it has any
   * content. Used for placement, which has to reserve space before the node
   * exists.
   */
  readonly defaultSize: Size
  /**
   * Whether the card grows to fit its content. Fixed-size cards can be placed
   * from `defaultSize` alone; sized ones must be measured.
   */
  readonly contentSized: boolean
}

export const CARD_TYPE_SPECS: Record<CardType, CardTypeSpec> = {
  terminal: {
    type: 'terminal',
    label: 'Terminal',
    defaultSize: terminalPixelSize(DEFAULT_COLS, DEFAULT_ROWS),
    contentSized: true
  },
  markdown: {
    type: 'markdown',
    label: 'Markdown',
    defaultSize: { width: MARKDOWN_DEFAULT_WIDTH, height: MARKDOWN_DEFAULT_HEIGHT },
    contentSized: false
  },
  directory: {
    type: 'directory',
    label: 'Directory',
    // Width is derived from the path and git status; only the height is fixed.
    defaultSize: { width: directoryFolderWidth(''), height: DIRECTORY_HEIGHT },
    contentSized: true
  },
  file: {
    type: 'file',
    label: 'File',
    defaultSize: { width: FILE_WIDTH, height: FILE_HEIGHT },
    contentSized: false
  },
  title: {
    type: 'title',
    label: 'Title',
    defaultSize: { width: TITLE_MIN_WIDTH, height: TITLE_HEIGHT },
    contentSized: true
  }
}

/**
 * Pixel footprint of a card, from its content.
 *
 * The `assertNever` is the point: this used to be an if-chain whose final
 * branch returned `{ width: node.width, height: node.height }` for anything
 * that fell through, so a new card type would have silently produced
 * `undefined × undefined` instead of failing to compile.
 */
export function measureCard(node: NodeLike): Size {
  switch (node.type) {
    case 'terminal':
      return terminalPixelSize(node.cols, node.rows)
    case 'directory':
      return { width: directoryFolderWidth(node.cwd, node.gitStatus), height: DIRECTORY_HEIGHT }
    case 'file':
      return { width: FILE_WIDTH, height: FILE_HEIGHT }
    case 'title': {
      const lines = node.text ? node.text.split('\n') : ['']
      const longest = Math.max(...lines.map((l) => l.length), 0)
      return {
        width: Math.max(TITLE_MIN_WIDTH, longest * TITLE_CHAR_WIDTH + TITLE_H_PADDING),
        height: TITLE_HEIGHT + (lines.length - 1) * TITLE_LINE_HEIGHT
      }
    }
    case 'markdown':
      return { width: node.width, height: node.height }
    default:
      return assertNever(node, 'measureCard')
  }
}
