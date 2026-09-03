import type { NodeData } from '../../../../shared/state'
import { nodeIdsOf, type NodeId } from '../../../../shared/ids'

// Business hours: Mon–Fri, 9am–5pm local time. The staleness clock only advances
// inside this window, so nights and weekends don't age a node.
const BUSINESS_START_HOUR = 9
const BUSINESS_END_HOUR = 17

/**
 * How much business time a node's whole subtree can go untouched before the
 * "dim stale nodes" view keeps it at full brightness: 16 business hours — two
 * 8-hour business days. Enough to keep today, the previous business day, and
 * part of the one before it lit. Tune here (a future toolbar control could
 * expose it).
 */
export const STALE_THRESHOLD_BUSINESS_MS = 16 * 60 * 60 * 1000

const BUSINESS_DAY_MS = (BUSINESS_END_HOUR - BUSINESS_START_HOUR) * 60 * 60 * 1000

// Eight calendar days can contain at most six weekdays. A 31-day calendar
// month plus one day can contain at most 24 weekdays. Using those maxima keeps
// an item in a brighter band for the whole requested calendar-sized window,
// irrespective of where weekends fall.
export const WEEK_PLUS_DAY_BUSINESS_MS = 6 * BUSINESS_DAY_MS
export const MONTH_PLUS_DAY_BUSINESS_MS = 24 * BUSINESS_DAY_MS

export const STALE_BRIGHTNESS = {
  recent: 1,
  weekPlusDay: 0.6,
  monthPlusDay: 0.4,
  older: 0.2,
} as const

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

  const brightness = new Map<NodeId, number>()
  for (const id of nodeIdsOf(nodes)) {
    const mostRecent = visit(id)
    const age = businessMillisBetween(mostRecent, now, MONTH_PLUS_DAY_BUSINESS_MS)
    const level = age <= thresholdBusinessMs
      ? STALE_BRIGHTNESS.recent
      : age <= WEEK_PLUS_DAY_BUSINESS_MS
        ? STALE_BRIGHTNESS.weekPlusDay
        : age <= MONTH_PLUS_DAY_BUSINESS_MS
          ? STALE_BRIGHTNESS.monthPlusDay
          : STALE_BRIGHTNESS.older
    brightness.set(id, level)
  }
  return brightness
}

/** Shallow map equality — used to skip a store update when brightness is unchanged. */
export function nodeBrightnessEqual(a: Map<NodeId, number>, b: Map<NodeId, number>): boolean {
  if (a.size !== b.size) return false
  for (const [id, brightness] of a) if (b.get(id) !== brightness) return false
  return true
}
