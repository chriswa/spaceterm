import { spawn } from 'child_process'
import { createHash } from 'crypto'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

/**
 * Client for claude-print-daemon (chriswa-devkit's tools/claude-print-daemon), which keeps
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
  /**
   * The session's system prompt. It is fixed when the session starts: Claude
   * Code stores it with the transcript, and a resumed process ignores a new one.
   * Sent when continuing a session, it must be the session's own, or the
   * daemon refuses the request; left out, the session keeps its own.
   */
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
  /** Kills the CLI. The daemon still finishes the turn it started: to stop it, use `abort`. */
  signal?: AbortSignal
  /**
   * Stops the turn in the daemon where it is (`claude-print-daemon abort`),
   * and the response comes back at once with `abort` set. Needs `turnId`.
   */
  abort?: AbortSignal
  /** Names the turn, for `abort`. */
  turnId?: string
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
  /** What this turn arranged: a compaction started now (`size`), or scheduled for `at` (`auto`). */
  next_compaction?: { trigger: 'auto' | 'size'; at: string }
  /**
   * Set when the turn was aborted, and `result` is then empty. An abort is
   * not a rewind: with `prompt_in_session`, the session keeps the prompt and
   * its interrupted answer, and the next turn follows them; without, the
   * prompt was never sent.
   */
  abort?: { prompt_in_session: boolean }
}

/**
 * The session is still running an earlier turn — one whose caller may have
 * gone, since the daemon finishes a turn it started regardless.
 */
export class ClaudePrintBusy extends Error {}

export function askClaudePrint(req: ClaudePrintRequest): Promise<ClaudePrintResponse> {
  const args = ['ask', '--tag', req.tag]
  if (req.model) args.push('-m', req.model)
  if (req.sessionId) args.push('-s', req.sessionId)
  if (req.noThinking) args.push('--no-thinking')
  if (req.effort) args.push('-e', req.effort)
  if (req.systemPrompt !== undefined) args.push('--system-file', systemPromptFile(req.systemPrompt))
  if (req.keepAlive) {
    args.push('--keep-alive', `${req.keepAlive.minutes}m`)
    if (req.keepAlive.priority) args.push('--priority')
  }
  if (req.autoCompact) args.push('--auto-compact', '--compact-above', String(req.autoCompact.aboveTokens))
  if (req.turnId) args.push('--turn-id', req.turnId)
  const { abort, turnId } = req
  const onAbort = () => { if (turnId) abortClaudePrint(turnId) }
  if (abort?.aborted) onAbort()
  else abort?.addEventListener('abort', onAbort, { once: true })
  return new Promise<ClaudePrintResponse>((resolve, reject) => {
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
        const reason = `${CLAUDE_PRINT_BIN} exited ${code}: ${(stderr || stdout).trim()}`
        reject(/409 Conflict/.test(stderr) ? new ClaudePrintBusy(reason) : new Error(reason))
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
  }).finally(() => abort?.removeEventListener('abort', onAbort))
}

/**
 * Stop a named turn where it is; its `ask` then returns with `abort` set. An
 * abort that reaches the daemon before its turn does still stops it. Fails
 * quietly: a turn that cannot be stopped finishes, and is dropped by its caller.
 */
export function abortClaudePrint(turnId: string): void {
  const child = spawn(CLAUDE_PRINT_BIN, ['abort', turnId], { stdio: 'ignore' })
  child.on('error', () => undefined)
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
