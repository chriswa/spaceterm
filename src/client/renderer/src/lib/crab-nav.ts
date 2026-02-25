export type CrabColor = 'white' | 'red' | 'green' | 'purple' | 'orange' | 'dim-orange' | 'gray' | 'asleep'

/** Hex colors for each crab color variant. Matches the toolbar CSS classes. */
export const CRAB_COLORS: Record<CrabColor, string> = {
  white: '#ffffff',
  red: '#ff3366',
  green: '#44cc77',
  purple: '#bb55ff',
  orange: '#ca7c5e',
  'dim-orange': '#653e2f',
  gray: '#888888',
  asleep: '#555555',
}

export interface CrabEntry {
  nodeId: string
  color: CrabColor
  unviewed: boolean
  asleep: boolean
  createdAt: string
  sortOrder: number
  title: string
  claudeStateDecidedAt?: number
}

/**
 * Derive the crab indicator color and unviewed status from a terminal node's
 * claude state. Returns null when the node has no crab indicator.
 *
 * When asleep, the crab is forced to a very dark grey regardless of underlying state.
 */
export function deriveCrabAppearance(
  claudeState: string | undefined,
  claudeStatusUnread: boolean,
  claudeStatusAsleep: boolean,
  hasClaudeHistory: boolean
): { color: CrabColor; unviewed: boolean; asleep: boolean } | null {
  if (claudeStatusAsleep) {
    // Asleep overrides all visual state — show as dark grey, no attention indicators
    const base = deriveCrabAppearanceInner(claudeState, claudeStatusUnread, hasClaudeHistory)
    if (!base) return null
    return { color: 'asleep', unviewed: false, asleep: true }
  }
  const base = deriveCrabAppearanceInner(claudeState, claudeStatusUnread, hasClaudeHistory)
  if (!base) return null
  return { ...base, asleep: false }
}

function deriveCrabAppearanceInner(
  claudeState: string | undefined,
  claudeStatusUnread: boolean,
  hasClaudeHistory: boolean
): { color: CrabColor; unviewed: boolean } | null {
  if (claudeState === 'waiting_permission') return { color: 'red', unviewed: claudeStatusUnread }
  if (claudeState === 'waiting_question') return { color: 'green', unviewed: claudeStatusUnread }
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
 * Asleep crabs are skipped — cmd+left/right should not stop on them.
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
  const awake = crabs.filter(c => !c.asleep)
  if (awake.length === 0) return null
  const idx = focusedId ? awake.findIndex(c => c.nodeId === focusedId) : -1

  if (idx !== -1) {
    // Focused crab exists in the list — normal cycling
    if (awake.length < 2) return null
    const len = awake.length
    const nextIdx = direction === 'right'
      ? (idx + 1) % len
      : (idx - 1 + len) % len
    return awake[nextIdx]
  }

  // Focused crab not in list — use phantom insertion point
  if (!phantomCreatedAt) return awake.length === 1 ? awake[0] : null

  // Binary search for insertion index in the sorted-by-createdAt list
  let lo = 0
  let hi = awake.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (awake[mid].createdAt < phantomCreatedAt) lo = mid + 1
    else hi = mid
  }
  // lo = insertion point (where the phantom crab would sit)

  const len = awake.length
  if (direction === 'right') {
    // Next crab at or after the phantom position (wrap around)
    return awake[lo % len]
  } else {
    // Previous crab before the phantom position (wrap around)
    return awake[(lo - 1 + len) % len]
  }
}

/**
 * Priority tiers (lower = higher priority):
 *   0:   red + unviewed        (waiting_permission, unread)
 *   0.5: green + unviewed      (waiting_question, unread)
 *   1:   purple + unviewed     (waiting_plan, unread)
 *   2:   white + unviewed      (stopped, unread)
 *   2.5: dim-orange + unviewed (stuck, unread)
 *   3:   red + !unviewed       (waiting_permission, viewed)
 *   3.5: green + !unviewed     (waiting_question, viewed)
 *   4:   purple + !unviewed    (waiting_plan, viewed)
 *   5:   gray                  (dormant)
 *   5.5: dim-orange + !unviewed (stuck, viewed)
 *   6:   orange                (working)
 *   99:  asleep                (user-hidden, lowest priority)
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
  if (crab.asleep) return 99
  switch (crab.color) {
    case 'red':    return crab.unviewed ? 0 : 3
    case 'green':  return crab.unviewed ? 0.5 : 3.5
    case 'purple': return crab.unviewed ? 1 : 4
    case 'white':      return 2 // white is always unviewed
    case 'dim-orange': return crab.unviewed ? 2.5 : 5.5
    case 'gray':       return 5
    case 'orange':     return 6
    case 'asleep':     return 99
  }
}
