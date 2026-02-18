export interface CrabEntry {
  nodeId: string
  color: 'white' | 'red' | 'purple' | 'orange' | 'gray'
  unviewed: boolean
  createdAt: string
  title: string
}

/**
 * Returns the next or previous crab in the array (pre-sorted by createdAt).
 * Wraps around. Returns null if focusedId isn't a crab or list has < 2 entries.
 */
export function adjacentCrab(
  crabs: CrabEntry[],
  focusedId: string,
  direction: 'left' | 'right'
): CrabEntry | null {
  if (crabs.length < 2) return null
  const idx = crabs.findIndex(c => c.nodeId === focusedId)
  if (idx === -1) return null
  const len = crabs.length
  const nextIdx = direction === 'right'
    ? (idx + 1) % len
    : (idx - 1 + len) % len
  return crabs[nextIdx]
}

/**
 * Priority tiers (lower = higher priority):
 *   0: red + unviewed   (waiting_permission, unread)
 *   1: purple + unviewed (waiting_plan, unread)
 *   2: white + unviewed  (stopped, unread)
 *   3: red + !unviewed   (waiting_permission, viewed)
 *   4: purple + !unviewed (waiting_plan, viewed)
 *   5: gray              (dormant)
 *   6: orange            (working)
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
    case 'white':  return 2 // white is always unviewed
    case 'gray':   return 5
    case 'orange': return 6
  }
}
