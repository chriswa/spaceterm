import * as fs from 'fs'
import * as path from 'path'
import { SOCKET_DIR } from '../../shared/protocol'
import { askClaudePrint } from '../claude-print'
import { serverLog } from '../server-log'
import { renderModelRequest, type ModelAnswer, type ModelRequest } from '../summary-chat'
import type { SavedConversation } from './receptionist'

/**
 * The receptionist's real collaborators that are not the server's own state:
 * Haiku through claude-print-daemon, and its log. Forks are `SessionForks`,
 * which launch the surface's own command line rather than a daemon profile.
 */

const RECEPTIONIST_DIR = path.join(SOCKET_DIR, 'receptionist')
/**
 * Every turn, model step, and tool call, appended. Nothing reads it yet; it is
 * where "what did I send Kevin last night" will be answered from.
 */
export const RECEPTIONIST_LOG = path.join(RECEPTIONIST_DIR, 'log.jsonl')

export async function askReceptionistModel(request: ModelRequest, signal: AbortSignal): Promise<ModelAnswer> {
  const response = await askClaudePrint({
    prompt: renderModelRequest(request),
    model: 'haiku',
    noThinking: true,
    tag: 'receptionist',
    signal,
  })
  return {
    text: response.result,
    claudeSessionId: response.session_id,
    source: response.source,
    wallMs: response.wall_ms,
    costUsd: response.total_cost_usd,
  }
}

/**
 * Control's working memory — the recent window and the summary of what aged
 * out of it — so a server restart does not wipe what was said.
 */
export const RECEPTIONIST_HISTORY = path.join(RECEPTIONIST_DIR, 'history.json')
/**
 * Every message of Control's conversation, appended and never trimmed. The
 * working memory is bounded and compacted; this is the full record `recall`
 * searches.
 */
export const RECEPTIONIST_CONVERSATION = path.join(RECEPTIONIST_DIR, 'conversation.jsonl')

const RECALL_HITS = 8
const RECALL_CONTEXT_CHARS = 400

type HistoryMessage = SavedConversation['messages'][number]

function isMessage(value: unknown): value is HistoryMessage {
  if (typeof value !== 'object' || value === null) return false
  const message = value as Record<string, unknown>
  return (message.role === 'user' || message.role === 'assistant') && typeof message.content === 'string'
}

export const REAL_RECEPTIONIST_HISTORY = {
  load(): SavedConversation | undefined {
    try {
      const parsed = JSON.parse(fs.readFileSync(RECEPTIONIST_HISTORY, 'utf8')) as { messages?: unknown; summary?: unknown }
      if (!Array.isArray(parsed.messages)) return undefined
      return {
        messages: parsed.messages.filter(isMessage),
        summary: typeof parsed.summary === 'string' ? parsed.summary : '',
      }
    } catch {
      return undefined
    }
  },
  save(state: SavedConversation): void {
    try {
      fs.mkdirSync(RECEPTIONIST_DIR, { recursive: true })
      // Atomic, so a crash mid-write leaves the last good state rather than a torn one.
      const tmp = `${RECEPTIONIST_HISTORY}.tmp`
      fs.writeFileSync(tmp, JSON.stringify({ version: 2, ...state }))
      fs.renameSync(tmp, RECEPTIONIST_HISTORY)
    } catch (err) {
      serverLog(`[receptionist] failed to save history: ${err instanceof Error ? err.message : String(err)}`)
    }
  },
  append(messages: readonly HistoryMessage[]): void {
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
