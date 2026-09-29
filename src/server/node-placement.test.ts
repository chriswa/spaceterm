import { describe, expect, it } from 'vitest'
import { agentSurfaceFootprint, canFitAt, computePlacement } from './node-placement'
import { PLACEMENT_MARGIN } from '../shared/node-size'
import { measureCard as nodePixelSize } from '../shared/card-types'
import { layOutNodeLabel, layOutStatusLabel } from '../shared/node-label'
import type { NodeData, TerminalNodeData } from '../shared/state'

/**
 * Placement geometry. These assert *properties* — "the result does not overlap
 * anything", "the hint was honoured" — rather than exact coordinates, because
 * the candidate scoring is a heuristic that can legitimately be retuned. Pinning
 * coordinates would make every tweak look like a regression.
 */

const SIZE = { width: 400, height: 300 }

/** Markdown nodes are the simplest shape: their pixel size is their stored size. */
function md(id: string, x: number, y: number, parentId = 'root'): [string, NodeData] {
  return [id, { id, type: 'markdown', parentId, x, y, width: SIZE.width, height: SIZE.height, content: '' } as unknown as NodeData]
}

function nodes(...entries: Array<[string, NodeData]>): Record<string, NodeData> {
  return Object.fromEntries(entries)
}

/** True when two centre-anchored boxes are at least PLACEMENT_MARGIN apart. */
function clear(
  a: { x: number; y: number }, aSize: { width: number; height: number },
  b: { x: number; y: number }, bSize: { width: number; height: number },
): boolean {
  return (
    Math.abs(a.x - b.x) >= aSize.width / 2 + bSize.width / 2 + PLACEMENT_MARGIN ||
    Math.abs(a.y - b.y) >= aSize.height / 2 + bSize.height / 2 + PLACEMENT_MARGIN
  )
}

/** An agent surface, with whatever fields decide its captions. */
function agent(id: string, x: number, y: number, fields: Partial<TerminalNodeData> = {}): [string, NodeData] {
  return [id, {
    id, type: 'terminal', parentId: 'root', x, y, zIndex: 0, cols: 80, rows: 24,
    shellTitleHistory: [], terminalSessions: [], claudeSessionHistory: [], ...fields,
  } as unknown as NodeData]
}

/** A directory whose card is far wider than it is tall. */
function wideDir(id: string, x: number, y: number, parentId = 'root'): [string, NodeData] {
  const cwd = '/Users/someone/a/fairly/deep/project/directory/path'
  return [id, { id, type: 'directory', parentId, x, y, cwd } as unknown as NodeData]
}

function overlapsAny(
  pos: { x: number; y: number },
  map: Record<string, NodeData>,
  size: { width: number; height: number } = SIZE,
): boolean {
  return Object.values(map).some((n) => !clear(pos, size, { x: n.x, y: n.y }, nodePixelSize(n as never)))
}

describe('canFitAt', () => {
  it('accepts a position in empty space', () => {
    expect(canFitAt(nodes(), { x: 0, y: 0 }, SIZE)).toBe(true)
  })

  it('rejects a position directly on top of an existing node', () => {
    expect(canFitAt(nodes(md('a', 0, 0)), { x: 0, y: 0 }, SIZE)).toBe(false)
  })

  it('rejects a position that overlaps only partially', () => {
    expect(canFitAt(nodes(md('a', 0, 0)), { x: 100, y: 100 }, SIZE)).toBe(false)
  })

  it('rejects a position separated by less than the placement margin', () => {
    // Gap of 79px horizontally, one short of the required 80.
    expect(canFitAt(nodes(md('a', 0, 0)), { x: SIZE.width + PLACEMENT_MARGIN - 1, y: 0 }, SIZE)).toBe(false)
  })

  it('accepts a position separated by exactly the placement margin', () => {
    expect(canFitAt(nodes(md('a', 0, 0)), { x: SIZE.width + PLACEMENT_MARGIN, y: 0 }, SIZE)).toBe(true)
  })

  it('accepts a position clear on the vertical axis alone', () => {
    expect(canFitAt(nodes(md('a', 0, 0)), { x: 0, y: SIZE.height + PLACEMENT_MARGIN }, SIZE)).toBe(true)
  })

  it('checks every node, not just the first', () => {
    const map = nodes(md('a', -2000, -2000), md('b', 0, 0))
    expect(canFitAt(map, { x: 0, y: 0 }, SIZE)).toBe(false)
  })

  it('accounts for the candidate size, not just its anchor', () => {
    const map = nodes(md('a', 0, 0))
    const anchor = { x: -1500, y: 0 }
    // Narrow enough to stay entirely to the left of the node.
    expect(canFitAt(map, anchor, { width: 200, height: 300 })).toBe(true)
    // Same anchor, but wide enough to reach back across it.
    expect(canFitAt(map, anchor, { width: 3000, height: 300 })).toBe(false)
  })
})

describe('canFitAt around captions', () => {
  const NOW = 1_000_000_000
  const small = { width: 100, height: 100 }

  it('keeps clear of the name label above a card', () => {
    const map = nodes(agent('a', 0, 0, { name: 'refactor the placement heuristics' }))
    const label = layOutNodeLabel(map['a'])!
    expect(label).not.toBeNull()
    // Clear of the card itself, but sitting on its label.
    const onLabel = { x: label.x, y: label.y }
    expect(clear(onLabel, small, map['a'], nodePixelSize(map['a'] as never))).toBe(true)
    expect(canFitAt(map, onLabel, small, NOW)).toBe(false)
    // Just past the label's top edge plus the margin — by a pixel, since the
    // boundary itself is decided by floating-point rounding.
    const above = { x: label.x, y: label.y - label.height / 2 - PLACEMENT_MARGIN - small.height / 2 - 1 }
    expect(canFitAt(map, above, small, NOW)).toBe(true)
  })

  it('keeps clear of the status caption below an agent card', () => {
    const map = nodes(agent('a', 0, 0, { lastAgentActivityAt: NOW - 60_000 }))
    const label = layOutStatusLabel(map['a'], NOW)!
    expect(label).not.toBeNull()
    const onLabel = { x: label.x, y: label.y }
    expect(clear(onLabel, small, map['a'], nodePixelSize(map['a'] as never))).toBe(true)
    expect(canFitAt(map, onLabel, small, NOW)).toBe(false)
  })

  it('reserves nothing for a card without captions', () => {
    const map = nodes(agent('a', 0, 0))
    const size = nodePixelSize(map['a'] as never)
    const justAbove = { x: 0, y: -size.height / 2 - PLACEMENT_MARGIN - small.height / 2 }
    expect(canFitAt(map, justAbove, small, NOW)).toBe(true)
  })
})

describe('agent surface footprint', () => {
  const NOW = 1_000_000_000
  const footprint = agentSurfaceFootprint(80, 24)
  const [above, below] = footprint.reserved!

  it('blocks a spot where only the reserved caption space would collide', () => {
    for (const r of [above, below]) {
      // A blocker whose centre sits in the reserved box, clear of the card.
      const map = nodes(md('blocker', r.dx, r.dy))
      const blocker = nodePixelSize(map['blocker'] as never)
      expect(clear({ x: 0, y: 0 }, footprint, { x: r.dx, y: r.dy }, blocker)).toBe(true)
      expect(canFitAt(map, { x: 0, y: 0 }, { width: footprint.width, height: footprint.height }, NOW)).toBe(true)
      expect(canFitAt(map, { x: 0, y: 0 }, footprint, NOW)).toBe(false)
    }
  })

  it('keeps the reserved space clear when placed under a crowded parent', () => {
    const entries: Array<[string, NodeData]> = [md('p', 0, 0)]
    for (let i = 0; i < 6; i++) {
      const angle = (i / 6) * Math.PI * 2
      entries.push(md(`s${i}`, Math.cos(angle) * 2200, Math.sin(angle) * 2200, 'p'))
    }
    const map = nodes(...entries)
    const pos = computePlacement(map, 'p', footprint, undefined, NOW)
    expect(canFitAt(map, pos, footprint, NOW)).toBe(true)
  })
})

describe('computePlacement', () => {
  it('returns the origin when the parent does not exist', () => {
    expect(computePlacement(nodes(), 'ghost', SIZE)).toEqual({ x: 0, y: 0 })
  })

  it('places a first child of root somewhere clear', () => {
    const pos = computePlacement(nodes(), 'root', SIZE)
    expect(Number.isFinite(pos.x)).toBe(true)
    expect(Number.isFinite(pos.y)).toBe(true)
  })

  it('does not overlap the parent', () => {
    const map = nodes(md('p', 0, 0))
    const pos = computePlacement(map, 'p', SIZE)
    expect(overlapsAny(pos, map)).toBe(false)
  })

  it('does not overlap any existing sibling', () => {
    const map = nodes(md('p', 0, 0), md('s1', 600, 0, 'p'), md('s2', -600, 0, 'p'), md('s3', 0, 600, 'p'))
    const pos = computePlacement(map, 'p', SIZE)
    expect(overlapsAny(pos, map)).toBe(false)
  })

  it('stays clear in a crowded neighbourhood', () => {
    const entries: Array<[string, NodeData]> = [md('p', 0, 0)]
    for (let i = 0; i < 8; i++) {
      const angle = (i / 8) * Math.PI * 2
      entries.push(md(`s${i}`, Math.cos(angle) * 700, Math.sin(angle) * 700, 'p'))
    }
    const map = nodes(...entries)
    const pos = computePlacement(map, 'p', SIZE)
    expect(overlapsAny(pos, map)).toBe(false)
  })

  it('places the child within a bounded distance of its parent', () => {
    const map = nodes(md('p', 0, 0))
    const pos = computePlacement(map, 'p', SIZE)
    const dist = Math.hypot(pos.x, pos.y)
    // Far enough not to collide, near enough to read as a child of this parent.
    expect(dist).toBeGreaterThan(PLACEMENT_MARGIN)
    expect(dist).toBeLessThan(6000)
  })

  describe('position hint', () => {
    it('is honoured exactly when it is clear', () => {
      const hint = { x: 5000, y: 5000 }
      expect(computePlacement(nodes(md('p', 0, 0)), 'p', SIZE, hint)).toEqual(hint)
    })

    it('is honoured even when far from the parent', () => {
      const hint = { x: -20_000, y: 12_000 }
      expect(computePlacement(nodes(md('p', 0, 0)), 'p', SIZE, hint)).toEqual(hint)
    })

    it('is nudged aside when it collides and a nearby spot fits', () => {
      const map = nodes(md('p', 0, 0), md('blocker', 5000, 5000))
      const hint = { x: 5000, y: 5000 }
      const small = { width: 100, height: 100 }
      const pos = computePlacement(map, 'p', small, hint)
      expect(pos).not.toEqual(hint)
      expect(overlapsAny(pos, map, small)).toBe(false)
    })

    it('stays within the search radius when nudged', () => {
      const map = nodes(md('p', 0, 0), md('blocker', 5000, 5000))
      const hint = { x: 5000, y: 5000 }
      const small = { width: 100, height: 100 }
      const pos = computePlacement(map, 'p', small, hint)
      // The rings searched around the hint top out at 300px.
      expect(Math.hypot(pos.x - hint.x, pos.y - hint.y)).toBeLessThanOrEqual(300)
    })

    it('falls back to the hint itself when nothing nearby fits', () => {
      // A full-size card cannot clear a full-size blocker within the 300px
      // search radius, so placement gives up and honours the hint. Documented
      // fallback behaviour: the edge-split caller would rather get the position
      // the user pointed at than an arbitrary distant one.
      const map = nodes(md('p', 0, 0), md('blocker', 5000, 5000))
      const hint = { x: 5000, y: 5000 }
      expect(computePlacement(map, 'p', SIZE, hint)).toEqual(hint)
    })
  })

  it('is deterministic for identical input', () => {
    const map = nodes(md('p', 0, 0), md('s', 600, 0, 'p'))
    expect(computePlacement(map, 'p', SIZE)).toEqual(computePlacement(map, 'p', SIZE))
  })

  it('does not depend on node insertion order', () => {
    const a = nodes(md('p', 0, 0), md('s1', 600, 0, 'p'), md('s2', -600, 0, 'p'))
    const b = nodes(md('s2', -600, 0, 'p'), md('s1', 600, 0, 'p'), md('p', 0, 0))
    expect(computePlacement(a, 'p', SIZE)).toEqual(computePlacement(b, 'p', SIZE))
  })

  describe('beside a wide parent', () => {
    const term = { width: 1300, height: 780 }

    it('the parent really is wide', () => {
      const [, dir] = wideDir('d', 0, 0)
      const size = nodePixelSize(dir as never)
      expect(size.width).toBeGreaterThan(4 * size.height)
    })

    // The grandparent (root, at the origin) sits on one side, so the child
    // should go on the far side, roughly level with the directory.
    for (const [side, dirX] of [['right', 20_000], ['left', -20_000]] as const) {
      it(`goes beside it on the ${side} when the grandparent is on the other side`, () => {
        const map = nodes(wideDir('d', dirX, 0))
        const dirSize = nodePixelSize(map['d'] as never)
        const pos = computePlacement(map, 'd', term)
        // Wholly past the parent's end, not tucked above or below it...
        const outward = (pos.x - dirX) * Math.sign(dirX)
        expect(outward - term.width / 2).toBeGreaterThanOrEqual(dirSize.width / 2 + PLACEMENT_MARGIN)
        // ...and level with it.
        expect(Math.abs(pos.y)).toBeLessThan(dirSize.height / 2)
      })
    }

    it('stays clear of the parent when crowded onto its short sides', () => {
      // Siblings above and below push the child towards the directory's ends,
      // where the card extends furthest from its centre.
      const map = nodes(
        wideDir('d', 0, 20_000),
        md('above', 0, 18_000, 'd'),
        md('below', 0, 22_000, 'd'),
      )
      const pos = computePlacement(map, 'd', term)
      expect(overlapsAny(pos, map, term)).toBe(false)
    })
  })

  it('accommodates a much larger new node', () => {
    const big = { width: 2000, height: 1500 }
    const map = nodes(md('p', 0, 0))
    const pos = computePlacement(map, 'p', big)
    const parent = map['p']
    expect(clear(pos, big, { x: parent.x, y: parent.y }, SIZE)).toBe(true)
  })
})
