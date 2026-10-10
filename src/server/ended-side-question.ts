import { spawn } from 'child_process'
import * as fs from 'fs'
import { readClaudeCacheTouch } from './claude-cache-warmth'
import { serverLog } from './server-log'
import { ANSWER_TIMEOUT_MS, type SideQuestionResult, type SideQuestionUsage } from './side-questions'
import { scrubInheritedAgentEnv } from './spawn-env'

/**
 * Side questions to an agent whose session has ended, while its prompt cache
 * is still warm.
 *
 * A live agent is asked through its own process (`side-questions.ts`), which
 * replays the request it holds in memory. An ended agent has no process, and
 * nothing outside Claude Code can rebuild that request byte for byte — which
 * is what reading the cache takes. So Claude Code rebuilds it: a headless
 * `claude -p --resume --fork-session` of the session, asked the question once.
 *
 * Measured on an ended interactive Opus 5.5 session, 37 minutes after it ended:
 * the headless request read all 51,632 tokens of its last request from the
 * cache and wrote only the question and what a resume injects (about 1,500).
 *
 * Nothing about the request's prefix may change, or the cache is missed and
 * the whole conversation is paid for again. That rules out the obvious ways
 * to take the tools away — `--tools` and `--disallowedTools` change the tool
 * list, which is the very start of the request. Tools are refused by a hook
 * instead, which the model never sees, and `--max-turns 1` ends the turn at
 * the first refusal. `--no-session-persistence` keeps the fork off disk, so
 * the agent's own transcript and the list of sessions are left as they were.
 */

/** What resuming an ended agent's session takes. */
export interface EndedSession {
  claudeSessionId: string
  /** Claude Code finds a session by the directory it ran in. */
  cwd: string
  /** Read for the model and effort the session last ran at: a different model is a different cache. */
  transcriptPath?: string
}

export interface EndedAnswer {
  result: SideQuestionResult
  /** epoch ms — when the agent's cache goes cold now that the question has touched it, when the request said. */
  cacheWarmUntil?: number
}

export interface EndedAskDeps {
  /** Run `claude` with these arguments and stdin, in `cwd`. Rejects only when it could not be started. */
  runClaude(args: readonly string[], stdin: string, cwd: string, timeoutMs: number): Promise<{ stdout: string; stderr: string; timedOut: boolean }>
  /** The end of the session's transcript, enough to hold its last request. */
  transcriptTail(path: string): string
}

/** Refuse every tool call, without changing what the model is sent. */
export const NO_TOOLS_SETTINGS = JSON.stringify({
  hooks: {
    PreToolUse: [{
      matcher: '*',
      hooks: [{ type: 'command', command: 'echo "side question: tools are off" >&2; exit 2' }],
    }],
  },
})

export async function askEndedSession(
  session: EndedSession,
  prompt: string,
  deps: EndedAskDeps,
  now: () => number = Date.now,
  timeoutMs = ANSWER_TIMEOUT_MS,
): Promise<EndedAnswer> {
  const settings = session.transcriptPath ? lastRequestSettings(deps.transcriptTail(session.transcriptPath)) : {}
  const args = [
    '-p', '--resume', session.claudeSessionId, '--fork-session', '--no-session-persistence',
    '--max-turns', '1', '--output-format', 'json', '--settings', NO_TOOLS_SETTINGS,
    ...(settings.model ? ['--model', settings.model] : []),
    ...(settings.effort ? ['--effort', settings.effort] : []),
  ]
  const started = now()
  let run: Awaited<ReturnType<EndedAskDeps['runClaude']>>
  try {
    run = await deps.runClaude(args, prompt, session.cwd, timeoutMs)
  } catch (err) {
    return { result: { ok: false, reason: 'resume-failed', detail: err instanceof Error ? err.message : String(err) } }
  }
  if (run.timedOut) return { result: { ok: false, reason: 'timeout' } }
  const answer = readPrintResult(run.stdout, run.stderr, now() - started, now())
  const usage = answer.usage
  serverLog(`[side-questions] ended session ${session.claudeSessionId.slice(0, 8)}: ${answer.result.ok ? 'answered' : answer.result.reason}, ` +
    (usage ? `cache read ${usage.cache_read_input_tokens ?? 0}, written ${usage.cache_creation_input_tokens ?? 0}, uncached ${usage.input_tokens ?? 0}` : 'no usage reported'))
  return { result: answer.result, ...(answer.cacheWarmUntil !== undefined ? { cacheWarmUntil: answer.cacheWarmUntil } : {}) }
}

/**
 * `claude -p --output-format json`'s result, checked rather than trusted.
 * `usage` is returned for failures too, so a miss can be logged whatever came
 * of the question.
 */
export function readPrintResult(stdout: string, stderr: string, ms: number, now: number): EndedAnswer & { usage?: SideQuestionUsage } {
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(stdout) as Record<string, unknown>
  } catch {
    const said = (stderr.trim() || stdout.trim()).split('\n')[0]
    return { result: { ok: false, reason: 'resume-failed', ...(said ? { detail: said.slice(0, 200) } : {}) } }
  }
  const usage = parsed.usage && typeof parsed.usage === 'object' ? parsed.usage as SideQuestionUsage & Record<string, unknown> : undefined
  const touch = usage ? readClaudeCacheTouch({ type: 'assistant', timestamp: new Date(now).toISOString(), message: { usage } }) : null
  const cacheWarmUntil = touch?.ttlMs !== undefined ? now + touch.ttlMs : undefined
  const warm = cacheWarmUntil !== undefined ? { cacheWarmUntil } : {}
  const used = usage ? { usage: pickUsage(usage) } : {}
  if (parsed.subtype === 'success' && typeof parsed.result === 'string' && parsed.result.trim()) {
    return { result: { ok: true, text: parsed.result.trim(), ...used, ms }, ...warm, ...used }
  }
  // Tools are refused, and one turn is all it gets: reaching for one ends it with nothing said.
  if (parsed.subtype === 'error_max_turns' || parsed.subtype === 'success') {
    return { result: { ok: false, reason: 'empty-reply' }, ...warm, ...used }
  }
  return { result: { ok: false, reason: 'api-error', detail: String(parsed.subtype ?? 'unknown') }, ...warm, ...used }
}

function pickUsage(usage: SideQuestionUsage): SideQuestionUsage {
  const { input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens } = usage
  return { input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens }
}

/** The model and effort of a transcript's last request, from the end of its JSONL. */
export function lastRequestSettings(tail: string): { model?: string; effort?: string } {
  const lines = tail.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"assistant"')) continue
    try {
      const entry = JSON.parse(lines[i]) as { type?: unknown; effort?: unknown; message?: { model?: unknown } }
      if (entry.type !== 'assistant' || typeof entry.message?.model !== 'string') continue
      // `<synthetic>` marks an entry Claude Code wrote itself, with no request behind it.
      if (entry.message.model.startsWith('<')) continue
      return { model: entry.message.model, ...(typeof entry.effort === 'string' ? { effort: entry.effort } : {}) }
    } catch { /* The first line of a tail is usually cut. */ }
  }
  return {}
}

/** Enough of a transcript's end to hold several whole entries; one entry can run to tens of kilobytes. */
const TAIL_BYTES = 512 * 1024

/**
 * The real `claude`, in the login environment a terminal would have, without
 * the identity of whichever session or surface the server was started from: a
 * Spaceterm surface id would file this process's hook events under it.
 */
export function realEndedAskDeps(env: () => NodeJS.ProcessEnv): EndedAskDeps {
  return {
    runClaude: (args, stdin, cwd, timeoutMs) => new Promise((resolve, reject) => {
      const childEnv = scrubInheritedAgentEnv(env())
      delete childEnv.SPACETERM_SURFACE_ID
      delete childEnv.SPACETERM_NODE_ID
      const child = spawn('claude', [...args], { cwd, env: childEnv })
      let stdout = ''
      let stderr = ''
      let timedOut = false
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM') }, timeoutMs)
      child.stdout.on('data', (chunk) => { stdout += chunk })
      child.stderr.on('data', (chunk) => { stderr += chunk })
      child.on('error', (err) => { clearTimeout(timer); reject(new Error(`could not run claude: ${err.message}`)) })
      child.on('close', () => { clearTimeout(timer); resolve({ stdout, stderr, timedOut }) })
      child.stdin.end(stdin)
    }),
    transcriptTail: (path) => {
      let fd: number | undefined
      try {
        fd = fs.openSync(path, 'r')
        const size = fs.fstatSync(fd).size
        const length = Math.min(size, TAIL_BYTES)
        const buffer = Buffer.alloc(length)
        fs.readSync(fd, buffer, 0, length, size - length)
        return buffer.toString('utf8')
      } catch {
        return ''
      } finally {
        if (fd !== undefined) fs.closeSync(fd)
      }
    },
  }
}
