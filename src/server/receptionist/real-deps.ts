import * as fs from 'fs'
import * as path from 'path'
import { SOCKET_DIR } from '../../shared/protocol'
import { askClaudePrint, ClaudePrintBusy } from '../claude-print'
import { serverLog } from '../server-log'
import { SessionBusy, type SavedSession, type SessionAnswer, type SessionTurn } from './receptionist'

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

export async function askReceptionistModel(turn: SessionTurn, signal: AbortSignal): Promise<SessionAnswer> {
  const response = await askClaudePrint({
    prompt: turn.prompt,
    systemPrompt: turn.systemPrompt,
    ...(turn.sessionId ? { sessionId: turn.sessionId } : {}),
    ...RECEPTIONIST_MODEL,
    // Warm all day, compacted before the cache goes cold: see the daemon's README.
    keepAlive: { minutes: 60, priority: true },
    autoCompact: { aboveTokens: RECEPTIONIST_COMPACT_ABOVE_TOKENS },
    tag: 'receptionist',
    signal,
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

export const REAL_RECEPTIONIST_RECORD = {
  append(messages: readonly RecordMessage[]): void {
    try {
      fs.mkdirSync(RECEPTIONIST_DIR, { recursive: true })
      const timestamp = new Date().toISOString()
      fs.appendFileSync(RECEPTIONIST_CONVERSATION, messages.map(message => JSON.stringify({ timestamp, ...message }) + '\n').join(''))
    } catch (err) {
      serverLog(`[receptionist] failed to append conversation: ${err instanceof Error ? err.message : String(err)}`)
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
