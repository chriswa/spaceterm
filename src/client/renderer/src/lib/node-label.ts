import { CARD_AGENT_MARK_HEIGHT, TITLE_CHAR_WIDTH, TITLE_H_PADDING, TITLE_HEIGHT, TITLE_LINE_HEIGHT } from './constants'
import { measureCard } from '../../../../shared/card-types'
import type { NodeData } from '../../../../shared/state'
import type { NodeId } from '../../../../shared/ids'

/**
 * Node labels: a node's name, drawn on the canvas directly above its card.
 *
 * A label is not a node and has no card of its own — it is a caption, drawn
 * with the title node's face and size (see `.node-label` in the stylesheet,
 * which mirrors `.title-card__label`) so the canvas has one label scale rather
 * than two. Everything here is pure and measured in the same world units cards
 * are, because the box is positioned in canvas space, not screen space.
 *
 * Distinct from `node-title.ts`, which builds the string a title bar, a crab
 * tooltip or a search result shows. That one is chrome text and can be long;
 * this one is drawn on the canvas at label scale, so it is wrapped and boxed.
 */

/**
 * At most two line breaks, so a label stays a caption rather than becoming a
 * paragraph hanging off an edge.
 */
export const MAX_LABEL_LINES = 3

/**
 * The text a node captions itself with, or `null` for no label.
 *
 * Three sources, in priority order — a user-set name beats anything derived,
 * and everything derived tracks its source, so a label appears, changes and
 * disappears as the thing it names does:
 *
 *  - `name`, the title the user typed on the surface.
 *  - a terminal's newest auto-supplied shell title. `shellTitleHistory` is
 *    unshifted, so index 0 is the newest and the one the title bar shows
 *    leftmost — the same choice the server makes in `getNodeTitle`.
 *  - a markdown document's leading `# ` heading, which is a title the author
 *    wrote for the document rather than its first line of prose. Deliberately
 *    h1 only: a document that opens at `##` is opening mid-outline.
 *
 * `markdownContent` overrides `data.content`, for file-backed markdown nodes
 * whose text lives in the store's `fileContents` rather than on the node.
 */
export function nodeLabelText(data: NodeData, markdownContent?: string): string | null {
  const name = data.name?.trim()
  if (name) return name

  if (data.type === 'terminal') {
    return data.shellTitleHistory[0]?.trim() || null
  }

  if (data.type === 'markdown') {
    const content = markdownContent ?? data.content
    const firstLine = content.split('\n').find((l) => l.trim().length > 0)
    const heading = firstLine?.match(/^#[ \t]+(\S.*?)\s*$/)
    return heading ? heading[1] : null
  }

  return null
}

/**
 * How large a label is drawn relative to a title node.
 *
 * Two thirds, so the two read as different kinds of thing at a glance: a title
 * node is a heading someone placed on the canvas, a label is a caption the
 * canvas derived. Both are bold Menlo at label scale, and size is what tells
 * them apart — which means the stylesheet has to apply exactly this factor to
 * `.node-label__text`, or the measured box stops fitting the drawn text.
 */
export const LABEL_TEXT_SCALE = 2 / 3

const LABEL_CHAR_WIDTH = TITLE_CHAR_WIDTH * LABEL_TEXT_SCALE
const LABEL_LINE_HEIGHT = TITLE_LINE_HEIGHT * LABEL_TEXT_SCALE
const LABEL_H_PADDING = TITLE_H_PADDING * LABEL_TEXT_SCALE
const LABEL_SINGLE_LINE_HEIGHT = TITLE_HEIGHT * LABEL_TEXT_SCALE

/**
 * Air between the label box and the top edge of the card it names.
 *
 * A quarter of the agent mark's height. That mark is what actually occupies the
 * space above a card, so it — not the label's own type size — is what the gap
 * should be measured against: a caption spaced off it reads as belonging to the
 * card below rather than floating between two of them.
 *
 * Deliberately less than the mark's full overhang. Clearing the artwork
 * entirely pushes the label far enough away that it stops reading as attached
 * to its card, and the mark is a watermark behind the card rather than a label
 * of its own to be respected.
 */
export const LABEL_CARD_GAP = CARD_AGENT_MARK_HEIGHT / 4


/** World-space footprint of a label drawn as `lines`. */
export function labelBox(lines: readonly string[]): { width: number; height: number } {
  const longest = lines.reduce((max, line) => Math.max(max, line.length), 0)
  const lineCount = Math.max(1, lines.length)
  return {
    width: longest * LABEL_CHAR_WIDTH + LABEL_H_PADDING,
    height: LABEL_SINGLE_LINE_HEIGHT + (lineCount - 1) * LABEL_LINE_HEIGHT
  }
}

/**
 * Greedily pack `words` into lines of at most `limit` characters.
 *
 * A word longer than the limit gets a line to itself and overflows it, so this
 * never fails — the caller's binary search starts at the longest word, which
 * makes overflow unreachable from `wrapLabel`.
 */
function packLines(words: readonly string[], limit: number): string[] {
  const lines: string[] = []
  let current = ''
  for (const word of words) {
    if (current === '') {
      current = word
    } else if (current.length + 1 + word.length <= limit) {
      current += ' ' + word
    } else {
      lines.push(current)
      current = word
    }
  }
  if (current !== '') lines.push(current)
  return lines
}

/**
 * The narrowest greedy wrap of `words` that fits in `maxLines` lines.
 *
 * Binary search on the character limit rather than a full dynamic program:
 * greedy packing is monotone in the limit (a wider limit never needs more
 * lines), which is all the search needs, and the alternative would optimise a
 * raggedness metric this does not care about.
 */
function wrapInto(words: readonly string[], maxLines: number): string[] {
  let lo = words.reduce((max, w) => Math.max(max, w.length), 0)
  let hi = words.join(' ').length
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2)
    if (packLines(words, mid).length <= maxLines) hi = mid
    else lo = mid + 1
  }
  return packLines(words, lo)
}

/**
 * Break `text` into the lines that give the label the smallest area.
 *
 * Area rather than raggedness or a fixed column count, because a label competes
 * with the canvas around it for space and a long thin ribbon of text costs far
 * more of it than a compact block of the same character count. The choice is
 * not a wash: the horizontal padding is a fixed cost per label and the line
 * height is a fixed cost per line, so the two pull in opposite directions and
 * the minimum genuinely lands somewhere in between.
 *
 * Ties go to the fewest lines — `<` rather than `<=` below — so the shape only
 * changes when narrowing actually buys something.
 */
export function wrapLabel(text: string): string[] {
  const words = text.split(/\s+/).filter((w) => w.length > 0)
  if (words.length === 0) return []

  let best = [words.join(' ')]
  let bestArea = Infinity
  for (let lineCount = 1; lineCount <= MAX_LABEL_LINES; lineCount++) {
    const lines = wrapInto(words, lineCount)
    // A wrap that came out shorter than asked for is the smaller line count's
    // answer again; it has already been scored.
    if (lineCount > 1 && lines.length < lineCount) continue
    const box = labelBox(lines)
    const area = box.width * box.height
    if (area < bestArea) {
      best = lines
      bestArea = area
    }
  }
  return best
}

/** A laid-out label, ready to draw. */
export interface NodeLabel {
  /** The node that supplies the label — clicking it navigates relative to this. */
  nodeId: NodeId
  lines: string[]
  /** Centre of the label, directly above the node's card. */
  x: number
  y: number
  width: number
  height: number
}

/**
 * The area around a label that has to be cleared of edges.
 *
 * The label's own box plus the gap below it, so the mask reaches all the way to
 * the card's top edge. Masking the box alone leaves whatever edge ran through
 * the gap as a short stub stranded between the label and the card, which reads
 * as debris rather than as a line going somewhere.
 */
export function labelMaskBox(label: NodeLabel): { x: number; y: number; width: number; height: number } {
  return {
    x: label.x,
    y: label.y + LABEL_CARD_GAP / 2,
    width: label.width,
    height: label.height + LABEL_CARD_GAP
  }
}

/**
 * Lay out the label for one node. Returns `null` when it contributes none.
 *
 * Always directly above the card and centred on it, spaced off it by
 * `LABEL_CARD_GAP` — `measureCard` reports the card's layout box, and the agent
 * mark is drawn above that, so a label flush against the measured top edge sits
 * squarely on the artwork.
 *
 * Above rather than anywhere cleverer because a caption's job is to be findable
 * without being hunted for. Cards are centre-anchored, so every term here is
 * measured from the centre outwards.
 */
export function layOutNodeLabel(node: NodeData, markdownContent?: string): NodeLabel | null {
  const text = nodeLabelText(node, markdownContent)
  if (!text) return null
  const lines = wrapLabel(text)
  if (lines.length === 0) return null
  const box = labelBox(lines)
  return {
    nodeId: node.id,
    lines,
    x: node.x,
    y: node.y - measureCard(node).height / 2 - LABEL_CARD_GAP - box.height / 2,
    ...box
  }
}
