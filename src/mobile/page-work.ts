import type { ServerTransport } from '../shared/server-client'
import type { Gate } from './gate'

/**
 * What the page was sent and how long it spent on it, reported once a minute
 * as a `page-work` event in the audio and lifecycle record
 * (`~/.spaceterm/mobile-events.jsonl`). It is how Control mode is shown to
 * work with the phone locked, where Instruments (`ios/energy.sh`) cannot
 * record: a minute in Control mode should be a few kilobytes, not megabytes.
 *
 * - `messages`, `kb` — everything received in the minute;
 * - `byType` — the heaviest message types, `[count, kb]` each;
 * - `handlingMs` — time spent parsing and dispatching them as they arrived
 *   (renders React schedules from them land later and are not counted);
 * - `controlModeS` — how much of the minute was in Control mode;
 * - `lateMs` — how late the report's own timer fired: a page too busy, or
 *   suspended, to run it on time.
 */

const REPORT_MS = 60_000
/** Enough to show what dominates without the event growing with the protocol. */
const TOP_TYPES = 8

interface Tally { n: number; chars: number }

const kb = (chars: number) => Math.round(chars / 102.4) / 10

export class PageWork {
  private byType = new Map<string, Tally>()
  private handlingMs = 0

  /** A chunk from the socket: one or more newline-terminated JSON lines. */
  received(chunk: string): void {
    let start = 0
    while (start < chunk.length) {
      let end = chunk.indexOf('\n', start)
      if (end === -1) end = chunk.length
      if (end > start) this.count(messageType(chunk, start), end - start + 1)
      start = end + 1
    }
  }

  handled(ms: number): void {
    this.handlingMs += ms
  }

  /** The tallies since the last call, which starts the next. */
  take(): { messages: number; kb: number; handlingMs: number; byType: Record<string, [number, number]> } {
    const entries = [...this.byType].sort((a, b) => b[1].chars - a[1].chars)
    let messages = 0
    let chars = 0
    for (const [, t] of entries) { messages += t.n; chars += t.chars }
    const byType: Record<string, [number, number]> = {}
    for (const [type, t] of entries.slice(0, TOP_TYPES)) byType[type] = [t.n, kb(t.chars)]
    const report = { messages, kb: kb(chars), handlingMs: Math.round(this.handlingMs), byType }
    this.byType = new Map()
    this.handlingMs = 0
    return report
  }

  private count(type: string, chars: number): void {
    const t = this.byType.get(type)
    if (t) { t.n++; t.chars += chars } else this.byType.set(type, { n: 1, chars })
  }
}

const TYPE_PREFIX = '{"type":"'

/**
 * The server writes `type` first in every message, so it is read from the
 * line's head rather than by parsing it a second time.
 */
function messageType(chunk: string, start: number): string {
  if (!chunk.startsWith(TYPE_PREFIX, start)) return '(other)'
  const from = start + TYPE_PREFIX.length
  const to = chunk.indexOf('"', from)
  return to === -1 || to - from > 64 ? '(other)' : chunk.slice(from, to)
}

/** `transport`, counting into `work` what arrives and how long it takes to handle. */
export function meteredTransport(transport: ServerTransport, work: PageWork, now: () => number = () => performance.now()): ServerTransport {
  return {
    ...transport,
    open: (handlers) => transport.open({
      ...handlers,
      onData: (chunk) => {
        work.received(chunk)
        const started = now()
        handlers.onData(chunk)
        work.handled(now() - started)
      }
    }),
  }
}

export interface PageWorkReportDeps {
  work: PageWork
  controlMode: Gate
  record(kind: string, detail: Record<string, unknown>): void
  now?: () => number
  every?: (fn: () => void, ms: number) => void
}

/** Report `work` once a minute. */
export function installPageWorkReport({ work, controlMode, record, now = Date.now, every = (fn, ms) => { setInterval(fn, ms) } }: PageWorkReportDeps): void {
  let windowStart = now()
  let controlModeMs = 0
  let controlSince: number | null = controlMode.on ? windowStart : null
  controlMode.subscribe((on) => {
    if (on) controlSince = now()
    else if (controlSince !== null) { controlModeMs += now() - controlSince; controlSince = null }
  })
  every(() => {
    const at = now()
    if (controlSince !== null) { controlModeMs += at - controlSince; controlSince = at }
    record('page-work', {
      windowS: Math.round((at - windowStart) / 1000),
      lateMs: Math.max(0, Math.round(at - windowStart - REPORT_MS)),
      controlModeS: Math.round(controlModeMs / 1000),
      ...work.take(),
    })
    windowStart = at
    controlModeMs = 0
  }, REPORT_MS)
}
