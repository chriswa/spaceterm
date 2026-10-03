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

export function appendReceptionistLog(entry: Record<string, unknown>): void {
  try {
    fs.mkdirSync(RECEPTIONIST_DIR, { recursive: true })
    fs.appendFileSync(RECEPTIONIST_LOG, JSON.stringify({ timestamp: new Date().toISOString(), ...entry }) + '\n')
  } catch (err) {
    serverLog(`[receptionist] failed to append log: ${err instanceof Error ? err.message : String(err)}`)
  }
}
