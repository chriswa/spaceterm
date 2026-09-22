import { CARD_AGENT_MARK_HEIGHT, TITLE_CHAR_WIDTH, TITLE_H_PADDING, TITLE_HEIGHT, TITLE_LINE_HEIGHT } from './constants'
import { formatCountdownShort, formatElapsedShort } from './elapsed-label'
import { formatTokensShort } from './token-count'
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
 * Two thirds for an agent surface's label, so the two read as different kinds
 * of thing at a glance: a title node is a heading someone placed on the canvas,
 * a label is a caption the canvas derived. Both are bold Menlo at label scale,
 * and size is what tells them apart. A live prompt-cache countdown borrows this
 * size too — see `layOutStatusLabel` for why that one is drawn to be read from
 * a distance where the age below a quiet card is not.
 *
 * A markdown node's label is half that again. A document's h1 is a heading
 * inside something you can already read, where an agent surface's label is the
 * only name that surface shows from a distance — so the document's caption
 * steps back a size.
 *
 * The factor travels on the laid-out label and reaches the stylesheet as
 * `--node-label-text-scale`, so the box measured here and the text drawn into
 * it cannot disagree about it.
 */
export const LABEL_TEXT_SCALE = 2 / 3
export const MARKDOWN_LABEL_TEXT_SCALE = LABEL_TEXT_SCALE / 2

/** The text scale a node's label is drawn at. */
export function labelTextScale(node: NodeData): number {
  return node.type === 'markdown' ? MARKDOWN_LABEL_TEXT_SCALE : LABEL_TEXT_SCALE
}

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


/** World-space footprint of a label drawn as `lines` at text scale `scale`. */
export function labelBox(
  lines: readonly string[],
  scale: number = LABEL_TEXT_SCALE
): { width: number; height: number } {
  const longest = lines.reduce((max, line) => Math.max(max, line.length), 0)
  const lineCount = Math.max(1, lines.length)
  return {
    width: (longest * TITLE_CHAR_WIDTH + TITLE_H_PADDING) * scale,
    height: (TITLE_HEIGHT + (lineCount - 1) * TITLE_LINE_HEIGHT) * scale
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
 *
 * Scored at the default text scale whatever size the label is drawn at: the
 * whole box scales uniformly, so every candidate's area scales by the same
 * factor and the winner does not change.
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

/**
 * Which caption this is. A node can supply one of each, so this is half of a
 * label's identity — the other half is `nodeId`, and neither is unique alone.
 */
export type NodeLabelKind = 'name' | 'status'

/** A laid-out label, ready to draw. */
export interface NodeLabel {
  kind: NodeLabelKind
  /** The node that supplies the label — clicking it navigates relative to this. */
  nodeId: NodeId
  lines: string[]
  /** Text size relative to a title node — see `labelTextScale`. */
  textScale: number
  /** Centre of the label, directly above the node's card. */
  x: number
  y: number
  width: number
  height: number
  /**
   * Centre of the card this captions.
   *
   * Carried on the label because it is the point every edge running into that
   * node converges on, which is what `labelMaskShape` needs and what makes the
   * mask hold together. See there for why.
   */
  anchorX: number
  anchorY: number
}

/**
 * The area around a label that has to be cleared of edges: its own box, bridged
 * to the centre of the card it names.
 *
 * Masking the box alone leaves whatever edge ran through the gap below it as a
 * stub stranded between the label and the card. Stretching the box down to the
 * card does not fix that either, and on a label wider than its card it invents
 * a worse artefact: an edge arriving at a shallow angle passes under one of the
 * box's lower corners, vanishes there, and reappears in the open before it
 * reaches the card.
 *
 * Bridging instead of stretching is what makes it hold. Every edge into a node
 * ends at that node's centre, so consider any straight line to it that crosses
 * the label box: the line can only leave the box through the edge facing the
 * centre — leaving through a side would mean re-entering immediately — and from
 * there to the centre it is inside the triangle spanned by that edge and the
 * centre. Both regions are in the hull, so the line is covered continuously
 * from wherever it entered the label right through to the card.
 */
export function labelMaskShape(label: NodeLabel): {
  x: number
  y: number
  width: number
  height: number
  bridgeTo: { x: number; y: number }
} {
  return {
    x: label.x,
    y: label.y,
    width: label.width,
    height: label.height,
    bridgeTo: { x: label.anchorX, y: label.anchorY }
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
  const textScale = labelTextScale(node)
  const box = labelBox(lines, textScale)
  return {
    kind: 'name',
    nodeId: node.id,
    lines,
    textScale,
    x: node.x,
    y: node.y - measureCard(node).height / 2 - LABEL_CARD_GAP - box.height / 2,
    anchorX: node.x,
    anchorY: node.y,
    ...box
  }
}

/**
 * Air between the bottom edge of a card and the elapsed caption's line of text.
 *
 * Half a line, measured to the text rather than to the label's box, which is
 * why this is not simply `TITLE_LINE_HEIGHT * scale / 2`. A one-line label box
 * is `TITLE_HEIGHT` tall but its line of type is only `TITLE_LINE_HEIGHT`, and
 * the difference is split above and below by the flex centring — so the box
 * already supplies some of the gap, and the geometric offset has to give back
 * exactly that much or the caption sits a whole line low.
 *
 * Much tighter than `LABEL_CARD_GAP`, deliberately. That gap clears the agent
 * mark overhanging the top of a card; there is no artwork under a card, and
 * this caption is a reading of the card rather than a caption floating near it,
 * so it wants to sit close enough to be read as part of it.
 */
export function statusCardGap(scale: number): number {
  return (TITLE_LINE_HEIGHT - TITLE_HEIGHT / 2) * scale
}

/**
 * Lay out the status caption under an agent surface's card.
 *
 * Below rather than above because the name is already above: the two captions
 * answer different questions — which surface is this, and is it still moving —
 * and stacking them would make the second look like a second line of the first.
 *
 * One caption, two readings, and which one it shows is which one is worth
 * having. While the prompt cache is warm it counts that down and says how much
 * context is riding on it — `22s (185k)` — and says nothing about age, because
 * the deadline is the thing with a decision attached: go back now and that
 * context is still cheap. The two halves answer the halves of that decision,
 * urgency and stake, and neither ranks surfaces on its own — 22 seconds on a
 * 20k session is not worth crossing the room for. Once the cache is cold the
 * decision is gone, and what is left to know is how long ago this was —
 * `14m cold`.
 *
 * Neither reading is labelled beyond that word. A countdown needs no name on
 * it: it is set in the larger of the two sizes, it carries a token count no age
 * ever does, and the only other thing a caption can say is `cold`. Spelling out
 * what the big number measures would spend a third of the line telling the
 * reader what its absence from the other case already tells them.
 *
 * The size is dropped when the agent does not report one, and a deadline the
 * server could only estimate is marked `4m?`. Cursor is both cases at once:
 * it reports no token counts, and will not say which provider served a request,
 * so its lifetime is a floor across all of them rather than a reading. The
 * question mark is what keeps its cards from being compared against Claude's as
 * though the two numbers were equally good.
 *
 * The countdown is drawn at the name caption's size and the age at the canvas's
 * smallest, so the two are told apart before either is read: a card counting
 * down is legible from across the canvas, and a row of quiet ones stays quiet.
 * That difference is also what lets the countdown go unlabelled.
 * Both are one line — `labelBox` measures the longest line, and neither string
 * is long enough to want wrapping.
 *
 * The age reads `lastAgentActivityAt` and not `lastInteractedAt`, which is the
 * whole point of that field existing: the latter also advances on the human's
 * keystrokes, so typing into a stalled surface would reset its caption to `0m`
 * and make it look alive. This caption is a reading of the agent.
 *
 * Returns `null` for a non-agent surface, and for one nothing is known about —
 * no transcript, no hooks. A surface with a past acquires its timestamp when
 * the server backfills its transcript at startup, so nothing known means
 * nothing has been said yet, and no caption beats an invented number.
 */
export function layOutStatusLabel(node: NodeData, now: number): NodeLabel | null {
  if (node.type !== 'terminal') return null

  const warmFor = node.cacheWarmUntil === undefined ? 0 : node.cacheWarmUntil - now
  const since = node.lastAgentActivityAt

  let text: string
  let textScale: number
  if (warmFor > 0) {
    const size = node.cacheWarmTokens
    const countdown = `${formatCountdownShort(warmFor)}${node.cacheWarmEstimated ? '?' : ''}`
    text = size === undefined ? countdown : `${countdown} (${formatTokensShort(size)})`
    textScale = LABEL_TEXT_SCALE
  } else if (since !== undefined) {
    text = `${formatElapsedShort(now - since)} cold`
    textScale = MARKDOWN_LABEL_TEXT_SCALE
  } else {
    return null
  }

  const lines = [text]
  const box = labelBox(lines, textScale)
  return {
    kind: 'status',
    nodeId: node.id,
    lines,
    textScale,
    x: node.x,
    y: node.y + measureCard(node).height / 2 + statusCardGap(textScale) + box.height / 2,
    anchorX: node.x,
    anchorY: node.y,
    ...box
  }
}
