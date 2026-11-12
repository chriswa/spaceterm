import * as fs from 'fs'
import { join } from 'path'
import { SOCKET_DIR } from '../shared/protocol'
import { MAX_EVENT_PAYLOAD_BYTES, type AutomationEventOutcome, type AutomationEventRecord } from '../shared/automation'

/**
 * Every event scripts have sent: ~/.spaceterm/automation-events.jsonl, one JSON
 * record per line, kept across restarts for working out why a card did or did
 * not fire.
 *
 * Bounded both ways, because a client is sent the whole log when it opens it
 * and anything on the scripts socket can write here.
 */

export const AUTOMATION_EVENTS_PATH = join(SOCKET_DIR, 'automation-events.jsonl')

export const MAX_EVENT_LOG_ENTRIES = 500
export const MAX_EVENT_LOG_BYTES = 4 * 1024 * 1024

const MAX_EVENT_ID_CHARS = 200
const OVERSIZED_PREVIEW_CHARS = 2000

/** An event as the script sent it, before it has been made safe to keep. */
export interface IncomingAutomationEvent {
  /** Unvalidated: a rejected event's id may be anything JSON can hold. */
  eventId: unknown
  payload: unknown
  source?: string
  outcome: AutomationEventOutcome
}

export interface AutomationEventLogDeps {
  /** The whole file, or '' when there is none. */
  read(): string
  append(text: string): void
  /** Replace the whole file. */
  replace(text: string): void
}

/** Synchronous, so a compaction can never interleave with an append. Failing to write only loses history. */
const realDeps = (path: string): AutomationEventLogDeps => ({
  read() {
    try {
      return fs.readFileSync(path, 'utf8')
    } catch {
      return ''
    }
  },
  append(text) {
    try {
      fs.appendFileSync(path, text)
    } catch {
      // See above.
    }
  },
  replace(text) {
    const tmp = `${path}.${process.pid}.tmp`
    try {
      fs.writeFileSync(tmp, text)
      fs.renameSync(tmp, path)
    } catch {
      // See above.
    }
  }
})

interface Entry {
  record: AutomationEventRecord
  /** Its line in the file, newline included. */
  line: string
}

function toLine(record: AutomationEventRecord): string {
  return JSON.stringify(record) + '\n'
}

function parseLine(line: string): AutomationEventRecord | undefined {
  try {
    const r = JSON.parse(line) as Partial<AutomationEventRecord> | null
    const valid = typeof r?.seq === 'number' && typeof r.at === 'number' && typeof r.eventId === 'string' && typeof r.outcome?.kind === 'string'
    return valid ? (r as AutomationEventRecord) : undefined
  } catch {
    return undefined
  }
}

export class AutomationEventLog {
  private entries: Entry[] = []
  private nextSeq = 1
  private bytes = 0
  /** What the file holds, which runs ahead of `entries` until the next compaction. */
  private fileBytes = 0
  private fileLines = 0

  constructor(private readonly deps: AutomationEventLogDeps = realDeps(AUTOMATION_EVENTS_PATH)) {
    const text = deps.read()
    for (const line of text.split('\n')) {
      if (!line) continue
      this.fileLines++
      const record = parseLine(line)
      if (!record) continue
      this.entries.push({ record, line: line + '\n' })
      this.bytes += Buffer.byteLength(line) + 1
      this.nextSeq = Math.max(this.nextSeq, record.seq + 1)
    }
    this.fileBytes = Buffer.byteLength(text)
    this.trim()
    this.compactIfOverdue()
  }

  /** Oldest first. */
  list(): AutomationEventRecord[] {
    return this.entries.map((e) => e.record)
  }

  /** Keep an event, and return the record as it was kept. */
  record(event: IncomingAutomationEvent, at: number): AutomationEventRecord {
    const record: AutomationEventRecord = {
      seq: this.nextSeq++,
      at,
      eventId: keptEventId(event.eventId),
      ...keptPayload(event.payload),
      ...(event.source !== undefined ? { source: event.source } : {}),
      outcome: event.outcome
    }
    const line = toLine(record)
    const size = Buffer.byteLength(line)
    this.entries.push({ record, line })
    this.bytes += size
    this.trim()
    this.deps.append(line)
    this.fileBytes += size
    this.fileLines++
    this.compactIfOverdue()
    return record
  }

  private trim(): void {
    while (this.entries.length > 1 && (this.entries.length > MAX_EVENT_LOG_ENTRIES || this.bytes > MAX_EVENT_LOG_BYTES)) {
      this.bytes -= Buffer.byteLength(this.entries.shift()!.line)
    }
  }

  /** Rewritten only once the file has doubled, so an append is usually just an append. */
  private compactIfOverdue(): void {
    if (this.fileBytes <= 2 * MAX_EVENT_LOG_BYTES && this.fileLines <= 2 * MAX_EVENT_LOG_ENTRIES) return
    this.deps.replace(this.entries.map((e) => e.line).join(''))
    this.fileBytes = this.bytes
    this.fileLines = this.entries.length
  }
}

function keptEventId(eventId: unknown): string {
  const text = typeof eventId === 'string' ? eventId : String(JSON.stringify(eventId))
  return text.length > MAX_EVENT_ID_CHARS ? `${text.slice(0, MAX_EVENT_ID_CHARS)}…` : text
}

function keptPayload(payload: unknown): Pick<AutomationEventRecord, 'payload' | 'oversizedPayload'> {
  if (payload === undefined) return {}
  const json = JSON.stringify(payload)
  if (json.length <= MAX_EVENT_PAYLOAD_BYTES) return { payload }
  return { oversizedPayload: { preview: json.slice(0, OVERSIZED_PREVIEW_CHARS), bytes: Buffer.byteLength(json) } }
}
