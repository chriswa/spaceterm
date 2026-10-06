import { appendFile, closeSync, fstatSync, openSync, readSync } from 'fs'
import { join } from 'path'
import { SOCKET_DIR, type MobileEventRecord } from '../shared/protocol'

/**
 * The phone's audio and lifecycle record: every microphone, dictation,
 * playback and app-switching event the phone saw (src/mobile/mobile-events.ts),
 * one JSON object per line in ~/.spaceterm/mobile-events.jsonl, appended
 * forever. For tracing a microphone that did not come back, or an answer that
 * talked over a dictation, after the fact.
 *
 * The phone resends a batch it never saw acknowledged, so a batch can arrive
 * twice; each page load numbers its events, and anything at or below the
 * highest number already written for that page load is skipped.
 */

export const MOBILE_EVENTS_PATH = join(SOCKET_DIR, 'mobile-events.jsonl')

/** Bounds on what one batch may write: the phone is trusted, but not to be sane forever. */
const MAX_BATCH = 500
const MAX_LINE = 8000

/** How much of the file's end to read at start, for the last app event already written. */
const TAIL_BYTES = 512 * 1024

export interface MobileEventsDeps {
  append(text: string): void
  now(): Date
  /** The end of what is already written, or '' when there is none. */
  readTail(): string
}

function readTail(): string {
  try {
    const fd = openSync(MOBILE_EVENTS_PATH, 'r')
    try {
      const size = fstatSync(fd).size
      const length = Math.min(size, TAIL_BYTES)
      const buffer = Buffer.alloc(length)
      readSync(fd, buffer, 0, length, size - length)
      return buffer.toString('utf8')
    } finally {
      closeSync(fd)
    }
  } catch {
    return ''
  }
}

const REAL_DEPS: MobileEventsDeps = {
  append: (text) => appendFile(MOBILE_EVENTS_PATH, text, () => {}),
  now: () => new Date(),
  readTail,
}

export class MobileEventsLog {
  /** Highest event number written, per page load. */
  private readonly written = new Map<string, number>()
  /** Highest app event number written: the app hands each new page what it still holds. */
  private nativeWritten = 0
  /** For the server's own lines, which are a page load of their own. */
  private readonly serverPage: string
  private serverN = 0

  constructor(private readonly deps: MobileEventsDeps = REAL_DEPS) {
    this.serverPage = `server-${deps.now().toISOString()}`
    // The app resends whatever it never heard was written, across server restarts too.
    for (const match of deps.readTail().matchAll(/"nativeSeq":(\d+)/g)) {
      this.nativeWritten = Math.max(this.nativeWritten, Number(match[1]))
    }
  }

  /**
   * What the server itself saw of a phone — its connection coming and going,
   * speech it sent — which the phone, asleep, cannot say.
   */
  server(kind: string, client: string, detail?: Record<string, unknown>): void {
    const line: MobileEventRecord & { receivedAt: string; client: string } = {
      t: this.deps.now().toISOString(), page: this.serverPage, n: this.serverN++, kind, src: 'server',
      ...(detail ? { detail } : {}), receivedAt: this.deps.now().toISOString(), client,
    }
    this.deps.append(JSON.stringify(line) + '\n')
  }

  /** Append a batch from one client; `client` names it in each line. */
  write(events: unknown, client: string): void {
    if (!Array.isArray(events)) return
    const at = this.deps.now().toISOString()
    let text = ''
    for (const raw of events.slice(0, MAX_BATCH)) {
      if (!isRecord(raw)) continue
      const last = this.written.get(raw.page) ?? -1
      if (raw.n <= last) continue
      this.written.set(raw.page, raw.n)
      if (typeof raw.nativeSeq === 'number') {
        if (raw.nativeSeq <= this.nativeWritten) continue
        this.nativeWritten = raw.nativeSeq
      }
      let line = JSON.stringify({ ...raw, receivedAt: at, client })
      if (line.length > MAX_LINE) line = JSON.stringify({ t: raw.t, page: raw.page, n: raw.n, kind: raw.kind, src: raw.src, receivedAt: at, client, truncated: line.length })
      text += line + '\n'
    }
    if (text) this.deps.append(text)
  }
}

function isRecord(raw: unknown): raw is MobileEventRecord {
  if (typeof raw !== 'object' || raw === null) return false
  const r = raw as Record<string, unknown>
  return typeof r.t === 'string' && typeof r.page === 'string' && typeof r.n === 'number' && typeof r.kind === 'string'
}
