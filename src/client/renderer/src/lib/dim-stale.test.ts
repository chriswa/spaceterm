import { describe, it, expect } from 'vitest'
import { businessMillisBetween, computeStaleNodeIds, STALE_THRESHOLD_BUSINESS_MS } from './dim-stale'
import { asNodeId } from '../../../../shared/ids'
import type { NodeData } from '../../../../shared/state'

const HOUR = 60 * 60 * 1000

// Fixtures use fixed local dates so the business-window math is timezone-stable:
// both endpoints and expectations are built in local time. January 2026 starts
// on a Thursday, so Jan 5 is a Monday.
//   Mon Jan 5, Tue 6, Wed 7, Thu 8, Fri 9, Sat 10, Sun 11, Mon 12
const at = (month: number, day: number, hour: number, min = 0) =>
  new Date(2026, month, day, hour, min, 0, 0).getTime()

describe('businessMillisBetween', () => {
  it('counts time inside the business window', () => {
    expect(businessMillisBetween(at(0, 5, 10), at(0, 5, 12))).toBe(2 * HOUR)
  })

  it('clamps to the 9am–5pm window', () => {
    expect(businessMillisBetween(at(0, 5, 8), at(0, 5, 10))).toBe(1 * HOUR) // only 9–10 counts
    expect(businessMillisBetween(at(0, 5, 16), at(0, 5, 20))).toBe(1 * HOUR) // only 16–17 counts
    expect(businessMillisBetween(at(0, 5, 18), at(0, 5, 20))).toBe(0) // fully after hours
  })

  it('counts a full business day as 8 hours', () => {
    expect(businessMillisBetween(at(0, 5, 9), at(0, 5, 17))).toBe(8 * HOUR)
  })

  it('spans overnight, counting only each day’s window', () => {
    expect(businessMillisBetween(at(0, 5, 16), at(0, 6, 10))).toBe(2 * HOUR) // Mon 16–17 + Tue 9–10
  })

  it('skips the weekend entirely', () => {
    // Fri 16:00 → Mon 10:00: 1h Friday + 0 weekend + 1h Monday.
    expect(businessMillisBetween(at(0, 9, 16), at(0, 12, 10))).toBe(2 * HOUR)
    // Fri 09:00 → Mon 17:00: two full business days.
    expect(businessMillisBetween(at(0, 9, 9), at(0, 12, 17))).toBe(16 * HOUR)
  })

  it('returns 0 when to is not after from', () => {
    expect(businessMillisBetween(at(0, 5, 12), at(0, 5, 12))).toBe(0)
    expect(businessMillisBetween(at(0, 5, 12), at(0, 5, 10))).toBe(0)
  })
})

// computeStaleNodeIds only reads `parentId` and `lastInteractedAt`.
function nodes(defs: Array<{ id: string; parentId: string; at?: number }>): Record<string, NodeData> {
  const out: Record<string, NodeData> = {}
  for (const d of defs) {
    out[d.id] = { id: d.id, parentId: d.parentId, lastInteractedAt: d.at } as unknown as NodeData
  }
  return out
}

describe('computeStaleNodeIds (business hours)', () => {
  const NOW = at(0, 12, 12) // Monday noon

  it('keeps a node touched within 16 business hours lit', () => {
    // Fri 16:00 → Mon 12:00 = 1h + 3h = 4 business hours.
    const stale = computeStaleNodeIds(nodes([{ id: 'a', parentId: 'root', at: at(0, 9, 16) }]), NOW)
    expect(stale.size).toBe(0)
  })

  it('dims a node past 16 business hours', () => {
    // Thu 09:00 → Mon 12:00 = 8h + 8h + 3h = 19 business hours.
    const stale = computeStaleNodeIds(nodes([{ id: 'a', parentId: 'root', at: at(0, 8, 9) }]), NOW)
    expect([...stale]).toEqual(['a'])
  })

  it('treats a never-interacted node as stale', () => {
    const stale = computeStaleNodeIds(nodes([{ id: 'a', parentId: 'root' }]), NOW)
    expect(stale.has(asNodeId('a'))).toBe(true)
  })

  it('keeps a stale ancestor lit when a descendant is fresh', () => {
    // root and mid are past the threshold on their own; the fresh leaf lifts both.
    const stale = computeStaleNodeIds(nodes([
      { id: 'root', parentId: 'ROOT', at: at(0, 8, 9) },   // 19h → stale alone
      { id: 'mid', parentId: 'root', at: at(0, 8, 9) },
      { id: 'leaf', parentId: 'mid', at: at(0, 12, 10) },  // 2h → fresh
    ]), NOW)
    expect(stale.size).toBe(0)
  })

  it('dims a stale branch while its fresh sibling branch stays lit', () => {
    const stale = computeStaleNodeIds(nodes([
      { id: 'parent', parentId: 'root', at: at(0, 8, 9) },
      { id: 'fresh-child', parentId: 'parent', at: at(0, 12, 10) },
      { id: 'stale-child', parentId: 'parent', at: at(0, 8, 9) },
    ]), NOW)
    expect([...stale]).toEqual(['stale-child'])
  })

  it('is exclusive at the threshold boundary', () => {
    // Exactly 16 business hours old is NOT stale; a minute older is.
    const stale = computeStaleNodeIds(nodes([
      { id: 'at', parentId: 'root', at: at(0, 8, 12) },       // Thu noon → 5h+8h+3h = 16h exactly
      { id: 'past', parentId: 'root', at: at(0, 8, 11, 59) }, // a minute earlier → >16h
    ]), NOW, STALE_THRESHOLD_BUSINESS_MS)
    expect(stale.has(asNodeId('at'))).toBe(false)
    expect(stale.has(asNodeId('past'))).toBe(true)
  })
})
