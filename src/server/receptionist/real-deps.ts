import * as fs from 'fs'
import * as path from 'path'
import { SOCKET_DIR } from '../../shared/protocol'
import { askClaudePrint } from '../claude-print'
import { serverLog } from '../server-log'
import { renderModelRequest, type ModelAnswer, type ModelRequest } from '../summary-chat'
import type { ForkClient } from './receptionist'

/**
 * The receptionist's real collaborators that are not the server's own state:
 * Haiku and session forks through claude-print-daemon, and its log.
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

export const REAL_FORK_CLIENT: ForkClient = {
  async fork({ sessionId, cwd, prompt, model }) {
    const response = await askClaudePrint({
      prompt, fork: { sessionId, cwd }, ...(model ? { model } : {}), tag: 'receptionist-fork',
    })
    return { forkId: response.session_id, answer: response.result }
  },
  async ask({ forkId, prompt }) {
    const response = await askClaudePrint({ prompt, sessionId: forkId, tag: 'receptionist-fork' })
    return { forkId: response.session_id, answer: response.result }
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
