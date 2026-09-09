import { type NodeId } from '../../../../shared/ids'
import type { AgentType } from '../../../../shared/agent-type'
import type { CcSessionStatus } from '../../../../shared/state'
export type CrabColor = 'white' | 'red' | 'green' | 'purple' | 'orange' | 'yellow' | 'gray' | 'asleep'

/** Hex colors for each crab color variant. Matches the toolbar CSS classes. */
export const CRAB_COLORS: Record<CrabColor, string> = {
  white: '#ffffff',
  red: '#ff3366',
  green: '#44cc77',
  purple: '#bb55ff',
  orange: '#ca7c5e',
  // yellow = turn finished but background work (subagents / bash / monitors /
  // workflows) still running. A passive "winding down" status, not attention.
  yellow: '#e6c34d',
  gray: '#888888',
  asleep: '#555555',
}

export type AgentIndicatorKind = AgentType | 'terminal'

export interface CrabEntry {
  nodeId: NodeId
  /** All Claude session ids this crab has hosted — used to match TTS speaking events. */
  claudeSessionIds: string[]
  kind: AgentIndicatorKind
  color: CrabColor
  unviewed: boolean
  asleep: boolean
  createdAt: string
  sortOrder: number
  title: string
  claudeStateDecidedAt?: number
}

/** Longest `waitingFor` the footer will render before eliding. */
const CC_WAITING_FOR_MAX = 24

/**
 * The footer's rendering of Claude Code's own status, or null when there is
 * nothing to show.
 *
 * Claude surfaces only. Codex publishes per-thread write locks and Cursor
 * publishes nothing comparable, so those surfaces can never have a value here —
 * and a field that is permanently blank beside a populated state reads as
 * broken rather than as inapplicable. An absent `agentType` is a legacy Claude
 * surface (see `agentTypeOrDefault`), so it qualifies.
 *
 * Also null before the first observation lands and after a session's process
 * exits: the status describes a live process, and the last value a dead one
 * reported is not a fact about anything.
 */
export function ccStatusLabel(
  agentType: AgentType | undefined,
  ccStatus: CcSessionStatus | null | undefined,
  ccWaitingFor: string | null | undefined
): string | null {
  if (agentType === 'cursor' || agentType === 'codex') return null
  if (!ccStatus) return null
  // `waitingFor` is free text from Claude Code (a dialog's own label, among
  // other things), so it is unbounded input rendered into a single-line footer.
  const reason = ccWaitingFor
    ? ` (${ccWaitingFor.length > CC_WAITING_FOR_MAX ? ccWaitingFor.slice(0, CC_WAITING_FOR_MAX - 1) + '\u2026' : ccWaitingFor})`
    : ''
  return `cc: ${ccStatus}${reason}`
}

/**
 * Derive the toolbar indicator color and unviewed status from a terminal node's
 * state. Agent surfaces use state-driven colors; plain terminals default to gray/white.
 *
 * When asleep, the indicator is forced to a very dark grey regardless of underlying state.
 */
export function deriveToolbarIndicator(
  claudeState: string | undefined,
  claudeStatusUnread: boolean,
  claudeStatusAsleep: boolean,
  hasSessionHistory: boolean,
  agentType?: AgentType
): { kind: AgentIndicatorKind; color: CrabColor; unviewed: boolean; asleep: boolean } {
  const base = deriveToolbarIndicatorInner(claudeState, claudeStatusUnread, hasSessionHistory, agentType)
  if (claudeStatusAsleep) {
    return { kind: base.kind, color: 'asleep', unviewed: false, asleep: true }
  }
  return { ...base, asleep: false }
}

/**
 * Whether `claudeStatusUnread` is legible on this surface's indicator.
 *
 * Several states paint their own colour and force `unviewed` false —
 * working, working_background, asleep — so the flag is invisible while they
 * hold. Toggling it there changes nothing the user can see and then
 * resurfaces, as a surprise, once the state settles.
 *
 * Rather than restate the list (which would drift the moment a new state is
 * added above), this asks `deriveToolbarIndicator` directly: flip the flag and
 * see whether anything about the indicator moves.
 */
export function unreadIsLegible(
  claudeState: string | undefined,
  claudeStatusAsleep: boolean,
  hasSessionHistory: boolean,
  agentType?: AgentType
): boolean {
  const on = deriveToolbarIndicator(claudeState, true, claudeStatusAsleep, hasSessionHistory, agentType)
  const off = deriveToolbarIndicator(claudeState, false, claudeStatusAsleep, hasSessionHistory, agentType)
  return on.unviewed !== off.unviewed || on.color !== off.color
}

function deriveToolbarIndicatorInner(
  claudeState: string | undefined,
  claudeStatusUnread: boolean,
  hasSessionHistory: boolean,
  agentType?: AgentType
): { kind: AgentIndicatorKind; color: CrabColor; unviewed: boolean } {
  const agentKind: AgentIndicatorKind =
    agentType === 'cursor' ? 'cursor'
      : agentType === 'codex' ? 'codex'
        : agentType === 'claude' || hasSessionHistory ? 'claude'
          : 'terminal'

  if (agentKind === 'terminal') {
    return { kind: 'terminal', color: claudeStatusUnread ? 'white' : 'gray', unviewed: claudeStatusUnread }
  }

  if (claudeState === 'waiting_permission') return { kind: agentKind, color: 'red', unviewed: claudeStatusUnread }
  if (claudeState === 'waiting_question') return { kind: agentKind, color: 'green', unviewed: claudeStatusUnread }
  if (claudeState === 'waiting_plan') return { kind: agentKind, color: 'purple', unviewed: claudeStatusUnread }
  // A suspected API error remains visible after acknowledgement, but becomes
  // white once read so acknowledged issues do not look like active prompts.
  if (claudeState === 'potential_error') return { kind: agentKind, color: claudeStatusUnread ? 'red' : 'white', unviewed: claudeStatusUnread }
  if (claudeState === 'working') return { kind: agentKind, color: 'orange', unviewed: false }
  // Turn ended but background work is still running — passive status, like working.
  if (claudeState === 'working_background') return { kind: agentKind, color: 'yellow', unviewed: false }
  if (claudeState === 'stopped' && claudeStatusUnread && hasSessionHistory) return { kind: agentKind, color: 'white', unviewed: true }
  // Fresh agent surface (agentType set, no session history yet) still shows the agent icon.
  if (hasSessionHistory || agentType) return { kind: agentKind, color: 'gray', unviewed: false }
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
  focusedId: NodeId | null,
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
 *        potential_error shares the red attention tier while unread.
 *   2:   white + unviewed      (stopped, unread)
 *   3:   red + !unviewed       (waiting_permission, viewed)
 *   3.5: green + !unviewed     (waiting_question, viewed)
 *   4:   purple + !unviewed    (waiting_plan, viewed)
 *        potential_error is white after acknowledgement and uses the white tier.
 *   5:   gray                  (dormant)
 *   6:   orange                (working)
 *   6.5: yellow                (working_background — finishing background work)
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
    // Cmd+Down jumps to agent surfaces (Claude or Cursor), not plain terminals.
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
    case 'white':      return 2 // stopped-unread or an acknowledged potential error
    case 'gray':       return 5
    case 'orange':     return 6
    case 'yellow':     return 6.5
    case 'asleep':     return 99
  }
}
