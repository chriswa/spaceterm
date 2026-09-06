import type { NodeData } from '../../../../shared/state'
import { nodeIdsOf, type NodeId } from '../../../../shared/ids'

// Business hours: Mon–Fri, 9am–5pm local time. The staleness clock only advances
// inside this window, so nights and weekends don't age a node.
const BUSINESS_START_HOUR = 9
const BUSINESS_END_HOUR = 17

/**
 * How much business time a node's whole subtree can go untouched before the
 * "dim stale nodes" view stops keeping it at full brightness, in hours.
 *
 * 16 business hours — two 8-hour business days — is the widest setting and the
 * default: enough to keep today, the previous business day, and part of the one
 * before it lit. The toolbar's dim control offers every whole hour below it, for
 * a tighter "what did I touch recently" lens.
 */
export const DEFAULT_STALE_THRESHOLD_HOURS = 16

/** The thresholds the toolbar offers, in business hours: 1h up to the default. */
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

export const STALE_THRESHOLD_BUSINESS_MS = staleThresholdMs(DEFAULT_STALE_THRESHOLD_HOURS)

export const STALE_BRIGHTNESS = {
  /** Touched within the threshold. */
  recent: 1,
  /** Just past the threshold. */
  fading: 0.6,
  /** Well past it. */
  faded: 0.4,
  /** As dark as the lens goes. */
  oldest: 0.2,
} as const

/**
 * The fade ladder: how far each brightness band reaches, as a multiple of the
 * chosen threshold.
 *
 * The *whole* ladder scales with the threshold, which is what makes the toolbar
 * control mean what it says — halve the threshold and a node reaches the darkest
 * band in half the business time. (Every step but the first used to be pinned to
 * a fixed calendar-sized window, so a 1-hour threshold still needed 24 business
 * days to go darkest, and everything between 1 and 48 business hours old sat
 * together in one barely-dimmed band.)
 *
 * The multiples are those original fixed bands expressed against the
 * 16-business-hour default, so that setting still fades exactly as it did:
 * 1x = 16h (two business days), 3x = 48h (six business days — the most a calendar
 * week plus a day can hold), 12x = 192h (24 business days — the most a 31-day
 * month plus a day can hold). Bands are inclusive of their edge, and the last one
 * is unbounded.
 */
export const STALE_BANDS = [
  { maxAgeMultiple: 1, brightness: STALE_BRIGHTNESS.recent },
  { maxAgeMultiple: 3, brightness: STALE_BRIGHTNESS.fading },
  { maxAgeMultiple: 12, brightness: STALE_BRIGHTNESS.faded },
  { maxAgeMultiple: Infinity, brightness: STALE_BRIGHTNESS.oldest },
] as const

/**
 * Every brightness the ladder can produce, brightest first. The canvas draws
 * tree edges one batch per level, so it needs the set of values rather than the
 * age mapping — and an edge whose brightness is not in this list never gets
 * drawn, so the two must not drift apart.
 */
export const STALE_BRIGHTNESS_LEVELS: readonly number[] = STALE_BANDS.map(b => b.brightness)

/**
 * The multiple of the threshold at which a node reaches the darkest band — the
 * age past which the ladder has nothing left to say, so both the staleness walk
 * and the toolbar's tooltip can stop there.
 */
export const DARKEST_BAND_AGE_MULTIPLE = Math.max(
  ...STALE_BANDS.map(b => b.maxAgeMultiple).filter(m => Number.isFinite(m))
)

function isWeekday(day: number): boolean {
  return day >= 1 && day <= 5 // 0 = Sunday, 6 = Saturday
}

/**
 * Milliseconds of business time (Mon–Fri, 9am–5pm local) between `from` and
 * `to`. Walks day by day, summing each day's overlap with its business window.
 *
 * `cap` bounds the walk: it stops once the total exceeds `cap`, since callers
 * only compare against a threshold. Any node older than ~2 business days hits
 * the cap within a few iterations, so the walk stays cheap no matter how old
 * `from` is.
 */
export function businessMillisBetween(from: number, to: number, cap = Infinity): number {
  if (to <= from) return 0
  let total = 0
  const cursor = new Date(from)
  while (cursor.getTime() < to && total <= cap) {
    const nextMidnight = new Date(cursor)
    nextMidnight.setHours(24, 0, 0, 0)
    if (isWeekday(cursor.getDay())) {
      const winStart = new Date(cursor)
      winStart.setHours(BUSINESS_START_HOUR, 0, 0, 0)
      const winEnd = new Date(cursor)
      winEnd.setHours(BUSINESS_END_HOUR, 0, 0, 0)
      // This day's slice of [from, to] is [cursor, min(to, nextMidnight)];
      // intersect it with the business window.
      const overlapStart = Math.max(cursor.getTime(), winStart.getTime())
      const overlapEnd = Math.min(to, nextMidnight.getTime(), winEnd.getTime())
      if (overlapEnd > overlapStart) total += overlapEnd - overlapStart
    }
    cursor.setTime(nextMidnight.getTime())
  }
  return total
}

/**
 * Brightness for each node, based on how long its whole subtree (the node and
 * every descendant) has gone untouched. A node stays as bright as its freshest
 * descendant, so interacting with one leaf keeps its whole ancestor chain lit
 * — the "touch it and its parents wake up" behaviour the dim view is for.
 *
 * `thresholdBusinessMs` sets the whole fade curve, not just its first step: it
 * is the unit the `STALE_BANDS` multiples are measured in, so a shorter
 * threshold reaches every darker band proportionally sooner.
 *
 * O(n): subtree freshness is the max `lastInteractedAt` over a node's subtree,
 * computed once bottom-up with memoization (and a cycle guard, since the tree is
 * derived from `parentId` links rather than trusted structure).
 */
export function computeNodeBrightness(
  nodes: Record<string, NodeData>,
  now: number,
  thresholdBusinessMs: number = STALE_THRESHOLD_BUSINESS_MS
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
  // the lookup below always matches; the walk in businessMillisBetween can stop
  // at the darkest band's edge, since everything beyond it classifies the same.
  const bandEdges = STALE_BANDS.map(b => b.maxAgeMultiple * thresholdBusinessMs)
  const ageCap = DARKEST_BAND_AGE_MULTIPLE * thresholdBusinessMs

  const brightness = new Map<NodeId, number>()
  for (const id of nodeIdsOf(nodes)) {
    const age = businessMillisBetween(visit(id), now, ageCap)
    brightness.set(id, STALE_BANDS[bandEdges.findIndex(edge => age <= edge)].brightness)
  }
  return brightness
}

/** Shallow map equality — used to skip a store update when brightness is unchanged. */
export function nodeBrightnessEqual(a: Map<NodeId, number>, b: Map<NodeId, number>): boolean {
  if (a.size !== b.size) return false
  for (const [id, brightness] of a) if (b.get(id) !== brightness) return false
  return true
}
