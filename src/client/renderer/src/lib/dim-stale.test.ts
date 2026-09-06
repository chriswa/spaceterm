import { describe, it, expect } from 'vitest'
import {
  businessMillisBetween,
  computeNodeBrightness,
  DARKEST_BAND_AGE_MULTIPLE,
  STALE_BANDS,
  STALE_BRIGHTNESS,
  STALE_BRIGHTNESS_LEVELS,
  STALE_THRESHOLD_BUSINESS_MS,
  STALE_THRESHOLD_HOUR_OPTIONS,
  DEFAULT_STALE_THRESHOLD_HOURS,
  normalizeStaleThresholdHours,
  staleThresholdMs,
} from './dim-stale'
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

// computeNodeBrightness only reads `parentId` and `lastInteractedAt`.
function nodes(defs: Array<{ id: string; parentId: string; at?: number }>): Record<string, NodeData> {
  const out: Record<string, NodeData> = {}
  for (const d of defs) {
    out[d.id] = { id: d.id, parentId: d.parentId, lastInteractedAt: d.at } as unknown as NodeData
  }
  return out
}

describe('computeNodeBrightness (business hours)', () => {
  const NOW = at(0, 12, 12) // Monday noon

  it('keeps a node touched within 16 business hours at full brightness', () => {
    // Fri 16:00 → Mon 12:00 = 1h + 3h = 4 business hours.
    const brightness = computeNodeBrightness(nodes([{ id: 'a', parentId: 'root', at: at(0, 9, 16) }]), NOW)
    expect(brightness.get(asNodeId('a'))).toBe(STALE_BRIGHTNESS.recent)
  })

  it('drops to 60% immediately past 16 business hours', () => {
    // Thu 09:00 → Mon 12:00 = 8h + 8h + 3h = 19 business hours.
    const brightness = computeNodeBrightness(nodes([{ id: 'a', parentId: 'root', at: at(0, 8, 9) }]), NOW)
    expect(brightness.get(asNodeId('a'))).toBe(STALE_BRIGHTNESS.fading)
  })

  it('keeps the default threshold on the original 48h / 192h band edges', () => {
    // The multiples exist to reproduce the pre-scaling bands at the default.
    expect(STALE_BANDS.map(b => b.maxAgeMultiple * STALE_THRESHOLD_BUSINESS_MS))
      .toEqual([16 * HOUR, 48 * HOUR, 192 * HOUR, Infinity])

    const brightness = computeNodeBrightness(nodes([
      // Dec 15 → Jan 12 noon is 163 business hours: within 24 business days.
      { id: 'month', parentId: 'root', at: at(-1, 15, 9) },
      // Dec 1 → Jan 12 noon exceeds 24 business days.
      { id: 'old', parentId: 'root', at: at(-1, 1, 9) },
    ]), NOW)
    expect(brightness.get(asNodeId('month'))).toBe(STALE_BRIGHTNESS.faded)
    expect(brightness.get(asNodeId('old'))).toBe(STALE_BRIGHTNESS.oldest)
  })

  it('treats a never-interacted node as oldest', () => {
    const brightness = computeNodeBrightness(nodes([{ id: 'a', parentId: 'root' }]), NOW)
    expect(brightness.get(asNodeId('a'))).toBe(STALE_BRIGHTNESS.oldest)
  })

  it('keeps an old ancestor fully bright when a descendant is fresh', () => {
    // root and mid are past the threshold on their own; the fresh leaf lifts both.
    const brightness = computeNodeBrightness(nodes([
      { id: 'root', parentId: 'ROOT', at: at(0, 8, 9) },   // 19h → 60% alone
      { id: 'mid', parentId: 'root', at: at(0, 8, 9) },
      { id: 'leaf', parentId: 'mid', at: at(0, 12, 10) },  // 2h → fresh
    ]), NOW)
    expect([...brightness.values()]).toEqual([1, 1, 1])
  })

  it('dims an old branch while its fresh sibling branch stays fully bright', () => {
    const brightness = computeNodeBrightness(nodes([
      { id: 'parent', parentId: 'root', at: at(0, 8, 9) },
      { id: 'fresh-child', parentId: 'parent', at: at(0, 12, 10) },
      { id: 'stale-child', parentId: 'parent', at: at(0, 8, 9) },
    ]), NOW)
    expect(brightness.get(asNodeId('parent'))).toBe(STALE_BRIGHTNESS.recent)
    expect(brightness.get(asNodeId('fresh-child'))).toBe(STALE_BRIGHTNESS.recent)
    expect(brightness.get(asNodeId('stale-child'))).toBe(STALE_BRIGHTNESS.fading)
  })

  it('is exclusive at the full-brightness threshold boundary', () => {
    // Exactly 16 business hours old is still fully bright; a minute older is 60%.
    const brightness = computeNodeBrightness(nodes([
      { id: 'at', parentId: 'root', at: at(0, 8, 12) },       // Thu noon → 5h+8h+3h = 16h exactly
      { id: 'past', parentId: 'root', at: at(0, 8, 11, 59) }, // a minute earlier → >16h
    ]), NOW, STALE_THRESHOLD_BUSINESS_MS)
    expect(brightness.get(asNodeId('at'))).toBe(STALE_BRIGHTNESS.recent)
    expect(brightness.get(asNodeId('past'))).toBe(STALE_BRIGHTNESS.fading)
  })

  it('honours a tighter threshold chosen from the toolbar', () => {
    // Fri 16:00 is 3 business hours before Mon noon: bright at the 16h default,
    // dim at 2h.
    const fixture = nodes([{ id: 'a', parentId: 'root', at: at(0, 9, 16) }])
    expect(computeNodeBrightness(fixture, NOW, staleThresholdMs(DEFAULT_STALE_THRESHOLD_HOURS)).get(asNodeId('a')))
      .toBe(STALE_BRIGHTNESS.recent)
    expect(computeNodeBrightness(fixture, NOW, staleThresholdMs(2)).get(asNodeId('a')))
      .toBe(STALE_BRIGHTNESS.fading)
  })

  it('scales every band with the threshold, not just the first one', () => {
    // Thu 09:00 → Mon noon = 19 business hours. At the 16h default that is one
    // step past full brightness; at 1h it is 19x the threshold, well past the
    // darkest band's 12x edge. The bug this covers: the darker bands used to sit
    // at fixed 48h/192h ages, so a 1h threshold left this node at 0.6 — a node
    // untouched for days looked barely dimmer than one touched this morning.
    const fixture = nodes([{ id: 'a', parentId: 'root', at: at(0, 8, 9) }])
    const brightnessAt = (hours: number) =>
      computeNodeBrightness(fixture, NOW, staleThresholdMs(hours)).get(asNodeId('a'))
    expect(brightnessAt(DEFAULT_STALE_THRESHOLD_HOURS)).toBe(STALE_BRIGHTNESS.fading)
    expect(brightnessAt(8)).toBe(STALE_BRIGHTNESS.fading)   // 19h ≤ 24h (3x)
    expect(brightnessAt(4)).toBe(STALE_BRIGHTNESS.faded)    // 19h ≤ 48h (12x), past 12h (3x)
    expect(brightnessAt(1)).toBe(STALE_BRIGHTNESS.oldest)   // past 12h (12x)
  })

  it('walks the whole ladder as a node ages against a fixed threshold', () => {
    // One threshold, four ages: the bands are ordered and each one is reachable.
    const brightness = computeNodeBrightness(nodes([
      { id: 'a', parentId: 'root', at: at(0, 12, 11, 30) },  // 0.5h → 1x
      { id: 'b', parentId: 'root', at: at(0, 12, 10) },      // 2h  → 3x
      { id: 'c', parentId: 'root', at: at(0, 9, 16) },       // 4h  → 12x
      { id: 'd', parentId: 'root', at: at(0, 8, 9) },        // 19h → past 12x
    ]), NOW, staleThresholdMs(1))
    expect([...brightness.values()]).toEqual(STALE_BRIGHTNESS_LEVELS)
  })
})

describe('threshold options', () => {
  it('offers every whole hour from 1 up to the default', () => {
    expect(STALE_THRESHOLD_HOUR_OPTIONS[0]).toBe(1)
    expect(STALE_THRESHOLD_HOUR_OPTIONS.at(-1)).toBe(DEFAULT_STALE_THRESHOLD_HOURS)
    expect(STALE_THRESHOLD_HOUR_OPTIONS).toHaveLength(DEFAULT_STALE_THRESHOLD_HOURS)
  })

  it('leaves the default as the widest setting, so it still means 16 business hours', () => {
    expect(staleThresholdMs(DEFAULT_STALE_THRESHOLD_HOURS)).toBe(STALE_THRESHOLD_BUSINESS_MS)
  })

  it('normalizes anything outside the offered range onto an option', () => {
    // A value no menu item shows would dim by an invisible rule.
    for (const [input, expected] of [[0, 1], [-4, 1], [99, 16], [3.4, 3], [3.6, 4]] as const) {
      expect(normalizeStaleThresholdHours(input), String(input)).toBe(expected)
    }
    expect(STALE_THRESHOLD_HOUR_OPTIONS).toContain(normalizeStaleThresholdHours(7))
  })

  it('falls back to the default for a value that is not a number at all', () => {
    expect(normalizeStaleThresholdHours(NaN)).toBe(DEFAULT_STALE_THRESHOLD_HOURS)
    expect(normalizeStaleThresholdHours(Infinity)).toBe(DEFAULT_STALE_THRESHOLD_HOURS)
  })
})

describe('the fade ladder', () => {
  it('is ordered: later bands reach further and render darker', () => {
    for (let i = 1; i < STALE_BANDS.length; i++) {
      expect(STALE_BANDS[i].maxAgeMultiple).toBeGreaterThan(STALE_BANDS[i - 1].maxAgeMultiple)
      expect(STALE_BANDS[i].brightness).toBeLessThan(STALE_BANDS[i - 1].brightness)
    }
  })

  it('ends unbounded, so every age classifies', () => {
    expect(STALE_BANDS.at(-1)!.maxAgeMultiple).toBe(Infinity)
    expect(DARKEST_BAND_AGE_MULTIPLE).toBe(STALE_BANDS.at(-2)!.maxAgeMultiple)
  })

  it('publishes exactly the levels the canvas batches edges by', () => {
    expect(STALE_BRIGHTNESS_LEVELS).toEqual([1, 0.6, 0.4, 0.2])
  })
})
