import { spawn } from 'child_process'
import { createHash } from 'crypto'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

/**
 * Client for claude-print-daemon (~/research/claude-print-daemon), which keeps
 * `claude -p` processes started and waiting so a reply costs roughly the API's
 * own latency rather than Claude Code's startup.
 *
 * Calls go through the daemon's `ask` CLI, not its socket, because the CLI
 * starts the daemon when it is not running. The CLI is a Go binary, so the
 * extra process costs milliseconds.
 */
export const CLAUDE_PRINT_BIN = process.env.CLAUDE_PRINT_DAEMON_BIN ?? 'claude-print-daemon'

export interface ClaudePrintRequest {
  prompt: string
  /** Model alias or id, e.g. `haiku`. The daemon defaults to Haiku. */
  model?: string
  /** Continue this Claude Code session rather than starting one. */
  sessionId?: string
  /** Disable extended thinking. The daemon's warm Haiku spare has it off. */
  noThinking?: boolean
  /** Effort level (`low`, `medium`, …); the daemon defaults to medium. */
  effort?: string
  /** The system prompt of a new session. Ignored when continuing one. */
  systemPrompt?: string
  /**
   * Keep the session's process live this long after the turn (at most an hour)
   * instead of the daemon's default, and exempt it from eviction when the
   * daemon holds too many. For a conversation that should stay fast all day.
   */
  keepAlive?: { minutes: number; priority: boolean }
  /**
   * Compact the session just before its prompt cache expires (55 minutes after
   * this turn, unless another turn comes first), and whenever its context
   * grows past `aboveTokens`.
   */
  autoCompact?: { aboveTokens: number }
  /** Names the caller in the daemon's usage log, which is where cost is tracked. */
  tag: string
  /** Kills the CLI. The daemon still finishes the turn it started. */
  signal?: AbortSignal
}

export interface ClaudePrintResponse {
  session_id: string
  /** `spare`, `live`, `cold` or `resume`: how the turn got its process. */
  source: string
  model: string
  result: string
  is_error: boolean
  total_cost_usd: number
  wall_ms: number
  /** The session's context after the turn. */
  context_tokens?: number
  /** This turn's tokens, as the API reported them. */
  usage?: {
    input_tokens?: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
    output_tokens?: number
    output_tokens_details?: { thinking_tokens?: number }
  }
}

export function askClaudePrint(req: ClaudePrintRequest): Promise<ClaudePrintResponse> {
  const args = ['ask', '--tag', req.tag]
  if (req.model) args.push('-m', req.model)
  if (req.sessionId) args.push('-s', req.sessionId)
  if (req.noThinking) args.push('--no-thinking')
  if (req.effort) args.push('-e', req.effort)
  if (req.systemPrompt !== undefined && !req.sessionId) args.push('--system-file', systemPromptFile(req.systemPrompt))
  if (req.keepAlive) {
    args.push('--keep-alive', `${req.keepAlive.minutes}m`)
    if (req.keepAlive.priority) args.push('--priority')
  }
  if (req.autoCompact) args.push('--auto-compact', '--compact-above', String(req.autoCompact.aboveTokens))
  return new Promise((resolve, reject) => {
    const child = spawn(CLAUDE_PRINT_BIN, args, { stdio: ['pipe', 'pipe', 'pipe'], signal: req.signal })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) {
        // stderr carries the daemon's reason, which names the session and
        // how far it got; see ~/.claude-print-daemon/daemon.log for the rest.
        reject(new Error(`${CLAUDE_PRINT_BIN} exited ${code}: ${(stderr || stdout).trim()}`))
        return
      }
      try {
        const response = JSON.parse(stdout) as ClaudePrintResponse
        if (response.is_error) reject(new Error(`claude reported an error in session ${response.session_id}: ${response.result}`))
        else resolve(response)
      } catch {
        reject(new Error(`${CLAUDE_PRINT_BIN} printed unparseable output: ${stdout.slice(0, 200)}`))
      }
    })
    // The prompt goes over stdin so its size and quoting never meet a command line.
    child.stdin.end(req.prompt)
  })
}

/**
 * A system prompt as a file, for the daemon's `--system-file`. Named by its
 * content, so the same prompt is one file however many sessions start on it.
 */
function systemPromptFile(prompt: string): string {
  const file = path.join(os.tmpdir(), `claude-print-system-${createHash('sha256').update(prompt).digest('hex').slice(0, 16)}.txt`)
  if (!fs.existsSync(file)) fs.writeFileSync(file, prompt)
  return file
}
