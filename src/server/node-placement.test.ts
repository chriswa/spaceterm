import { describe, expect, it } from 'vitest'
import { canFitAt, computePlacement } from './node-placement'
import { PLACEMENT_MARGIN } from '../shared/node-size'
import { measureCard as nodePixelSize } from '../shared/card-types'
import type { NodeData } from '../shared/state'

/**
 * Placement geometry. These assert *properties* — "the result does not overlap
 * anything", "the hint was honoured" — rather than exact coordinates, because
 * the candidate scoring is a heuristic that can legitimately be retuned. Pinning
 * coordinates would make every tweak look like a regression.
 */

const SIZE = { width: 400, height: 300 }

/** Markdown nodes are the simplest shape: their pixel size is their stored size. */
function md(id: string, x: number, y: number, parentId = 'root'): [string, NodeData] {
  return [id, { id, type: 'markdown', parentId, x, y, width: SIZE.width, height: SIZE.height } as unknown as NodeData]
}

function nodes(...entries: Array<[string, NodeData]>): Record<string, NodeData> {
  return Object.fromEntries(entries)
}

/** True when two top-left-anchored boxes are at least PLACEMENT_MARGIN apart. */
function clear(
  a: { x: number; y: number }, aSize: { width: number; height: number },
  b: { x: number; y: number }, bSize: { width: number; height: number },
): boolean {
  const acx = a.x + aSize.width / 2, acy = a.y + aSize.height / 2
  const bcx = b.x + bSize.width / 2, bcy = b.y + bSize.height / 2
  return (
    Math.abs(acx - bcx) >= aSize.width / 2 + bSize.width / 2 + PLACEMENT_MARGIN ||
    Math.abs(acy - bcy) >= aSize.height / 2 + bSize.height / 2 + PLACEMENT_MARGIN
  )
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
    expect(canFitAt(map, anchor, { width: 2000, height: 300 })).toBe(false)
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
    const dist = Math.hypot(pos.x + SIZE.width / 2 - SIZE.width / 2, pos.y + SIZE.height / 2 - SIZE.height / 2)
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

  it('accommodates a much larger new node', () => {
    const big = { width: 2000, height: 1500 }
    const map = nodes(md('p', 0, 0))
    const pos = computePlacement(map, 'p', big)
    const parent = map['p']
    expect(clear(pos, big, { x: parent.x, y: parent.y }, SIZE)).toBe(true)
  })
})
