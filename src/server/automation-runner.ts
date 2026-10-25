import * as fs from 'fs'
import { Cron } from 'croner'
import {
  parseTrigger,
  triggerLine,
  type AutomationFiring,
  type AutomationOverlap
} from '../shared/automation'
import type { AutomationNodeData, NodeData } from '../shared/state'
import type { NodeId } from '../shared/ids'
import { assertNever } from '../shared/exhaustive'

/**
 * Runs automation cards: decides when each one fires, and what firing does
 * given what is already running beneath it.
 *
 * Owns no timer and reads no clock. The server calls `tick(now)` on an
 * interval and `start(now)` once at startup, so a test drives time by hand.
 * Everything that touches the canvas goes through `AutomationHost`.
 */
export interface AutomationHost {
  automations(): AutomationNodeData[]
  /** Live (unarchived) children of a node. */
  childrenOf(nodeId: NodeId): NodeData[]
  /**
   * Start a Claude surface under the automation, its prompt the ancestors' plus
   * `line`. `below` puts it straight under the card, as a terminal started from
   * a markdown card is; `auto` finds it free space among its siblings.
   */
  spawn(automationId: NodeId, line: string, placement: RunPlacement): void
  /** Submit `line` as a new prompt into a live terminal. */
  send(terminalId: NodeId, line: string): void
  setQueue(automationId: NodeId, queue: AutomationFiring[]): void
  recordFired(automationId: NodeId, at: number): void
  log(line: string): void
}

/**
 * When the server was last known to be running, so a cron slot that passed
 * while it was not can still be acted on once at startup.
 */
export interface Heartbeat {
  read(): number | undefined
  write(at: number): void
}

/**
 * A slot this far in the past when it is noticed counts as missed rather than
 * merely noticed a tick late. Comfortably more than the tick interval.
 */
export const LATE_AFTER_MS = 2 * 60_000

/** Stop counting missed slots here: an every-minute cron over a long outage is still one late run. */
const MAX_COUNTED_SLOTS = 100_000

/** Scheduled times in `(after, until]`: the earliest, and how many. */
export function cronSlotsBetween(
  expression: string,
  after: number,
  until: number
): { first: number; last: number; count: number } | undefined {
  const cron = new Cron(expression, { paused: true })
  let next = cron.nextRun(new Date(after))
  if (!next || next.getTime() > until) return undefined
  const first = next.getTime()
  let last = first
  let count = 0
  while (next && next.getTime() <= until && count < MAX_COUNTED_SLOTS) {
    last = next.getTime()
    count++
    next = cron.nextRun(next)
  }
  return { first, last, count }
}

export type RunPlacement = 'below' | 'auto'

/**
 * Where a card's new run goes. Every mode but parallel keeps one run at a time,
 * so it has the spot under the card to itself; parallel runs sit side by side
 * and need placing among each other.
 */
export function runPlacement(overlap: AutomationOverlap): RunPlacement {
  return overlap === 'parallel' ? 'auto' : 'below'
}

export type FiringDecision =
  | { action: 'spawn' }
  | { action: 'send'; terminalId: NodeId }
  | { action: 'enqueue' }
  | { action: 'drop'; reason: string }

/** What one firing does, given the card's mode and what is already under it. */
export function decideFiring(
  overlap: AutomationOverlap,
  children: readonly NodeData[],
  queued: number
): FiringDecision {
  switch (overlap) {
    case 'parallel':
      return { action: 'spawn' }
    case 'single':
      return children.length === 0 ? { action: 'spawn' } : { action: 'drop', reason: 'a run is still going' }
    case 'queue':
      // Behind anything already queued, even with no children, so firings stay in order.
      return children.length === 0 && queued === 0 ? { action: 'spawn' } : { action: 'enqueue' }
    case 'reuse': {
      if (children.length === 0) return { action: 'spawn' }
      if (children.length > 1) return { action: 'drop', reason: `it has ${children.length} children, not one` }
      const [child] = children
      if (child.type !== 'terminal' || !child.alive) return { action: 'drop', reason: 'its child is not a running terminal' }
      return { action: 'send', terminalId: child.id }
    }
    default:
      return assertNever(overlap, 'decideFiring')
  }
}

export class AutomationRunner {
  /** Everything up to here has been looked at for cron slots. Undefined until `start`. */
  private checkedUntil: number | undefined

  constructor(
    private readonly host: AutomationHost,
    private readonly heartbeat: Heartbeat
  ) {}

  /**
   * Begin scheduling. Slots that passed since the heartbeat was last written —
   * while the server was down — fire once each card, marked late.
   */
  start(now: number): void {
    const lastAlive = this.heartbeat.read()
    this.checkedUntil = lastAlive !== undefined && lastAlive < now ? lastAlive : now
    this.tick(now)
  }

  /**
   * Fire every cron card with a slot since the last tick, then start anything
   * queued that can now run. A tick that comes late — the Mac slept — fires a
   * card once, however many of its slots it covers.
   */
  tick(now: number): void {
    if (this.checkedUntil === undefined) return
    const after = this.checkedUntil
    this.checkedUntil = now
    this.heartbeat.write(now)
    if (now > after) {
      for (const automation of this.host.automations()) {
        const trigger = parseTrigger(automation.trigger)
        if (trigger.kind !== 'cron') continue
        const slots = cronSlotsBetween(trigger.expression, after, now)
        if (!slots) continue
        const late = now - slots.last > LATE_AFTER_MS
        this.fire(automation, {
          kind: 'cron',
          at: now,
          ...(late ? { missed: { firstDueAt: slots.first, count: slots.count } } : {})
        })
      }
    }
    this.drainQueues()
  }

  /** Fire every card listening for `eventId`. Returns how many there were. */
  fireEvent(eventId: string, payload: unknown, now: number): number {
    let matched = 0
    for (const automation of this.host.automations()) {
      const trigger = parseTrigger(automation.trigger)
      if (trigger.kind !== 'event' || trigger.eventId !== eventId) continue
      matched++
      this.fire(automation, { kind: 'event', at: now, eventId, ...(payload !== undefined ? { payload } : {}) })
    }
    return matched
  }

  /**
   * Start the head of each queue whose card has no children left. Called on
   * every tick, and by the server whenever a node is archived or moved, since
   * that is what frees a queued card.
   */
  drainQueues(): void {
    for (const automation of this.host.automations()) {
      if (automation.queue.length === 0) continue
      if (this.host.childrenOf(automation.id).length > 0) continue
      const [next, ...rest] = automation.queue
      this.host.setQueue(automation.id, rest)
      this.run(automation, { action: 'spawn' }, next)
    }
  }

  private fire(automation: AutomationNodeData, firing: AutomationFiring): void {
    const decision = decideFiring(automation.overlap, this.host.childrenOf(automation.id), automation.queue.length)
    if (decision.action === 'enqueue') {
      this.host.setQueue(automation.id, [...automation.queue, firing])
      this.host.log(`[automation] ${automation.id.slice(0, 8)} queued a firing (${automation.queue.length + 1} waiting)`)
      return
    }
    this.run(automation, decision, firing)
  }

  private run(automation: AutomationNodeData, decision: Exclude<FiringDecision, { action: 'enqueue' }>, firing: AutomationFiring): void {
    const automationId = automation.id
    const line = triggerLine(firing)
    try {
      switch (decision.action) {
        case 'spawn':
          this.host.spawn(automationId, line, runPlacement(automation.overlap))
          break
        case 'send':
          this.host.send(decision.terminalId, line)
          break
        case 'drop':
          this.host.log(`[automation] ${automationId.slice(0, 8)} dropped a firing: ${decision.reason}`)
          return
        default:
          assertNever(decision, 'AutomationRunner.run')
      }
    } catch (err) {
      // One card failing to launch must not stop the rest of the tick.
      this.host.log(`[automation] ${automationId.slice(0, 8)} ${decision.action} failed: ${err instanceof Error ? err.message : String(err)}`)
      return
    }
    this.host.recordFired(automationId, firing.at)
    this.host.log(`[automation] ${automationId.slice(0, 8)} ${decision.action}: ${line.slice(0, 200)}`)
  }
}

/** The real heartbeat: one small JSON file, replaced atomically so a crash mid-write cannot corrupt it. */
export function fileHeartbeat(path: string): Heartbeat {
  return {
    read() {
      try {
        const value = (JSON.parse(fs.readFileSync(path, 'utf8')) as { lastAliveAt?: unknown }).lastAliveAt
        return typeof value === 'number' && Number.isFinite(value) ? value : undefined
      } catch {
        return undefined
      }
    },
    write(at) {
      const tmp = `${path}.${process.pid}.tmp`
      try {
        fs.writeFileSync(tmp, JSON.stringify({ lastAliveAt: at }))
        fs.renameSync(tmp, path)
      } catch {
        // A missed heartbeat only narrows what a later catch-up can see.
      }
    }
  }
}
