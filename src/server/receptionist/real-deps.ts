import * as fs from 'fs'
import * as path from 'path'
import { SOCKET_DIR } from '../../shared/protocol'
import { askClaudePrint } from '../claude-print'
import { serverLog } from '../server-log'
import { renderModelRequest, type ModelAnswer, type ModelRequest } from '../summary-chat'

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

/** Control's conversation, so a server restart does not wipe what was said. */
export const RECEPTIONIST_HISTORY = path.join(RECEPTIONIST_DIR, 'history.json')

export const REAL_RECEPTIONIST_HISTORY = {
  load(): Array<{ role: 'user' | 'assistant'; content: string }> | undefined {
    try {
      const parsed = JSON.parse(fs.readFileSync(RECEPTIONIST_HISTORY, 'utf8')) as { messages?: unknown }
      if (!Array.isArray(parsed.messages)) return undefined
      return parsed.messages.filter((message): message is { role: 'user' | 'assistant'; content: string } =>
        typeof message === 'object' && message !== null
        && (message.role === 'user' || message.role === 'assistant') && typeof message.content === 'string')
    } catch {
      return undefined
    }
  },
  save(messages: ReadonlyArray<{ role: 'user' | 'assistant'; content: string }>): void {
    try {
      fs.mkdirSync(RECEPTIONIST_DIR, { recursive: true })
      // Atomic, so a crash mid-write leaves the last good conversation rather than a torn one.
      const tmp = `${RECEPTIONIST_HISTORY}.tmp`
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, messages }))
      fs.renameSync(tmp, RECEPTIONIST_HISTORY)
    } catch (err) {
      serverLog(`[receptionist] failed to save history: ${err instanceof Error ? err.message : String(err)}`)
    }
  },
}

export function appendReceptionistLog(entry: Record<string, unknown>): void {
  try {
    fs.mkdirSync(RECEPTIONIST_DIR, { recursive: true })
    fs.appendFileSync(RECEPTIONIST_LOG, JSON.stringify({ timestamp: new Date().toISOString(), ...entry }) + '\n')
  } catch (err) {
    serverLog(`[receptionist] failed to append log: ${err instanceof Error ? err.message : String(err)}`)
  }
}
