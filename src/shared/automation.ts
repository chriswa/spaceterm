import { Cron } from 'croner'
import { ancestorsOf, type NodeLookup } from './node-ancestry'
import type { AutomationNodeData, AutomationRunStats, NodeData } from './state'

/**
 * Automation cards: a trigger that starts a Claude surface beneath the card.
 *
 * The card carries no prompt of its own. What an agent is told comes from the
 * tree, exactly as for any other spawned surface (`gatherAncestorPrompt`),
 * plus one line saying what fired it. So everything here is about *when* to
 * start an agent and what to do if one is already running; the *what* is the
 * markdown above the card.
 *
 * Shared because the card validates its trigger field as you type with the
 * same parser the server schedules with.
 */

/** Event ids a script can fire carry this prefix, so they can never be read as a cron expression. */
export const CUSTOM_EVENT_PREFIX = 'custom_'

const CUSTOM_EVENT_ID = /^custom_[A-Za-z0-9_.:-]+$/

export function isCustomEventId(value: string): boolean {
  return CUSTOM_EVENT_ID.test(value)
}

/**
 * What a trigger field says.
 *
 * `empty` is its own case rather than `invalid`: a freshly made card has no
 * trigger yet, and that is a state to prompt for, not an error to show.
 */
export type ParsedTrigger =
  | { kind: 'empty' }
  | { kind: 'cron'; expression: string }
  | { kind: 'event'; eventId: string }
  | { kind: 'invalid'; error: string }

export function parseTrigger(text: string): ParsedTrigger {
  const trimmed = text.trim()
  if (!trimmed) return { kind: 'empty' }
  if (trimmed.startsWith(CUSTOM_EVENT_PREFIX)) {
    return isCustomEventId(trimmed)
      ? { kind: 'event', eventId: trimmed }
      : { kind: 'invalid', error: 'event ids are custom_ followed by letters, digits, _ . : or -' }
  }
  try {
    // Constructed paused: this only validates. A running Cron owns a timer.
    new Cron(trimmed, { paused: true })
    return { kind: 'cron', expression: trimmed }
  } catch (err) {
    return { kind: 'invalid', error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * What happens when a trigger fires while the card already has children.
 *
 * - `parallel`: start another agent regardless.
 * - `single`: drop the firing; one agent at a time.
 * - `queue`: keep the firing on the card and start it once every child has
 *   been archived.
 * - `reuse`: with exactly one child, send it the trigger line as a new prompt
 *   rather than starting another agent.
 */
export const AUTOMATION_OVERLAPS = ['parallel', 'single', 'queue', 'reuse'] as const
export type AutomationOverlap = (typeof AUTOMATION_OVERLAPS)[number]

export const DEFAULT_AUTOMATION_OVERLAP: AutomationOverlap = 'single'

export function isAutomationOverlap(value: unknown): value is AutomationOverlap {
  return (AUTOMATION_OVERLAPS as readonly unknown[]).includes(value)
}

export const AUTOMATION_OVERLAP_LABELS: Record<AutomationOverlap, string> = {
  parallel: 'Run in parallel',
  single: 'Skip if running',
  queue: 'Queue until done',
  reuse: 'Send to child'
}

/**
 * One occasion a trigger fired, with everything needed to start its agent
 * later. Queued firings are stored whole, so editing the card's trigger does
 * not change what an already-queued firing says.
 */
export type AutomationFiring =
  | {
      kind: 'cron'
      /** epoch ms the firing was acted on. */
      at: number
      /**
       * Set when the run is late: the earliest scheduled time that passed while
       * Spaceterm was not running, and how many were missed in all. A late
       * cron fires once, however many it missed.
       */
      missed?: { firstDueAt: number; count: number }
    }
  | {
      kind: 'event'
      at: number
      eventId: string
      /** Whatever JSON the script sent, or undefined when it sent none. */
      payload?: unknown
    }

/** Largest event payload accepted, as serialised JSON. It ends up on a command line. */
export const MAX_EVENT_PAYLOAD_BYTES = 64 * 1024

/** `2026-10-24T09:00:00-07:00`: local wall-clock time, with its offset. */
export function formatLocalTime(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number) => String(Math.abs(n)).padStart(2, '0')
  const offset = -d.getTimezoneOffset()
  const sign = offset >= 0 ? '+' : '-'
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(Math.trunc(offset / 60))}:${pad(offset % 60)}`
}

/** The one line an automation's agent is told about why it is running. */
export function triggerLine(firing: AutomationFiring): string {
  if (firing.kind === 'event') {
    const payload = firing.payload === undefined ? '' : ` ${JSON.stringify(firing.payload)}`
    return `Triggered by: ${firing.eventId}${payload}`
  }
  const base = `Triggered by: cron at ${formatLocalTime(firing.at)}`
  if (!firing.missed) return base
  const { firstDueAt, count } = firing.missed
  const times = count === 1 ? 'once' : `${count} times`
  return `${base} (late: it was due at ${formatLocalTime(firstDueAt)}` +
    `${count > 1 ? ` and missed ${times}` : ''} while Spaceterm was not running, so it ran as soon as possible)`
}

/**
 * Whether a node is an automation's run: a terminal with an automation card
 * anywhere above it.
 *
 * Runs are many, short-lived and unattended, so they skip what a hand-started
 * surface gets for being looked at: no generated icon (a gear stands in), no
 * title caption above the card, and no cache or idle caption below it.
 */
export function isAutomationRun(lookup: NodeLookup, node: NodeData | undefined): boolean {
  return automationOf(lookup, node) !== undefined
}

/** The automation card a run belongs to: the nearest one above it. Undefined for anything but a run. */
export function automationOf(lookup: NodeLookup, node: NodeData | undefined): AutomationNodeData | undefined {
  if (node?.type !== 'terminal') return undefined
  for (const ancestor of ancestorsOf(lookup, node.id)) {
    if (ancestor.type === 'automation') return ancestor
  }
  return undefined
}

/** `stats` with one more run added. */
export function addRun(
  stats: AutomationRunStats | undefined,
  run: { costUsd: number; tokens: number; endedAt: number }
): AutomationRunStats {
  return {
    runs: (stats?.runs ?? 0) + 1,
    totalCostUsd: (stats?.totalCostUsd ?? 0) + run.costUsd,
    last: run
  }
}
