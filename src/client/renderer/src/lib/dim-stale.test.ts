import { describe, it, expect } from 'vitest'
import {
  ACTIVE_HOURS,
  ACTIVE_HOURS_OPTIONS,
  activeMillisBetween,
  computeNodeFreshness,
  OLDEST_BAND_AGE_MULTIPLE,
  STALE_BANDS,
  STALE_FRESHNESS,
  STALE_FRESHNESS_LEVELS,
  STALE_DIM_RATIO,
  STALE_EDGE_DIM_RATIO,
  STALE_MAX_DRAIN,
  staleBrightness,
  staleFilter,
  staleSaturation,
  DEFAULT_ACTIVE_HOURS_ID,
  DEFAULT_STALE_THRESHOLD_MS,
  STALE_THRESHOLD_HOUR_OPTIONS,
  DEFAULT_STALE_THRESHOLD_HOURS,
  normalizeActiveHoursId,
  normalizeStaleThresholdHours,
  staleThresholdMs,
  type ActiveHours,
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

const WORK = ACTIVE_HOURS.work
const HOME = ACTIVE_HOURS.home

describe('activeMillisBetween (work hours)', () => {
  it('counts time inside the business window', () => {
    expect(activeMillisBetween(at(0, 5, 10), at(0, 5, 12), WORK)).toBe(2 * HOUR)
  })

  it('clamps to the 9am–5pm window', () => {
    expect(activeMillisBetween(at(0, 5, 8), at(0, 5, 10), WORK)).toBe(1 * HOUR) // only 9–10 counts
    expect(activeMillisBetween(at(0, 5, 16), at(0, 5, 20), WORK)).toBe(1 * HOUR) // only 16–17 counts
    expect(activeMillisBetween(at(0, 5, 18), at(0, 5, 20), WORK)).toBe(0) // fully after hours
  })

  it('counts a full business day as 8 hours', () => {
    expect(activeMillisBetween(at(0, 5, 9), at(0, 5, 17), WORK)).toBe(8 * HOUR)
  })

  it('spans overnight, counting only each day’s window', () => {
    expect(activeMillisBetween(at(0, 5, 16), at(0, 6, 10), WORK)).toBe(2 * HOUR) // Mon 16–17 + Tue 9–10
  })

  it('skips the weekend entirely', () => {
    // Fri 16:00 → Mon 10:00: 1h Friday + 0 weekend + 1h Monday.
    expect(activeMillisBetween(at(0, 9, 16), at(0, 12, 10), WORK)).toBe(2 * HOUR)
    // Fri 09:00 → Mon 17:00: two full business days.
    expect(activeMillisBetween(at(0, 9, 9), at(0, 12, 17), WORK)).toBe(16 * HOUR)
  })

  it('returns 0 when to is not after from', () => {
    expect(activeMillisBetween(at(0, 5, 12), at(0, 5, 12), WORK)).toBe(0)
    expect(activeMillisBetween(at(0, 5, 12), at(0, 5, 10), WORK)).toBe(0)
  })
})

describe('activeMillisBetween (home hours)', () => {
  it('clamps to the 7am–10pm window', () => {
    expect(activeMillisBetween(at(0, 5, 6), at(0, 5, 9), HOME)).toBe(2 * HOUR)   // only 7–9 counts
    expect(activeMillisBetween(at(0, 5, 21), at(0, 5, 23), HOME)).toBe(1 * HOUR) // only 21–22 counts
    expect(activeMillisBetween(at(0, 5, 23), at(0, 6, 6), HOME)).toBe(0)         // fully overnight
  })

  it('counts a full home day as 15 hours', () => {
    expect(activeMillisBetween(at(0, 5, 7), at(0, 5, 22), HOME)).toBe(15 * HOUR)
  })

  it('counts the weekend, which work hours skip entirely', () => {
    // Sat 10:00 → Sun 12:00: 12h Saturday (10pm cutoff) + 5h Sunday.
    expect(activeMillisBetween(at(0, 10, 10), at(0, 11, 12), HOME)).toBe(17 * HOUR)
    expect(activeMillisBetween(at(0, 10, 10), at(0, 11, 12), WORK)).toBe(0)
  })

  it('ages a Friday-evening node over the weekend, where work hours freeze it', () => {
    // Fri 18:00 → Mon 12:00. Home: 4h Fri + 15h Sat + 15h Sun + 5h Mon = 39h.
    // Work: nothing counts until Monday 9am, so 3h.
    expect(activeMillisBetween(at(0, 9, 18), at(0, 12, 12), HOME)).toBe(39 * HOUR)
    expect(activeMillisBetween(at(0, 9, 18), at(0, 12, 12), WORK)).toBe(3 * HOUR)
  })
})

// computeNodeFreshness only reads `parentId` and `lastInteractedAt`.
function nodes(defs: Array<{ id: string; parentId: string; at?: number }>): Record<string, NodeData> {
  const out: Record<string, NodeData> = {}
  for (const d of defs) {
    out[d.id] = { id: d.id, parentId: d.parentId, lastInteractedAt: d.at } as unknown as NodeData
  }
  return out
}

describe('computeNodeFreshness (work hours)', () => {
  const NOW = at(0, 12, 12) // Monday noon

  it('keeps a node touched within 16 active hours at full freshness', () => {
    // Fri 16:00 → Mon 12:00 = 1h + 3h = 4 business hours.
    const freshness = computeNodeFreshness(nodes([{ id: 'a', parentId: 'root', at: at(0, 9, 16) }]), NOW)
    expect(freshness.get(asNodeId('a'))).toBe(STALE_FRESHNESS.recent)
  })

  it('drops to 60% immediately past 16 active hours', () => {
    // Thu 09:00 → Mon 12:00 = 8h + 8h + 3h = 19 business hours.
    const freshness = computeNodeFreshness(nodes([{ id: 'a', parentId: 'root', at: at(0, 8, 9) }]), NOW)
    expect(freshness.get(asNodeId('a'))).toBe(STALE_FRESHNESS.fading)
  })

  it('keeps the default threshold on the original 48h / 192h band edges', () => {
    // The multiples exist to reproduce the pre-scaling bands at the default.
    expect(STALE_BANDS.map(b => b.maxAgeMultiple * DEFAULT_STALE_THRESHOLD_MS))
      .toEqual([16 * HOUR, 48 * HOUR, 192 * HOUR, Infinity])

    const freshness = computeNodeFreshness(nodes([
      // Dec 15 → Jan 12 noon is 163 business hours: within 24 business days.
      { id: 'month', parentId: 'root', at: at(-1, 15, 9) },
      // Dec 1 → Jan 12 noon exceeds 24 business days.
      { id: 'old', parentId: 'root', at: at(-1, 1, 9) },
    ]), NOW)
    expect(freshness.get(asNodeId('month'))).toBe(STALE_FRESHNESS.faded)
    expect(freshness.get(asNodeId('old'))).toBe(STALE_FRESHNESS.oldest)
  })

  it('treats a never-interacted node as oldest', () => {
    const freshness = computeNodeFreshness(nodes([{ id: 'a', parentId: 'root' }]), NOW)
    expect(freshness.get(asNodeId('a'))).toBe(STALE_FRESHNESS.oldest)
  })

  it('keeps an old ancestor in full colour when a descendant is fresh', () => {
    // root and mid are past the threshold on their own; the fresh leaf lifts both.
    const freshness = computeNodeFreshness(nodes([
      { id: 'root', parentId: 'ROOT', at: at(0, 8, 9) },   // 19h → 60% alone
      { id: 'mid', parentId: 'root', at: at(0, 8, 9) },
      { id: 'leaf', parentId: 'mid', at: at(0, 12, 10) },  // 2h → fresh
    ]), NOW)
    expect([...freshness.values()]).toEqual([1, 1, 1])
  })

  it('drains an old branch while its fresh sibling branch keeps its colour', () => {
    const freshness = computeNodeFreshness(nodes([
      { id: 'parent', parentId: 'root', at: at(0, 8, 9) },
      { id: 'fresh-child', parentId: 'parent', at: at(0, 12, 10) },
      { id: 'stale-child', parentId: 'parent', at: at(0, 8, 9) },
    ]), NOW)
    expect(freshness.get(asNodeId('parent'))).toBe(STALE_FRESHNESS.recent)
    expect(freshness.get(asNodeId('fresh-child'))).toBe(STALE_FRESHNESS.recent)
    expect(freshness.get(asNodeId('stale-child'))).toBe(STALE_FRESHNESS.fading)
  })

  it('is exclusive at the full-freshness threshold boundary', () => {
    // Exactly 16 business hours old still holds full colour; a minute older is
    // one band down.
    const freshness = computeNodeFreshness(nodes([
      { id: 'at', parentId: 'root', at: at(0, 8, 12) },       // Thu noon → 5h+8h+3h = 16h exactly
      { id: 'past', parentId: 'root', at: at(0, 8, 11, 59) }, // a minute earlier → >16h
    ]), NOW, DEFAULT_STALE_THRESHOLD_MS)
    expect(freshness.get(asNodeId('at'))).toBe(STALE_FRESHNESS.recent)
    expect(freshness.get(asNodeId('past'))).toBe(STALE_FRESHNESS.fading)
  })

  it('honours a tighter threshold chosen from the toolbar', () => {
    // Fri 16:00 is 3 business hours before Mon noon: full colour at the 16h default,
    // dim at 2h.
    const fixture = nodes([{ id: 'a', parentId: 'root', at: at(0, 9, 16) }])
    expect(computeNodeFreshness(fixture, NOW, staleThresholdMs(DEFAULT_STALE_THRESHOLD_HOURS)).get(asNodeId('a')))
      .toBe(STALE_FRESHNESS.recent)
    expect(computeNodeFreshness(fixture, NOW, staleThresholdMs(2)).get(asNodeId('a')))
      .toBe(STALE_FRESHNESS.fading)
  })

  it('scales every band with the threshold, not just the first one', () => {
    // Thu 09:00 → Mon noon = 19 business hours. At the 16h default that is one
    // step past full colour; at 1h it is 19x the threshold, well past the
    // last band's 12x edge. Pin the greyer bands to fixed 48h/192h ages
    // instead and a 1h threshold leaves this node one step down the ladder — a
    // node untouched for days barely less coloured than one touched this
    // morning.
    const fixture = nodes([{ id: 'a', parentId: 'root', at: at(0, 8, 9) }])
    const freshnessAt = (hours: number) =>
      computeNodeFreshness(fixture, NOW, staleThresholdMs(hours)).get(asNodeId('a'))
    expect(freshnessAt(DEFAULT_STALE_THRESHOLD_HOURS)).toBe(STALE_FRESHNESS.fading)
    expect(freshnessAt(8)).toBe(STALE_FRESHNESS.fading)   // 19h ≤ 24h (3x)
    expect(freshnessAt(4)).toBe(STALE_FRESHNESS.faded)    // 19h ≤ 48h (12x), past 12h (3x)
    expect(freshnessAt(1)).toBe(STALE_FRESHNESS.oldest)   // past 12h (12x)
  })

  it('walks the whole ladder as a node ages against a fixed threshold', () => {
    // One threshold, four ages: the bands are ordered and each one is reachable.
    const freshness = computeNodeFreshness(nodes([
      { id: 'a', parentId: 'root', at: at(0, 12, 11, 30) },  // 0.5h → 1x
      { id: 'b', parentId: 'root', at: at(0, 12, 10) },      // 2h  → 3x
      { id: 'c', parentId: 'root', at: at(0, 9, 16) },       // 4h  → 12x
      { id: 'd', parentId: 'root', at: at(0, 8, 9) },        // 19h → past 12x
    ]), NOW, staleThresholdMs(1))
    expect([...freshness.values()]).toEqual(STALE_FRESHNESS_LEVELS)
  })
})

describe('computeNodeFreshness (the schedule choice)', () => {
  const NOW = at(0, 12, 12) // Monday noon

  it('drains a Friday-evening node under home hours that work hours keeps coloured', () => {
    // The whole point of the choice: a weekend is invisible at work and two of
    // the most active days of the week at home.
    const fixture = nodes([{ id: 'a', parentId: 'root', at: at(0, 9, 18) }])
    const freshnessUnder = (schedule: ActiveHours) =>
      computeNodeFreshness(fixture, NOW, DEFAULT_STALE_THRESHOLD_MS, schedule).get(asNodeId('a'))
    expect(freshnessUnder(WORK)).toBe(STALE_FRESHNESS.recent) // 3 work hours old
    expect(freshnessUnder(HOME)).toBe(STALE_FRESHNESS.fading) // 39 home hours old
  })

  it('defaults to work hours, so the setting arriving changes nothing', () => {
    const fixture = nodes([{ id: 'a', parentId: 'root', at: at(0, 9, 18) }])
    expect(DEFAULT_ACTIVE_HOURS_ID).toBe('work')
    expect(computeNodeFreshness(fixture, NOW).get(asNodeId('a')))
      .toBe(STALE_FRESHNESS.recent)
  })
})

describe('active-hours options', () => {
  it('offers every registered schedule, each keyed by its own id', () => {
    expect(ACTIVE_HOURS_OPTIONS.map(schedule => schedule.id)).toEqual(Object.keys(ACTIVE_HOURS))
    for (const [id, schedule] of Object.entries(ACTIVE_HOURS)) expect(schedule.id).toBe(id)
  })

  it('describes a window that opens before it closes', () => {
    for (const schedule of ACTIVE_HOURS_OPTIONS) {
      expect(schedule.endHour, schedule.id).toBeGreaterThan(schedule.startHour)
    }
  })

  it('falls back to the default for anything that is not a known schedule', () => {
    // localStorage can hold a hand-edited or retired id, and dimming by a rule
    // no menu item shows would be invisible.
    expect(normalizeActiveHoursId(null)).toBe(DEFAULT_ACTIVE_HOURS_ID)
    expect(normalizeActiveHoursId('')).toBe(DEFAULT_ACTIVE_HOURS_ID)
    expect(normalizeActiveHoursId('office')).toBe(DEFAULT_ACTIVE_HOURS_ID)
    expect(normalizeActiveHoursId('toString')).toBe(DEFAULT_ACTIVE_HOURS_ID) // not a prototype key
    expect(normalizeActiveHoursId('home')).toBe('home')
  })
})

describe('threshold options', () => {
  it('offers every whole hour from 1 up to the default', () => {
    expect(STALE_THRESHOLD_HOUR_OPTIONS[0]).toBe(1)
    expect(STALE_THRESHOLD_HOUR_OPTIONS.at(-1)).toBe(DEFAULT_STALE_THRESHOLD_HOURS)
    expect(STALE_THRESHOLD_HOUR_OPTIONS).toHaveLength(DEFAULT_STALE_THRESHOLD_HOURS)
  })

  it('leaves the default as the widest setting, so it still means 16 active hours', () => {
    expect(staleThresholdMs(DEFAULT_STALE_THRESHOLD_HOURS)).toBe(DEFAULT_STALE_THRESHOLD_MS)
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
  it('is ordered: later bands reach further and render fainter', () => {
    for (let i = 1; i < STALE_BANDS.length; i++) {
      expect(STALE_BANDS[i].maxAgeMultiple).toBeGreaterThan(STALE_BANDS[i - 1].maxAgeMultiple)
      expect(STALE_BANDS[i].freshness).toBeLessThan(STALE_BANDS[i - 1].freshness)
    }
  })

  it('ends unbounded, so every age classifies', () => {
    expect(STALE_BANDS.at(-1)!.maxAgeMultiple).toBe(Infinity)
    expect(OLDEST_BAND_AGE_MULTIPLE).toBe(STALE_BANDS.at(-2)!.maxAgeMultiple)
  })

  it('leaves an untouched node exactly as it was', () => {
    // The whole lens has to be a no-op at the freshest band, in all three of
    // its effects — this is what most of a board is drawn at.
    expect(staleSaturation(STALE_FRESHNESS.recent)).toBe(1)
    expect(staleBrightness(STALE_FRESHNESS.recent)).toBe(1)
    expect(staleBrightness(STALE_FRESHNESS.recent, STALE_EDGE_DIM_RATIO)).toBe(1)
  })

  it('spends its three knobs independently at the oldest band', () => {
    // Colour is what the lens mostly takes; lightness is a supporting cue, and
    // an edge — two pixels of chevron — gets half of even that.
    expect(staleSaturation(STALE_FRESHNESS.oldest)).toBe(1 - STALE_MAX_DRAIN)
    expect(staleBrightness(STALE_FRESHNESS.oldest)).toBe(1 - STALE_DIM_RATIO)
    expect(staleBrightness(STALE_FRESHNESS.oldest, STALE_EDGE_DIM_RATIO))
      .toBe(1 - STALE_DIM_RATIO / 2)
    // Each effect is monotone down the ladder, and none of them reaches zero:
    // a fully black or fully grey card loses which tint the user gave it.
    for (const { freshness } of STALE_BANDS) {
      expect(staleSaturation(freshness)).toBeGreaterThan(0)
      expect(staleBrightness(freshness)).toBeGreaterThanOrEqual(staleSaturation(freshness))
      expect(staleBrightness(freshness, STALE_EDGE_DIM_RATIO))
        .toBeGreaterThanOrEqual(staleBrightness(freshness))
    }
  })

  it('renders a band as one CSS filter, and an untouched node as none', () => {
    // No filter at all at full freshness: any value puts the card in its own
    // compositing layer, and most of a board is untouched by the lens.
    expect(staleFilter(STALE_FRESHNESS.recent)).toBeUndefined()
    expect(staleFilter(0.5)).toBe('saturate(0.625) brightness(0.8)')
    expect(staleFilter(0)).toBe('saturate(0.25) brightness(0.6)')
  })

  it('publishes exactly the levels the canvas batches edges by', () => {
    expect(STALE_FRESHNESS_LEVELS).toEqual([1, 0.5, 0.25, 0])
  })
})
