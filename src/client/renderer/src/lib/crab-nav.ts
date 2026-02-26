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
  kind: 'claude' | 'terminal'
  color: CrabColor
  unviewed: boolean
  asleep: boolean
  createdAt: string
  sortOrder: number
  title: string
  claudeStateDecidedAt?: number
}

/**
 * Derive the toolbar indicator color and unviewed status from a terminal node's
 * state. Every terminal node produces an indicator — Claude surfaces use
 * claude-state-driven colors, plain terminals default to gray/white.
 *
 * When asleep, the indicator is forced to a very dark grey regardless of underlying state.
 */
export function deriveToolbarIndicator(
  claudeState: string | undefined,
  claudeStatusUnread: boolean,
  claudeStatusAsleep: boolean,
  hasClaudeHistory: boolean
): { kind: 'claude' | 'terminal'; color: CrabColor; unviewed: boolean; asleep: boolean } {
  const base = deriveToolbarIndicatorInner(claudeState, claudeStatusUnread, hasClaudeHistory)
  if (claudeStatusAsleep) {
    return { kind: base.kind, color: 'asleep', unviewed: false, asleep: true }
  }
  return { ...base, asleep: false }
}

function deriveToolbarIndicatorInner(
  claudeState: string | undefined,
  claudeStatusUnread: boolean,
  hasClaudeHistory: boolean
): { kind: 'claude' | 'terminal'; color: CrabColor; unviewed: boolean } {
  if (claudeState === 'waiting_permission') return { kind: 'claude', color: 'red', unviewed: claudeStatusUnread }
  if (claudeState === 'waiting_question') return { kind: 'claude', color: 'green', unviewed: claudeStatusUnread }
  if (claudeState === 'waiting_plan') return { kind: 'claude', color: 'purple', unviewed: claudeStatusUnread }
  if (claudeState === 'working') return { kind: 'claude', color: 'orange', unviewed: false }
  if (claudeState === 'stuck') return { kind: 'claude', color: 'dim-orange', unviewed: claudeStatusUnread }
  if (claudeState === 'stopped' && claudeStatusUnread && hasClaudeHistory) return { kind: 'claude', color: 'white', unviewed: true }
  if (hasClaudeHistory) return { kind: 'claude', color: 'gray', unviewed: false }
  // Plain terminal — no Claude history
  return { kind: 'terminal', color: claudeStatusUnread ? 'white' : 'gray', unviewed: claudeStatusUnread }
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
 * Returns the highest-priority Claude surface crab. Terminal crabs are excluded —
 * Cmd+Down is strictly for jumping to Claude surfaces.
 *
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
export function highestPriorityClaudeCrab(crabs: CrabEntry[]): CrabEntry | null {
  if (crabs.length === 0) return null

  let best: CrabEntry | null = null
  let bestTier = Infinity

  for (const crab of crabs) {
    if (crab.kind === 'terminal') continue
    const tier = crabTier(crab)
    if (tier < bestTier) {
      bestTier = tier
      best = crab
    }
  }

  return best
}

function crabTier(crab: CrabEntry): number {
  if (crab.kind === 'terminal') return 100
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
