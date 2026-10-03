import { spawn } from 'child_process'
import type { NodeId } from '../../shared/ids'
import type { ForkClient } from './receptionist'

/**
 * Forks of a live Claude surface, launched exactly as the surface was.
 *
 * A fork exists to ask an agent a question cheaply, and it is cheap only when
 * it reads the source's prompt cache. The cache matches an exact prefix —
 * model, tool definitions, system prompt, then messages — so the fork has to
 * be the surface's own command line: same CLI flags, plugin, model and working
 * directory. A fork with its own profile (no tools, empty system prompt, a
 * model named some other way) misses from the first byte and re-writes the
 * whole conversation; that is what made the first fork cost $1.51, and what
 * made a 255k-token session too long for the context window it ended up in.
 *
 * The only difference allowed is in `--settings`, which never reaches the
 * prompt: a guard hook that lets only read-only tools run. See
 * `fork-read-only-guard.sh`.
 */

/** A surface's command line, with the guard already in its settings. */
export interface ForkLaunch {
  cwd: string
  command: string
  args: string[]
  env: NodeJS.ProcessEnv
}

/** What `claude -p --output-format json` reports, reduced to what a fork needs. */
export interface PrintResult {
  sessionId: string
  result: string
  isError: boolean
  costUsd?: number
}

export interface SessionForkDeps {
  /** Run one `claude -p` turn, the prompt on stdin. */
  run(launch: ForkLaunch, args: string[], prompt: string): Promise<PrintResult>
}

/** A fork that has not answered in this long is killed; a turn reading a long session takes seconds. */
const FORK_TIMEOUT_MS = 180_000

export const REAL_SESSION_FORK_DEPS: SessionForkDeps = {
  run(launch, args, prompt) {
    return new Promise((resolve, reject) => {
      const child = spawn(launch.command, [...launch.args, ...args], {
        cwd: launch.cwd, env: launch.env, stdio: ['pipe', 'pipe', 'pipe'], timeout: FORK_TIMEOUT_MS,
      })
      let stdout = ''
      let stderr = ''
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk })
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
      child.on('error', reject)
      child.on('close', (code) => {
        try {
          const parsed = JSON.parse(stdout) as { session_id: string; result?: string; is_error?: boolean; total_cost_usd?: number }
          resolve({
            sessionId: parsed.session_id, result: parsed.result ?? '', isError: parsed.is_error === true,
            costUsd: parsed.total_cost_usd,
          })
        } catch {
          reject(new Error(`claude exited ${code}: ${(stderr || stdout).trim().slice(0, 300)}`))
        }
      })
      child.stdin.end(prompt)
    })
  },
}

export class SessionForks implements ForkClient {
  /** How to reach each fork again: its source surface's launch, captured when it was made. */
  private readonly launches = new Map<string, ForkLaunch>()

  constructor(
    private readonly launchFor: (nodeId: NodeId) => ForkLaunch | undefined,
    private readonly deps: SessionForkDeps = REAL_SESSION_FORK_DEPS,
  ) {}

  async fork({ nodeId, sessionId, prompt }: { nodeId: NodeId; sessionId: string; prompt: string }): Promise<{ forkId: string; answer: string }> {
    const launch = this.launchFor(nodeId)
    if (!launch) throw new Error('that agent is not a live Claude surface')
    const result = await this.deps.run(launch, ['-p', '--resume', sessionId, '--fork-session', '--output-format', 'json'], prompt)
    if (result.isError) throw new Error(result.result || 'the fork reported an error')
    // Captured, not looked up again: a follow-up must resume the copy the way
    // it was made, even if the surface's arguments have changed since.
    this.launches.set(result.sessionId, launch)
    return { forkId: result.sessionId, answer: result.result }
  }

  async ask({ forkId, prompt }: { forkId: string; prompt: string }): Promise<{ forkId: string; answer: string }> {
    const launch = this.launches.get(forkId)
    if (!launch) throw new Error(`fork ${forkId} is not one this server made`)
    const result = await this.deps.run(launch, ['-p', '--resume', forkId, '--output-format', 'json'], prompt)
    if (result.isError) throw new Error(result.result || 'the fork reported an error')
    return { forkId, answer: result.result }
  }
}
