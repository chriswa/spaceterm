import * as fs from 'fs'
import * as path from 'path'
import { SOCKET_DIR } from '../../shared/protocol'
import { askClaudePrint, ClaudePrintBusy } from '../claude-print'
import { serverLog } from '../server-log'
import { SessionBusy, type RecordedMessage, type SavedSession, type SessionAnswer, type SessionTurn } from './receptionist'
import { parseRecordBytes, spokenPart, transcriptPage, type NameOf, type RecordFile } from './transcript'
import type { ConsumedHow } from './consumption'
import type { HandleNames } from './transcript-names'
import type { ControlTrace, ControlTranscriptEntry } from '../../shared/protocol'

/**
 * The receptionist's real collaborators that are not the server's own state:
 * the model through claude-print-daemon, and its log. Side questions to
 * agents go through `side-questions.ts` instead.
 */

const RECEPTIONIST_DIR = path.join(SOCKET_DIR, 'receptionist')
/** Every turn, model step, and tool call, appended, for diagnosis. */
export const RECEPTIONIST_LOG = path.join(RECEPTIONIST_DIR, 'log.jsonl')

/**
 * Which model Control runs on, and how. One place, so a benchmark changes one
 * line. Sonnet with low thinking, on trial: the October 2026 benchmark had it
 * about 0.7s slower per turn than Haiku without thinking (1.78s median against
 * 1.05s) at roughly 1.3x the cost, traded for better judgement.
 */
export const RECEPTIONIST_MODEL = { model: 'sonnet', noThinking: false, effort: 'low' }

/**
 * Past this many tokens of context the daemon compacts Control's session.
 * Haiku reads a cached prefix fast, but every turn still pays for all of it.
 */
export const RECEPTIONIST_COMPACT_ABOVE_TOKENS = 40_000

export async function askReceptionistModel(turn: SessionTurn, signal: AbortSignal, abort?: AbortSignal): Promise<SessionAnswer> {
  const response = await askClaudePrint({
    prompt: turn.prompt,
    ...(turn.systemPrompt !== undefined ? { systemPrompt: turn.systemPrompt } : {}),
    ...(turn.sessionId ? { sessionId: turn.sessionId } : {}),
    ...RECEPTIONIST_MODEL,
    // Warm all day, compacted before the cache goes cold: see the daemon's
    // README. Not a session on its way out: left out, the daemon cancels its
    // compaction and lets its process go.
    ...(turn.retiring ? {} : {
      keepAlive: { minutes: 60, priority: true },
      autoCompact: { aboveTokens: RECEPTIONIST_COMPACT_ABOVE_TOKENS },
    }),
    tag: turn.retiring ? 'receptionist-handover' : 'receptionist',
    signal,
    ...(abort && turn.turnId ? { abort, turnId: turn.turnId } : {}),
  }).catch((err: unknown) => {
    throw err instanceof ClaudePrintBusy ? new SessionBusy(err.message) : err
  })
  return {
    text: response.result,
    sessionId: response.session_id,
    contextTokens: response.context_tokens,
    source: response.source,
    wallMs: response.wall_ms,
    costUsd: response.total_cost_usd,
    ...(response.next_compaction ? { compactsAt: Date.parse(response.next_compaction.at) } : {}),
    ...(response.abort ? { aborted: { promptInSession: response.abort.prompt_in_session } } : {}),
  }
}

/** Which Claude Code session Control is in, so a server restart picks up the same conversation. */
export const RECEPTIONIST_SESSION = path.join(RECEPTIONIST_DIR, 'session.json')
/**
 * Every message of Control's conversation, appended and never trimmed. The
 * session itself is compacted; this is the full record `recall` searches.
 */
export const RECEPTIONIST_CONVERSATION = path.join(RECEPTIONIST_DIR, 'conversation.jsonl')

const RECALL_HITS = 8
const RECALL_CONTEXT_CHARS = 400

type RecordMessage = { role: 'user' | 'assistant'; content: string }

export const REAL_RECEPTIONIST_SESSION = {
  load(): SavedSession | undefined {
    try {
      const parsed = JSON.parse(fs.readFileSync(RECEPTIONIST_SESSION, 'utf8')) as Partial<SavedSession>
      return typeof parsed.sessionId === 'string' && typeof parsed.promptHash === 'string'
        ? {
            sessionId: parsed.sessionId, promptHash: parsed.promptHash,
            ...(typeof parsed.compactsAt === 'number' ? { compactsAt: parsed.compactsAt } : {}),
          }
        : undefined
    } catch {
      return undefined
    }
  },
  save(session: SavedSession | undefined): void {
    try {
      if (!session) { fs.rmSync(RECEPTIONIST_SESSION, { force: true }); return }
      fs.mkdirSync(RECEPTIONIST_DIR, { recursive: true })
      const tmp = `${RECEPTIONIST_SESSION}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(session))
      fs.renameSync(tmp, RECEPTIONIST_SESSION)
    } catch (err) {
      serverLog(`[receptionist] failed to save session: ${err instanceof Error ? err.message : String(err)}`)
    }
  },
}

/** Enough of the record's end for `recent`: a few dozen messages. */
const RECENT_BYTES = 64 * 1024
/** The most of one line `spokenPart` reads. */
const LINE_BYTES = 256 * 1024

export const REAL_RECEPTIONIST_RECORD = {
  /** Returns the lines appended and where each starts, for the transcript view's live updates. */
  append(messages: readonly RecordedMessage[]): Array<{ line: string; offset: number }> {
    try {
      fs.mkdirSync(RECEPTIONIST_DIR, { recursive: true })
      const timestamp = new Date().toISOString()
      const lines = messages.map(message => JSON.stringify({ timestamp, ...message }))
      let offset = recordSize()
      fs.appendFileSync(RECEPTIONIST_CONVERSATION, lines.map(line => line + '\n').join(''))
      return lines.map(line => {
        const at = offset
        offset += Buffer.byteLength(line) + 1
        return { line, offset: at }
      })
    } catch (err) {
      serverLog(`[receptionist] failed to append conversation: ${err instanceof Error ? err.message : String(err)}`)
      return []
    }
  },
  /**
   * Marks a cut-off reply with how much of it was heard, for the transcript
   * view. A line with no role or content, so `recent` and `search` — what the
   * model sees of the record — pass over it. Returns it as `append` does.
   */
  amendHeard(replyAt: number, heard: number[], unread = false): Array<{ line: string; offset: number }> {
    return appendTranscriptOnly([{ heard: { of: replyAt, parts: heard, ...(unread ? { unread } : {}) } }])
  },
  /** What of a reply was taken in since — read, replayed, summed up — for the ledger and the transcript view: a line `recent` and `search` pass over, as `amendHeard`'s. */
  consumed(of: number, part: number, from: number, to: number, how: ConsumedHow): Array<{ line: string; offset: number }> {
    return appendTranscriptOnly([{ consumed: { of, part, from, to, how } }])
  },
  /** The record's last entries, as the transcript view reads them, to restore the consumption ledger after a restart. */
  tail(): ControlTranscriptEntry[] {
    let fd: number
    try { fd = fs.openSync(RECEPTIONIST_CONVERSATION, 'r') } catch { return [] }
    try {
      const size = fs.fstatSync(fd).size
      const start = Math.max(0, size - RECENT_BYTES)
      const buffer = Buffer.alloc(size - start)
      fs.readSync(fd, buffer, 0, buffer.length, start)
      return parseRecordBytes(buffer, start)
    } finally {
      fs.closeSync(fd)
    }
  },
  /** The reply line at byte `of`, as it was said: see `spokenPart`. */
  spokenPart(of: number, part: number): { intro: string; text: string; voice: string } | undefined {
    let fd: number
    try { fd = fs.openSync(RECEPTIONIST_CONVERSATION, 'r') } catch { return undefined }
    try {
      const size = fs.fstatSync(fd).size
      if (of < 0 || of >= size) return undefined
      // A reply line is a few kilobytes at most; read until its newline.
      const buffer = Buffer.alloc(Math.min(size - of, LINE_BYTES))
      fs.readSync(fd, buffer, 0, buffer.length, of)
      const end = buffer.indexOf(0x0a)
      return spokenPart(buffer.toString('utf8', 0, end < 0 ? buffer.length : end), part)
    } finally {
      fs.closeSync(fd)
    }
  },
  /** Actions that never ran, for the transcript view: lines `recent` and `search` pass over, as `amendHeard`'s. */
  notDone(actions: string[]): Array<{ line: string; offset: number }> {
    return appendTranscriptOnly(actions.map(notDone => ({ notDone })))
  },
  /** Why Control did or did not speak, for the transcript view: a line `recent` and `search` pass over, as `amendHeard`'s. */
  trace(trace: ControlTrace): Array<{ line: string; offset: number }> {
    return appendTranscriptOnly([{ trace }])
  },
  /** A page of the transcript view: see `transcriptPage`. */
  page(before: number | undefined, count: number, nameOf: NameOf): { entries: ControlTranscriptEntry[]; more: boolean } {
    let fd: number
    try { fd = fs.openSync(RECEPTIONIST_CONVERSATION, 'r') } catch { return { entries: [], more: false } }
    try {
      const file: RecordFile = {
        size: () => fs.fstatSync(fd).size,
        read: (start, length) => {
          const buffer = Buffer.alloc(length)
          fs.readSync(fd, buffer, 0, length, start)
          return buffer
        },
      }
      return transcriptPage(file, before, count, nameOf)
    } finally {
      fs.closeSync(fd)
    }
  },
  search(query: string): string {
    let raw: string
    try { raw = fs.readFileSync(RECEPTIONIST_CONVERSATION, 'utf8') } catch { return 'There is no earlier conversation on record.' }
    return searchConversation(raw, query)
  },
  recent(count: number): RecordMessage[] {
    let raw: string
    try { raw = readTail(RECEPTIONIST_CONVERSATION, RECENT_BYTES) } catch { return [] }
    return recentMessages(raw, count)
  },
}

/**
 * Feeds `names` whatever Control's record and log have gained since the last
 * call, so a transcript page costs only what is new. A file that shrank was
 * replaced, and is read again from the start.
 */
export class RecordNameScanner {
  private readonly scanned = new Map<string, number>()

  constructor(private readonly names: HandleNames) {}

  update(): void {
    for (const file of [RECEPTIONIST_CONVERSATION, RECEPTIONIST_LOG]) {
      try {
        const size = fs.statSync(file).size
        let from = this.scanned.get(file) ?? 0
        if (size < from) from = 0
        if (size === from) continue
        const fd = fs.openSync(file, 'r')
        try {
          const buffer = Buffer.alloc(size - from)
          fs.readSync(fd, buffer, 0, buffer.length, from)
          // Up to the last whole line: one being written is read next time.
          const end = buffer.lastIndexOf(0x0a) + 1
          this.names.learn(buffer.toString('utf8', 0, end))
          this.scanned.set(file, from + end)
        } finally {
          fs.closeSync(fd)
        }
      } catch { /* not there yet */ }
    }
  }
}

/**
 * Lines for the transcript view alone: no role or content, so what the model
 * sees of the record (`recent`, `search`) passes over them.
 */
function appendTranscriptOnly(fields: ReadonlyArray<Record<string, unknown>>): Array<{ line: string; offset: number }> {
  try {
    const timestamp = new Date().toISOString()
    const lines = fields.map(field => JSON.stringify({ timestamp, ...field }))
    let offset = recordSize()
    fs.appendFileSync(RECEPTIONIST_CONVERSATION, lines.map(line => line + '\n').join(''))
    return lines.map(line => {
      const at = offset
      offset += Buffer.byteLength(line) + 1
      return { line, offset: at }
    })
  } catch (err) {
    serverLog(`[receptionist] failed to append to the transcript: ${err instanceof Error ? err.message : String(err)}`)
    return []
  }
}

function recordSize(): number {
  try { return fs.statSync(RECEPTIONIST_CONVERSATION).size } catch { return 0 }
}

function readTail(file: string, bytes: number): string {
  const fd = fs.openSync(file, 'r')
  try {
    const size = fs.fstatSync(fd).size
    const start = Math.max(0, size - bytes)
    const buffer = Buffer.alloc(size - start)
    fs.readSync(fd, buffer, 0, buffer.length, start)
    return buffer.toString('utf8')
  } finally {
    fs.closeSync(fd)
  }
}

/** The last `count` messages of the record, oldest first. A line cut off by reading from the middle is skipped. */
export function recentMessages(raw: string, count: number): RecordMessage[] {
  const messages: RecordMessage[] = []
  for (const line of raw.split('\n')) {
    try {
      const entry = JSON.parse(line) as Partial<RecordMessage>
      if ((entry.role === 'user' || entry.role === 'assistant') && typeof entry.content === 'string') {
        messages.push({ role: entry.role, content: entry.content })
      }
    } catch { /* blank, or the partial first line */ }
  }
  return messages.slice(-count)
}

/** The `recall` search over the conversation record, newest first. Split out to be tested on text. */
export function searchConversation(raw: string, query: string): string {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  const lines = raw.split('\n').filter(Boolean)
  const hits: string[] = []
  for (let i = lines.length - 1; i >= 0 && hits.length < RECALL_HITS; i--) {
    let entry: { timestamp?: string; role?: string; content?: string }
    try { entry = JSON.parse(lines[i]) } catch { continue }
    const text = entry.content ?? ''
    const lower = text.toLowerCase()
    const at = terms.map(term => lower.indexOf(term)).filter(index => index >= 0).sort((a, b) => a - b)[0]
    if (at === undefined) continue
    const start = Math.max(0, at - RECALL_CONTEXT_CHARS / 2)
    const excerpt = text.slice(start, start + RECALL_CONTEXT_CHARS).replace(/\s+/g, ' ')
    const who = entry.role === 'user' ? 'USER' : 'CONTROL'
    hits.push(`${entry.timestamp ?? '?'} ${who}: ${start > 0 ? '…' : ''}${excerpt}${start + RECALL_CONTEXT_CHARS < text.length ? '…' : ''}`)
  }
  return hits.length ? hits.join('\n\n') : `Nothing in the conversation record mentions "${query}".`
}

export function appendReceptionistLog(entry: Record<string, unknown>): void {
  try {
    fs.mkdirSync(RECEPTIONIST_DIR, { recursive: true })
    fs.appendFileSync(RECEPTIONIST_LOG, JSON.stringify({ timestamp: new Date().toISOString(), ...entry }) + '\n')
  } catch (err) {
    serverLog(`[receptionist] failed to append log: ${err instanceof Error ? err.message : String(err)}`)
  }
}
