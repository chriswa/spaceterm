import type { NodeData } from '../../../../shared/state'
import { nodeIdsOf, type NodeId } from '../../../../shared/ids'

/**
 * A window of local wall-clock time during which the staleness clock advances.
 * Outside it — nights, and weekends for a weekdays-only schedule — a node does
 * not age, so time away doesn't dim the board you left behind.
 */
export interface ActiveHours {
  readonly id: ActiveHoursId
  /** Menu label. */
  readonly label: string
  /** The window, spelled out under the label. */
  readonly blurb: string
  /** Local hour the window opens, inclusive. */
  readonly startHour: number
  /** Local hour the window closes, exclusive. */
  readonly endHour: number
  /** Whether Saturday and Sunday count at all. */
  readonly weekdaysOnly: boolean
}

export type ActiveHoursId = 'work' | 'home'

/**
 * The two schedules the dim menu offers. They exist because "how long since I
 * touched this" means different things on the two machines this runs on: at
 * work a weekend is invisible, at home it is two of the most active days of the
 * week, and a schedule that ignored them would dim everything by Monday.
 */
export const ACTIVE_HOURS: Record<ActiveHoursId, ActiveHours> = {
  work: {
    id: 'work',
    label: 'Work hours',
    blurb: 'Mon–Fri, 9am–5pm',
    startHour: 9,
    endHour: 17,
    weekdaysOnly: true,
  },
  home: {
    id: 'home',
    label: 'Home hours',
    blurb: 'Every day, 7am–10pm',
    startHour: 7,
    endHour: 22,
    weekdaysOnly: false,
  },
}

/** Menu order, and the order the picker renders. */
export const ACTIVE_HOURS_OPTIONS: readonly ActiveHours[] = [ACTIVE_HOURS.work, ACTIVE_HOURS.home]

/** The original behaviour, kept as the default so an upgrade changes nothing. */
export const DEFAULT_ACTIVE_HOURS_ID: ActiveHoursId = 'work'

/**
 * The schedule named by `id`, or the default — for values that come back from
 * `localStorage`, where anything at all can be stored.
 */
export function normalizeActiveHoursId(id: string | null): ActiveHoursId {
  // `hasOwn`, not `in`: `in` would accept 'toString' and index into the prototype.
  return id !== null && Object.hasOwn(ACTIVE_HOURS, id)
    ? (id as ActiveHoursId)
    : DEFAULT_ACTIVE_HOURS_ID
}

/**
 * How much active time a node's whole subtree can go untouched before the
 * "dim stale nodes" view stops drawing it untouched, in hours.
 *
 * 16 active hours is the widest setting and the default: two 8-hour work days,
 * or a bit over one 15-hour home day — enough to keep today, the previous day,
 * and part of the one before it lit. The toolbar's dim control offers every
 * whole hour below it, for a tighter "what did I touch recently" lens.
 */
export const DEFAULT_STALE_THRESHOLD_HOURS = 16

/** The thresholds the toolbar offers, in active hours: 1h up to the default. */
export const STALE_THRESHOLD_HOUR_OPTIONS: readonly number[] =
  Array.from({ length: DEFAULT_STALE_THRESHOLD_HOURS }, (_, i) => i + 1)

/** Hours → milliseconds, so the unit conversion lives next to the options. */
export function staleThresholdMs(hours: number): number {
  return hours * 60 * 60 * 1000
}

/**
 * The nearest offered threshold to `hours`, for values that come back from
 * `localStorage` — where a hand-edited or stale entry can be anything at all,
 * and a silently out-of-range threshold would dim by a rule no menu item shows.
 */
export function normalizeStaleThresholdHours(hours: number): number {
  if (!Number.isFinite(hours)) return DEFAULT_STALE_THRESHOLD_HOURS
  return Math.min(Math.max(Math.round(hours), 1), DEFAULT_STALE_THRESHOLD_HOURS)
}

export const DEFAULT_STALE_THRESHOLD_MS = staleThresholdMs(DEFAULT_STALE_THRESHOLD_HOURS)

/**
 * How much of its normal look a node keeps, by age band: 1 is untouched by the
 * lens, 0 is as aged as the lens goes.
 *
 * A band carries this one number and nothing else. Both effects are derived
 * from it — `staleSaturation` for the colour, `staleBrightness` for the
 * lightness — which is what keeps a band one value everywhere it is used (one
 * number per node in the store, one uniform per edge batch on the canvas) and
 * lets the two be tuned against each other without touching this ladder.
 *
 * The three knobs below produce, at the current settings:
 *
 * | band   | freshness | saturate | card brightness | edge brightness |
 * |--------|-----------|----------|-----------------|-----------------|
 * | recent | 1         | 1        | 1               | 1               |
 * | fading | 0.5       | 0.625    | 0.8             | 0.9             |
 * | faded  | 0.25      | 0.4375   | 0.7             | 0.85            |
 * | oldest | 0         | 0.25     | 0.6             | 0.8             |
 */
export const STALE_FRESHNESS = {
  /** Touched within the threshold. */
  recent: 1,
  /** Just past the threshold. */
  fading: 0.5,
  /** Well past it. */
  faded: 0.25,
  /** As aged as the lens goes. */
  oldest: 0,
} as const

/**
 * How much colour the lens takes at the oldest band.
 *
 * Short of 1 on purpose. A card drained to flat grey loses which of the tints
 * it was — and the tint is a thing the user chose and still needs to read at a
 * glance on an old branch. A quarter of the colour left is enough to tell two
 * tints apart while still reading as drained next to a fresh card.
 */
export const STALE_MAX_DRAIN = 0.75

/**
 * How much lightness a card loses at the oldest band.
 *
 * Colour alone is a quiet signal on a board whose cards are mostly dark chrome
 * to begin with — there is little colour there to take away, so an old card and
 * a fresh one read nearly the same. A little darkening puts the difference in a
 * channel a dark card still has room in, while staying well short of the black
 * this lens used to reach (0.6 lightness at the oldest band, against 0.2).
 */
export const STALE_DIM_RATIO = 0.4

/**
 * How much lightness an *edge* loses at the oldest band, against a card's.
 *
 * Half, because a card and an edge have very different amounts of ink to lose.
 * A card is a large surface and reads as receding when it dims; an edge is a
 * two-pixel chevron on a patterned ground, and taking the same lightness off it
 * erases the line rather than ageing it — which costs the shape of the tree,
 * the one thing the edges are there to show.
 *
 * Expressed against the card ratio rather than as its own number, so retuning
 * the darkening moves both together.
 */
export const STALE_EDGE_DIM_RATIO = STALE_DIM_RATIO / 2

/** The `saturate()` amount for a node at `freshness`. */
export function staleSaturation(freshness: number): number {
  return 1 - STALE_MAX_DRAIN * (1 - freshness)
}

/**
 * The `brightness()` amount for a node at `freshness` — a card's by default,
 * an edge's when passed `STALE_EDGE_DIM_RATIO`.
 *
 * Derived rather than tabulated so the knobs above are the only place either
 * effect is written down, and so the CSS filter and the canvas's `drain()`
 * cannot disagree about what one band looks like: `shaders.ts` builds its GLSL
 * from these same constants.
 */
export function staleBrightness(
  freshness: number,
  dimRatio: number = STALE_DIM_RATIO
): number {
  return 1 - dimRatio * (1 - freshness)
}

/**
 * The fade ladder: how far each freshness band reaches, as a multiple of the
 * chosen threshold.
 *
 * The *whole* ladder scales with the threshold, which is what makes the toolbar
 * control mean what it says — halve the threshold and a node reaches the last
 * band in half the active time.
 *
 * The multiples are calendar-sized windows expressed against the 16-business-hour
 * default:
 * 1x = 16h (two business days), 3x = 48h (six business days — the most a calendar
 * week plus a day can hold), 12x = 192h (24 business days — the most a 31-day
 * month plus a day can hold). Bands are inclusive of their edge, and the last one
 * is unbounded.
 */
export const STALE_BANDS = [
  { maxAgeMultiple: 1, freshness: STALE_FRESHNESS.recent },
  { maxAgeMultiple: 3, freshness: STALE_FRESHNESS.fading },
  { maxAgeMultiple: 12, freshness: STALE_FRESHNESS.faded },
  { maxAgeMultiple: Infinity, freshness: STALE_FRESHNESS.oldest },
] as const

/**
 * Every freshness the ladder can produce, freshest first. The canvas draws
 * tree edges one batch per level, so it needs the set of values rather than the
 * age mapping — and an edge whose freshness is not in this list never gets
 * drawn, so the two must not drift apart.
 */
export const STALE_FRESHNESS_LEVELS: readonly number[] = STALE_BANDS.map(b => b.freshness)

/**
 * The multiple of the threshold at which a node reaches the last band — the age
 * past which the ladder has nothing left to say, so both the staleness walk and
 * the toolbar's tooltip can stop there.
 */
export const OLDEST_BAND_AGE_MULTIPLE = Math.max(
  ...STALE_BANDS.map(b => b.maxAgeMultiple).filter(m => Number.isFinite(m))
)

/** Whether `day` (0 = Sunday, 6 = Saturday) counts under this schedule. */
function isActiveDay(schedule: ActiveHours, day: number): boolean {
  return !schedule.weekdaysOnly || (day >= 1 && day <= 5)
}

/**
 * Milliseconds of `schedule`'s active time between `from` and `to`. Walks day
 * by day, summing each day's overlap with that day's window.
 *
 * `cap` bounds the walk: it stops once the total exceeds `cap`, since callers
 * only compare against a threshold. Any node older than a couple of active days
 * hits the cap within a few iterations, so the walk stays cheap no matter how
 * old `from` is.
 */
export function activeMillisBetween(
  from: number,
  to: number,
  schedule: ActiveHours,
  cap = Infinity
): number {
  if (to <= from) return 0
  let total = 0
  const cursor = new Date(from)
  while (cursor.getTime() < to && total <= cap) {
    const nextMidnight = new Date(cursor)
    nextMidnight.setHours(24, 0, 0, 0)
    if (isActiveDay(schedule, cursor.getDay())) {
      const winStart = new Date(cursor)
      winStart.setHours(schedule.startHour, 0, 0, 0)
      const winEnd = new Date(cursor)
      winEnd.setHours(schedule.endHour, 0, 0, 0)
      // This day's slice of [from, to] is [cursor, min(to, nextMidnight)];
      // intersect it with the active window.
      const overlapStart = Math.max(cursor.getTime(), winStart.getTime())
      const overlapEnd = Math.min(to, nextMidnight.getTime(), winEnd.getTime())
      if (overlapEnd > overlapStart) total += overlapEnd - overlapStart
    }
    cursor.setTime(nextMidnight.getTime())
  }
  return total
}

/**
 * Freshness for each node, based on how long its whole subtree (the node and
 * every descendant) has gone untouched. A node stays as colourful as its
 * freshest descendant, so interacting with one leaf keeps its whole ancestor
 * chain lit — the "touch it and its parents wake up" behaviour the dim view is
 * for.
 *
 * `thresholdMs` sets the whole fade curve, not just its first step: it is the
 * unit the `STALE_BANDS` multiples are measured in, so a shorter threshold
 * reaches every older band proportionally sooner. `schedule` decides which
 * wall-clock time counts towards it at all.
 *
 * O(n): subtree freshness is the max `lastInteractedAt` over a node's subtree,
 * computed once bottom-up with memoization (and a cycle guard, since the tree is
 * derived from `parentId` links rather than trusted structure).
 */
export function computeNodeFreshness(
  nodes: Record<string, NodeData>,
  now: number,
  thresholdMs: number = DEFAULT_STALE_THRESHOLD_MS,
  schedule: ActiveHours = ACTIVE_HOURS[DEFAULT_ACTIVE_HOURS_ID]
): Map<NodeId, number> {
  const childIds = new Map<NodeId, NodeId[]>()
  for (const id of nodeIdsOf(nodes)) {
    const parentId = nodes[id].parentId
    const list = childIds.get(parentId)
    if (list) list.push(id)
    else childIds.set(parentId, [id])
  }

  const subtreeMax = new Map<NodeId, number>()
  const visit = (id: NodeId): number => {
    const cached = subtreeMax.get(id)
    if (cached !== undefined) return cached
    subtreeMax.set(id, 0) // cycle guard: a re-entrant visit reads 0, not undefined
    let max = nodes[id]?.lastInteractedAt ?? 0
    for (const child of childIds.get(id) ?? []) {
      max = Math.max(max, visit(child))
    }
    subtreeMax.set(id, max)
    return max
  }

  // The ladder, resolved against this threshold. The last edge is Infinity, so
  // the lookup below always matches; the walk in activeMillisBetween can stop
  // at the last band's edge, since everything beyond it classifies the same.
  const bandEdges = STALE_BANDS.map(b => b.maxAgeMultiple * thresholdMs)
  const ageCap = OLDEST_BAND_AGE_MULTIPLE * thresholdMs

  const freshness = new Map<NodeId, number>()
  for (const id of nodeIdsOf(nodes)) {
    const age = activeMillisBetween(visit(id), now, schedule, ageCap)
    freshness.set(id, STALE_BANDS[bandEdges.findIndex(edge => age <= edge)].freshness)
  }
  return freshness
}

/**
 * The CSS `filter` that draws a node at `freshness`, or `undefined` for a node
 * the lens has not touched. Cards and their labels both wear it, so the two
 * cannot age at different rates.
 *
 * `undefined` rather than `saturate(1) brightness(1)` matters: any filter value
 * puts the element in its own compositing layer, which a board full of
 * untouched cards should not pay for.
 */
export function staleFilter(freshness: number): string | undefined {
  return freshness < 1
    ? `saturate(${staleSaturation(freshness)}) brightness(${staleBrightness(freshness)})`
    : undefined
}

/** Shallow map equality — used to skip a store update when freshness is unchanged. */
export function nodeFreshnessEqual(a: Map<NodeId, number>, b: Map<NodeId, number>): boolean {
  if (a.size !== b.size) return false
  for (const [id, freshness] of a) if (b.get(id) !== freshness) return false
  return true
}
