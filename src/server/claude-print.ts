import { spawn } from 'child_process'

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
  /**
   * Fork this Claude Code session, filed under `cwd`, and ask the copy. The
   * source transcript is never written to; the copy runs with no tools, so it
   * can only answer from the conversation. Exclusive with `sessionId`.
   */
  fork?: { sessionId: string; cwd: string }
  /** Disable extended thinking. The daemon's warm Haiku spare has it off. */
  noThinking?: boolean
  /** Names the caller in the daemon's usage log, which is where cost is tracked. */
  tag: string
  /** Kills the CLI. The daemon still finishes the turn it started. */
  signal?: AbortSignal
}

export interface ClaudePrintResponse {
  session_id: string
  /** `spare`, `live`, `cold`, `resume` or `fork`: how the turn got its process. */
  source: string
  /** The session a fork was copied from. */
  forked_from?: string
  model: string
  result: string
  is_error: boolean
  total_cost_usd: number
  wall_ms: number
}

export function askClaudePrint(req: ClaudePrintRequest): Promise<ClaudePrintResponse> {
  const args = ['ask', '--tag', req.tag]
  if (req.model) args.push('-m', req.model)
  if (req.sessionId) args.push('-s', req.sessionId)
  if (req.fork) args.push('--fork', req.fork.sessionId, '--cwd', req.fork.cwd)
  if (req.noThinking) args.push('--no-thinking')
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
