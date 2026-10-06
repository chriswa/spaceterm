import type { MobileEventRecord } from '../shared/protocol'

/**
 * The phone's audio and lifecycle record: the microphone opening and closing,
 * the hold and hands-free mode, dictations, what the phone plays, the input
 * moving between AirPods and the phone, and the app going to the background
 * and coming back. Kept on the Mac in ~/.spaceterm/mobile-events.jsonl
 * (src/server/mobile-events.ts), appended forever, for tracing a microphone
 * that did not come back, or an answer that talked over a dictation.
 *
 * Unlike the log, nothing here is lost to a dropped socket or a page iOS
 * suspended or killed — which is exactly when it matters. Events wait in this
 * browser's storage until the server acknowledges them, and a page load that
 * died with some unsent sends them from the next.
 *
 * Each event carries `ctx`: the audio state of the page at that moment, from
 * whatever registered itself with `addContext` — so any one line says whether
 * the microphone was held, a dictation open, something playing.
 */

/** Events kept unsent before the oldest are dropped. */
const MAX_QUEUED = 3000
const BATCH = 200
/** A batch unacknowledged this long is taken to have failed, and sent again later. */
const SEND_TIMEOUT_MS = 15_000
const STORAGE_KEY = 'spaceterm:mobile-events'

export interface MobileEventsDeps {
  load(): string | null
  save(json: string): void
  now(): Date
  /** This page load's id. */
  page: string
}

const REAL_DEPS = (): MobileEventsDeps => ({
  load: () => { try { return localStorage.getItem(STORAGE_KEY) } catch { return null } },
  save: (json) => { try { localStorage.setItem(STORAGE_KEY, json) } catch { /* private mode, or full: memory only */ } },
  now: () => new Date(),
  page: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
})

export type Detail = Record<string, unknown>

export class MobileEvents {
  private queue: MobileEventRecord[] = []
  private next = 0
  private sending = false
  private dropped = 0
  private send: ((events: MobileEventRecord[]) => Promise<void>) | null = null
  private readonly ackListeners = new Set<(events: MobileEventRecord[]) => void>()
  private readonly context = new Map<string, () => unknown>()

  constructor(private readonly deps: MobileEventsDeps = REAL_DEPS()) {
    try {
      const saved = JSON.parse(deps.load() ?? '[]') as unknown
      if (Array.isArray(saved)) this.queue = saved as MobileEventRecord[]
    } catch { /* unreadable: start empty */ }
  }

  get page(): string {
    return this.deps.page
  }

  /** Something every event should say about the moment it was recorded. */
  addContext(name: string, read: () => unknown): void {
    this.context.set(name, read)
  }

  /**
   * Note an event. `src`/`t`: one the iPhone app saw, at its own time —
   * possibly while this page was suspended.
   */
  record(kind: string, detail?: Detail, from?: { src: 'native'; t: string; nativeSeq?: number }): void {
    const event: MobileEventRecord = {
      t: from?.t ?? this.deps.now().toISOString(),
      page: this.deps.page,
      n: this.next++,
      kind,
      src: from?.src ?? 'page',
      ...(from?.nativeSeq !== undefined ? { nativeSeq: from.nativeSeq } : {}),
      ...(detail && Object.keys(detail).length > 0 ? { detail } : {}),
      ctx: this.snapshot(),
    }
    this.queue.push(event)
    if (this.queue.length > MAX_QUEUED) {
      const over = this.queue.length - MAX_QUEUED
      this.queue.splice(0, over)
      this.dropped += over
    }
    this.persist()
    this.flush()
  }

  /** Where batches go: the server, once connected. Starts sending what has waited. */
  setSender(send: (events: MobileEventRecord[]) => Promise<void>): void {
    this.send = send
    this.flush()
  }

  /** Told of each batch the server has acknowledged: the app forgets its events then. */
  onAcknowledged(fn: (events: MobileEventRecord[]) => void): void {
    this.ackListeners.add(fn)
  }

  /** Send what is waiting, a batch at a time. Safe to call at any time; a failure waits for the next call. */
  flush(): void {
    if (this.sending || !this.send || this.queue.length === 0) return
    const batch = this.queue.slice(0, BATCH)
    this.sending = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timed out')), SEND_TIMEOUT_MS) })
    Promise.race([this.send(batch), timeout]).then(() => {
      const sent = new Set(batch)
      this.queue = this.queue.filter((e) => !sent.has(e))
      this.persist()
      this.sending = false
      for (const fn of this.ackListeners) fn(batch)
      if (this.dropped > 0) {
        const count = this.dropped
        this.dropped = 0
        this.record('events-dropped', { count })
      } else this.flush()
    }, () => {
      this.sending = false
    }).finally(() => clearTimeout(timer))
  }

  /** Waiting to be sent, for a test or a log line. */
  get pending(): number {
    return this.queue.length
  }

  private snapshot(): Detail {
    const out: Detail = {}
    for (const [name, read] of this.context) {
      try { out[name] = read() } catch (err) { out[name] = `error: ${err instanceof Error ? err.message : String(err)}` }
    }
    return out
  }

  private persist(): void {
    this.deps.save(JSON.stringify(this.queue))
  }
}

/** The page's one record. */
export const mobileEvents = new MobileEvents()

/** Note an audio or lifecycle event; see `MobileEvents`. */
export function recordMobileEvent(kind: string, detail?: Detail): void {
  mobileEvents.record(kind, detail)
}
