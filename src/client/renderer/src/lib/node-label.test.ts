import { describe, it, expect } from 'vitest'
import {
  nodeLabelText, wrapLabel, labelBox, labelMaskShape, layOutNodeLabel, LABEL_CARD_GAP, MAX_LABEL_LINES
} from './node-label'
import { measureCard } from '../../../../shared/card-types'
import type { MarkdownNodeData, NodeData, TerminalNodeData } from '../../../../shared/state'
import { asNodeId, asPtySessionId, ROOT_NODE_ID } from '../../../../shared/ids'

const base = {
  id: asNodeId('n1'),
  parentId: ROOT_NODE_ID,
  x: 0,
  y: 0,
  zIndex: 1,
  archivedChildren: []
}

function terminal(fields: Partial<TerminalNodeData> = {}): TerminalNodeData {
  return {
    ...base,
    type: 'terminal',
    alive: true,
    sessionId: asPtySessionId('n1'),
    cols: 80,
    rows: 24,
    claudeState: 'stopped',
    claudeStatusUnread: false,
    claudeStatusAsleep: false,
    sortOrder: 0,
    terminalSessions: [],
    claudeSessionHistory: [],
    shellTitleHistory: [],
    ...fields
  }
}

function markdown(fields: Partial<MarkdownNodeData> = {}): MarkdownNodeData {
  return { ...base, type: 'markdown', width: 400, height: 300, content: '', ...fields }
}

describe('nodeLabelText', () => {
  it('prefers a user-set name over anything derived', () => {
    const node = terminal({ name: 'Deploy pipeline', shellTitleHistory: ['auto title'] })
    expect(nodeLabelText(node)).toBe('Deploy pipeline')
  })

  it('falls back to the newest auto-supplied shell title', () => {
    // shellTitleHistory is unshifted, so index 0 is the most recent — the one
    // the title bar shows leftmost.
    const node = terminal({ shellTitleHistory: ['newest title', 'older title'] })
    expect(nodeLabelText(node)).toBe('newest title')
  })

  it('has no label when a terminal has neither a name nor a shell title', () => {
    expect(nodeLabelText(terminal())).toBeNull()
  })

  it('treats a whitespace-only name as unset', () => {
    const node = terminal({ name: '   ', shellTitleHistory: ['auto title'] })
    expect(nodeLabelText(node)).toBe('auto title')
  })

  it('takes a markdown document’s leading h1 as its label', () => {
    expect(nodeLabelText(markdown({ content: '# Design notes\n\nbody text' }))).toBe('Design notes')
  })

  it('skips blank lines before the heading', () => {
    expect(nodeLabelText(markdown({ content: '\n\n# Design notes\n' }))).toBe('Design notes')
  })

  it('ignores a markdown document that does not open with an h1', () => {
    expect(nodeLabelText(markdown({ content: 'just prose\n# Later heading' }))).toBeNull()
    expect(nodeLabelText(markdown({ content: '## Subsection' }))).toBeNull()
    expect(nodeLabelText(markdown({ content: '#no-space' }))).toBeNull()
  })

  it('reads file-backed markdown from the supplied content, not the node', () => {
    const node = markdown({ fileBacked: true, content: 'stale' })
    expect(nodeLabelText(node, '# From disk')).toBe('From disk')
  })

  it('has no label for node types that supply none', () => {
    const title: NodeData = { ...base, type: 'title', text: 'A title node' }
    expect(nodeLabelText(title)).toBeNull()
  })
})

/** Area of the box a given wrap would occupy — the quantity wrapLabel minimises. */
function areaOf(lines: string[]): number {
  const box = labelBox(lines)
  return box.width * box.height
}

/** Every greedy wrap of `text` into 1..MAX_LABEL_LINES lines, for comparison. */
function candidateWraps(text: string): string[][] {
  const words = text.split(/\s+/).filter((w) => w.length > 0)
  const longestWord = words.reduce((max, w) => Math.max(max, w.length), 0)
  const wraps: string[][] = []
  for (let limit = longestWord; limit <= words.join(' ').length; limit++) {
    const lines: string[] = []
    let current = ''
    for (const word of words) {
      if (current === '') current = word
      else if (current.length + 1 + word.length <= limit) current += ' ' + word
      else { lines.push(current); current = word }
    }
    if (current !== '') lines.push(current)
    if (lines.length <= MAX_LABEL_LINES) wraps.push(lines)
  }
  return wraps
}

const SAMPLES = [
  'Title',
  'Two words',
  'Deploy the staging pipeline',
  'Investigate flaky renderer tests on CI',
  'A somewhat longer surface title with quite a lot of words in it',
  'supercalifragilisticexpialidocious',
  'a b c d e f g h i j'
]

describe('wrapLabel', () => {
  it.each(SAMPLES)('never uses more than two line breaks: %s', (text) => {
    expect(wrapLabel(text).length).toBeLessThanOrEqual(MAX_LABEL_LINES)
  })

  it.each(SAMPLES)('preserves every word in order: %s', (text) => {
    expect(wrapLabel(text).join(' ').split(/\s+/)).toEqual(text.split(/\s+/))
  })

  it.each(SAMPLES)('picks the smallest area available to a greedy wrap: %s', (text) => {
    const chosen = areaOf(wrapLabel(text))
    for (const candidate of candidateWraps(text)) {
      expect(areaOf(candidate)).toBeGreaterThanOrEqual(chosen)
    }
  })

  it('keeps a word that cannot be broken on one line', () => {
    expect(wrapLabel('supercalifragilisticexpialidocious')).toEqual(['supercalifragilisticexpialidocious'])
  })

  it('collapses runs of whitespace rather than emitting empty lines', () => {
    expect(wrapLabel('  spaced   out  ').every((line) => line.trim() === line)).toBe(true)
  })

  it('has nothing to wrap when the text is blank', () => {
    expect(wrapLabel('   ')).toEqual([])
  })

  it('breaks a long title rather than drawing it as one wide ribbon', () => {
    // The horizontal padding is a fixed cost per label and the line height a
    // fixed cost per line, so narrowing genuinely wins once a title is long.
    expect(wrapLabel('A somewhat longer surface title with quite a lot of words in it').length)
      .toBeGreaterThan(1)
  })
})

describe('labelBox', () => {
  it('widens with the longest line, not the total text', () => {
    const oneLong = labelBox(['aaaaaaaaaaaa'])
    const twoShort = labelBox(['aaaaaa', 'aaaaaa'])
    expect(twoShort.width).toBeLessThan(oneLong.width)
    expect(twoShort.height).toBeGreaterThan(oneLong.height)
  })

  it('gives an empty label the height of a single line', () => {
    expect(labelBox([]).height).toBe(labelBox(['x']).height)
  })
})

/** Slack for the sits-just-above-the-card comparisons below. */
const TOUCHING = 1e-6

describe('layOutNodeLabel', () => {
  const CARDS: NodeData[] = [
    terminal({ name: 'Deploy the staging pipeline' }),
    terminal({ name: 'Short', cols: 200, rows: 60, x: 4000, y: -2500 }),
    markdown({ name: 'A somewhat longer surface title with quite a lot of words in it', x: -900, y: 700 })
  ]

  it.each(CARDS)('sits above the card, centred on it: $name', (node) => {
    const label = layOutNodeLabel(node)!
    const card = measureCard(node)
    expect(label.x).toBe(node.x)
    // The label's bottom edge stops short of the card's top edge by the gap.
    expect(label.y + label.height / 2).toBeCloseTo(node.y - card.height / 2 - LABEL_CARD_GAP)
  })

  it.each(CARDS)('never touches the card it names: $name', (node) => {
    const label = layOutNodeLabel(node)!
    const cardTop = node.y - measureCard(node).height / 2
    expect(label.y + label.height / 2).toBeLessThanOrEqual(cardTop - LABEL_CARD_GAP + TOUCHING)
  })

  it('stays above a card whose own size changed, rather than at a fixed offset', () => {
    // The offset is derived from the card, so a taller terminal pushes its
    // label further up by exactly the extra half-height.
    const short = terminal({ name: 'Same label', rows: 24 })
    const tall = terminal({ name: 'Same label', rows: 60 })
    const rise = layOutNodeLabel(short)!.y - layOutNodeLabel(tall)!.y
    expect(rise).toBeCloseTo((measureCard(tall).height - measureCard(short).height) / 2)
  })

  it('reports the node that supplies it, so a click can navigate from there', () => {
    const node = terminal({ name: 'Named' })
    expect(layOutNodeLabel(node)!.nodeId).toBe(node.id)
  })

  it('lays out nothing for a node with no label', () => {
    expect(layOutNodeLabel(terminal())).toBeNull()
  })
})


/** A point, for the mask-coverage property below. */
interface Pt { x: number; y: number }

type MaskShape = ReturnType<typeof labelMaskShape>

function inTriangle(a: Pt, b: Pt, c: Pt, p: Pt): boolean {
  const side = (p1: Pt, p2: Pt, p3: Pt) => (p1.x - p3.x) * (p2.y - p3.y) - (p2.x - p3.x) * (p1.y - p3.y)
  const d1 = side(p, a, b)
  const d2 = side(p, b, c)
  const d3 = side(p, c, a)
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0))
}

/**
 * Is `p` inside the area the mask actually paints?
 *
 * Mirrors what `CanvasBackground` emits: the rect, plus a fan of triangles from
 * the bridge point to each of the rect's four edges.
 */
function insideMask(shape: MaskShape, p: Pt): boolean {
  const l = shape.x - shape.width / 2
  const r = shape.x + shape.width / 2
  const t = shape.y - shape.height / 2
  const b = shape.y + shape.height / 2
  if (p.x >= l && p.x <= r && p.y >= t && p.y <= b) return true
  const corners: Pt[] = [{ x: l, y: t }, { x: r, y: t }, { x: r, y: b }, { x: l, y: b }]
  return corners.some((corner, i) => inTriangle(shape.bridgeTo, corner, corners[(i + 1) % 4], p))
}

describe('labelMaskShape', () => {
  it('covers the label box itself', () => {
    const label = layOutNodeLabel(terminal({ name: 'Named' }))!
    const shape = labelMaskShape(label)
    expect(shape.x).toBe(label.x)
    expect(shape.y).toBe(label.y)
    expect(shape.width).toBe(label.width)
    expect(shape.height).toBe(label.height)
  })

  it('bridges to the centre of the card, where every edge into it converges', () => {
    const node = terminal({ name: 'Named', x: 1200, y: -800 })
    expect(labelMaskShape(layOutNodeLabel(node)!).bridgeTo).toEqual({ x: 1200, y: -800 })
  })

  /**
   * The property the bridge exists for.
   *
   * A label far wider than its card, which is the case a rectangle cannot
   * cover: an edge arriving at a shallow angle used to pass under one of the
   * box's lower corners, vanish, and reappear in the open before reaching the
   * card. Once a line to the node's centre enters the mask it must stay inside
   * it the whole rest of the way.
   */
  it('never lets an edge reappear between the label and the card', () => {
    const node = terminal({ name: 'A rather long surface title', cols: 80, rows: 24, x: 0, y: 0 })
    const label = layOutNodeLabel(node)!
    const shape = labelMaskShape(label)
    // The case only bites when the label overhangs the card.
    expect(label.width).toBeGreaterThan(measureCard(node).width)

    const anchor: Pt = { x: node.x, y: node.y }
    for (let deg = 0; deg < 360; deg += 3) {
      const radians = (deg * Math.PI) / 180
      const from: Pt = { x: anchor.x + 40000 * Math.cos(radians), y: anchor.y + 40000 * Math.sin(radians) }
      let entered = false
      let reappeared = false
      const STEPS = 4000
      for (let i = 0; i <= STEPS; i++) {
        const s = i / STEPS
        const p: Pt = { x: from.x + (anchor.x - from.x) * s, y: from.y + (anchor.y - from.y) * s }
        const inside = insideMask(shape, p)
        if (inside) entered = true
        else if (entered) reappeared = true
      }
      expect(reappeared, `edge at ${deg}deg left the mask before reaching the card`).toBe(false)
    }
  })
})
