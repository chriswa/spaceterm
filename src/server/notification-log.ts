import * as fs from 'fs'
import { join } from 'path'
import { SOCKET_DIR } from '../shared/protocol'
import type { NodeId } from '../shared/ids'
import type { NotificationKind, NotificationRecord } from '../shared/notifications'

/**
 * Every notification sent towards the user's phone, for the toolbar's history:
 * ~/.spaceterm/notifications.jsonl, one record per line, kept across restarts.
 * Only the newest `MAX_NOTIFICATIONS` are kept; the file is rewritten once it
 * holds twice that, so a send is usually just an append.
 */

export const NOTIFICATIONS_PATH = join(SOCKET_DIR, 'notifications.jsonl')
export const MAX_NOTIFICATIONS = 200
const BODY_CHARS = 300

export interface NotificationLogDeps {
  /** The whole file, or '' when there is none. */
  read(): string
  append(text: string): void
  /** Replace the whole file. */
  replace(text: string): void
}

/** Failing to write only loses history. */
const realDeps = (path: string): NotificationLogDeps => ({
  read() {
    try { return fs.readFileSync(path, 'utf8') } catch { return '' }
  },
  append(text) {
    try { fs.appendFileSync(path, text) } catch { /* See above. */ }
  },
  replace(text) {
    const tmp = `${path}.${process.pid}.tmp`
    try {
      fs.writeFileSync(tmp, text)
      fs.renameSync(tmp, path)
    } catch { /* See above. */ }
  },
})

const KINDS: ReadonlySet<string> = new Set<NotificationKind>(['permission', 'question', 'plan', 'manual'])

function parseLine(line: string): NotificationRecord | undefined {
  try {
    const r = JSON.parse(line) as Partial<NotificationRecord> | null
    const valid = typeof r?.seq === 'number' && typeof r.at === 'number' && typeof r.nodeId === 'string'
      && typeof r.kind === 'string' && KINDS.has(r.kind) && typeof r.title === 'string'
    return valid ? { body: '', reached: true, ...r } as NotificationRecord : undefined
  } catch {
    return undefined
  }
}

export interface IncomingNotification {
  nodeId: NodeId
  kind: NotificationKind
  title: string
  body: string
  reached: boolean
}

export class NotificationLog {
  private records: NotificationRecord[] = []
  private nextSeq = 1
  private fileLines = 0

  constructor(private readonly deps: NotificationLogDeps = realDeps(NOTIFICATIONS_PATH)) {
    for (const line of deps.read().split('\n')) {
      if (!line) continue
      this.fileLines++
      const record = parseLine(line)
      if (!record) continue
      this.records.push(record)
      this.nextSeq = Math.max(this.nextSeq, record.seq + 1)
    }
    this.records = this.records.slice(-MAX_NOTIFICATIONS)
    this.compactIfOverdue()
  }

  /** Oldest first. */
  list(): NotificationRecord[] {
    return [...this.records]
  }

  /** Keep a notification, and return the record as it was kept. */
  record(notification: IncomingNotification, at: number): NotificationRecord {
    const body = notification.body.length > BODY_CHARS ? `${notification.body.slice(0, BODY_CHARS - 1)}…` : notification.body
    const record: NotificationRecord = { seq: this.nextSeq++, at, ...notification, body }
    this.records.push(record)
    if (this.records.length > MAX_NOTIFICATIONS) this.records.shift()
    this.deps.append(JSON.stringify(record) + '\n')
    this.fileLines++
    this.compactIfOverdue()
    return record
  }

  private compactIfOverdue(): void {
    if (this.fileLines <= 2 * MAX_NOTIFICATIONS) return
    this.deps.replace(this.records.map((r) => JSON.stringify(r) + '\n').join(''))
    this.fileLines = this.records.length
  }
}
