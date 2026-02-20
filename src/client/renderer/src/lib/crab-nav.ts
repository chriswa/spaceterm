export type CrabColor = 'white' | 'red' | 'purple' | 'orange' | 'dim-orange' | 'gray'

/** Hex colors for each crab color variant. Matches the toolbar CSS classes. */
export const CRAB_COLORS: Record<CrabColor, string> = {
  white: '#ffffff',
  red: '#ff3366',
  purple: '#bb55ff',
  orange: '#ca7c5e',
  'dim-orange': '#653e2f',
  gray: '#888888',
}

export interface CrabEntry {
  nodeId: string
  color: CrabColor
  unviewed: boolean
  createdAt: string
  sortOrder: number
  title: string
  claudeStateDecidedAt?: number
}

/**
 * Derive the crab indicator color and unviewed status from a terminal node's
 * claude state. Returns null when the node has no crab indicator.
 */
export function deriveCrabAppearance(
  claudeState: string | undefined,
  claudeStatusUnread: boolean,
  hasClaudeHistory: boolean
): { color: CrabColor; unviewed: boolean } | null {
  if (claudeState === 'waiting_permission') return { color: 'red', unviewed: claudeStatusUnread }
  if (claudeState === 'waiting_plan') return { color: 'purple', unviewed: claudeStatusUnread }
  if (claudeState === 'working') return { color: 'orange', unviewed: false }
  if (claudeState === 'stuck') return { color: 'dim-orange', unviewed: claudeStatusUnread }
  if (claudeState === 'stopped' && claudeStatusUnread) return { color: 'white', unviewed: true }
  if (hasClaudeHistory) return { color: 'gray', unviewed: false }
  return null
}

/**
 * Returns the next or previous crab in the array (pre-sorted by createdAt).
 * Wraps around. Returns null when navigation isn't possible.
 *
 * When `focusedId` isn't found in the list (unfocused or crab was removed),
 * `phantomCreatedAt` is used to find where it *would have been* and the
 * neighbor in the requested direction is returned.
 */
export function adjacentCrab(
  crabs: CrabEntry[],
  focusedId: string | null,
  direction: 'left' | 'right',
  phantomCreatedAt?: string
): CrabEntry | null {
  if (crabs.length === 0) return null
  const idx = focusedId ? crabs.findIndex(c => c.nodeId === focusedId) : -1

  if (idx !== -1) {
    // Focused crab exists in the list — normal cycling
    if (crabs.length < 2) return null
    const len = crabs.length
    const nextIdx = direction === 'right'
      ? (idx + 1) % len
      : (idx - 1 + len) % len
    return crabs[nextIdx]
  }

  // Focused crab not in list — use phantom insertion point
  if (!phantomCreatedAt) return crabs.length === 1 ? crabs[0] : null

  // Binary search for insertion index in the sorted-by-createdAt list
  let lo = 0
  let hi = crabs.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (crabs[mid].createdAt < phantomCreatedAt) lo = mid + 1
    else hi = mid
  }
  // lo = insertion point (where the phantom crab would sit)

  const len = crabs.length
  if (direction === 'right') {
    // Next crab at or after the phantom position (wrap around)
    return crabs[lo % len]
  } else {
    // Previous crab before the phantom position (wrap around)
    return crabs[(lo - 1 + len) % len]
  }
}

/**
 * Priority tiers (lower = higher priority):
 *   0:   red + unviewed        (waiting_permission, unread)
 *   1:   purple + unviewed     (waiting_plan, unread)
 *   2:   white + unviewed      (stopped, unread)
 *   2.5: dim-orange + unviewed (stuck, unread)
 *   3:   red + !unviewed       (waiting_permission, viewed)
 *   4:   purple + !unviewed    (waiting_plan, viewed)
 *   5:   gray                  (dormant)
 *   5.5: dim-orange + !unviewed (stuck, viewed)
 *   6:   orange                (working)
 *
 * Tiebreaker: prefer oldest (leftmost in toolbar). Since crabs are sorted
 * oldest-first, iterate forward with < so the first match (oldest) wins.
 */
export function highestPriorityCrab(crabs: CrabEntry[]): CrabEntry | null {
  if (crabs.length === 0) return null

  let best: CrabEntry | null = null
  let bestTier = Infinity

  for (const crab of crabs) {
    const tier = crabTier(crab)
    if (tier < bestTier) {
      bestTier = tier
      best = crab
    }
  }

  return best
}

function crabTier(crab: CrabEntry): number {
  switch (crab.color) {
    case 'red':    return crab.unviewed ? 0 : 3
    case 'purple': return crab.unviewed ? 1 : 4
    case 'white':      return 2 // white is always unviewed
    case 'dim-orange': return crab.unviewed ? 2.5 : 5.5
    case 'gray':       return 5
    case 'orange':     return 6
  }
}
