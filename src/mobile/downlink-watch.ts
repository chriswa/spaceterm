import type { ServerTransport } from '../shared/server-client'

/**
 * The socket to the Mac, watched from this end, for the phone's record
 * (mobile-events.ts). October 12: after the phone woke, a sentence of speech
 * and the wake word's answer arrived 27 s late while the phone's own
 * messages kept reaching the Mac — so the next stall should say which side
 * held them. Recorded:
 *
 * - `socket` — opened or closed, and how long it had been open.
 * - `downlink-quiet` — nothing from the Mac for `QUIET_MS` with the socket
 *   open (the Mac sends something every few seconds), once per quiet spell.
 * - `downlink-gap` — something arrived after a gap of `QUIET_MS` or more: how
 *   long, and what it was.
 * - `downlink-on-visible` — the page shown again: how long since the Mac was
 *   last heard from, and the socket's state.
 *
 * Pure but for `record`, the clock and the timer, which are passed in.
 */
export const QUIET_MS = 8000

export interface DownlinkWatchDeps {
  record(kind: string, detail: Record<string, unknown>): void
  now?: () => number
  every?: (fn: () => void, ms: number) => void
  /** Whether the page is shown, for the record. */
  visible?: () => boolean
}

/** A message's `type`, from the front of its line, without parsing the whole of it. */
export function messageType(chunk: string): string {
  return /^\{"type":"([^"]+)"/.exec(chunk)?.[1] ?? '?'
}

export class DownlinkWatch {
  private openedAt: number | null = null
  private lastData: number | null = null
  private quietRecorded = false
  private readonly now: () => number
  private readonly visible: () => boolean

  constructor(private readonly deps: DownlinkWatchDeps) {
    this.now = deps.now ?? (() => Date.now())
    this.visible = deps.visible ?? (() => true)
    ;(deps.every ?? ((fn, ms) => { setInterval(fn, ms) }))(() => this.check(), 1000)
  }

  opened(): void {
    this.openedAt = this.now()
    this.lastData = this.openedAt
    this.quietRecorded = false
    this.deps.record('socket', { state: 'open', visible: this.visible() })
  }

  closed(): void {
    const openMs = this.openedAt === null ? null : this.now() - this.openedAt
    this.deps.record('socket', { state: 'closed', openMs, sinceDataMs: this.sinceData(), visible: this.visible() })
    this.openedAt = null
  }

  received(chunk: string): void {
    const at = this.now()
    const gap = this.lastData === null ? 0 : at - this.lastData
    if (gap >= QUIET_MS) {
      this.deps.record('downlink-gap', { gapMs: gap, type: messageType(chunk), kb: Math.round(chunk.length / 1024), visible: this.visible() })
    }
    this.lastData = at
    this.quietRecorded = false
  }

  /** The page shown again. */
  shown(): void {
    this.deps.record('downlink-on-visible', { open: this.openedAt !== null, sinceDataMs: this.sinceData(), openMs: this.openedAt === null ? null : this.now() - this.openedAt })
  }

  private sinceData(): number | null {
    return this.lastData === null ? null : this.now() - this.lastData
  }

  private check(): void {
    if (this.openedAt === null || this.quietRecorded) return
    const since = this.sinceData()
    if (since === null || since < QUIET_MS) return
    this.quietRecorded = true
    this.deps.record('downlink-quiet', { sinceDataMs: since, visible: this.visible() })
  }
}

/** `transport`, its socket's life and every chunk from the Mac told to `watch`. */
export function watchedTransport(transport: ServerTransport, watch: DownlinkWatch): ServerTransport {
  return {
    ...transport,
    open: (handlers) => transport.open({
      ...handlers,
      onOpen: () => { watch.opened(); handlers.onOpen() },
      onClose: () => { watch.closed(); handlers.onClose() },
      onData: (chunk) => { watch.received(chunk); handlers.onData(chunk) },
    }),
  }
}
