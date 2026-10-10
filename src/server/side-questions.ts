import * as fs from 'fs'
import * as http from 'http'
import { randomUUID } from 'crypto'
import { serverLog } from './server-log'

/**
 * Side questions to agent surfaces: `/btw` from the outside.
 *
 * Spaceterm's Claude Code plugin carries a hooks module
 * (`claude-code-plugin/hooks/side-questions.ts`) that long-polls this broker
 * for questions addressed to its own surface and answers each with
 * `$.model.fork`: the agent's own last request again — same model, system
 * prompt, tools and history — with the question after it, no tools, nothing
 * written to the transcript or the prompt cache. So a question reads the
 * agent's whole context from the cache and costs only its own few tokens,
 * idle or mid-turn, without the agent ever knowing it was asked.
 *
 * Verified on an interactive Opus 5.5 session with 38k tokens of context:
 * three questions each read the full prefix from cache, wrote nothing, and
 * paid for about 40 uncached tokens, in about 2 seconds.
 *
 * That is against a warm cache. Against a cold one a fork writes the whole
 * prefix afresh, into an entry the agent's own next request does not read, so
 * the conversation is paid for twice; the receptionist wakes a cold agent with
 * a real turn first (`Receptionist.warmUp`).
 */

/** The token counts a fork reports, as the API spells them. */
export interface SideQuestionUsage {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

export type SideQuestionResult =
  | { ok: true; text: string; usage?: SideQuestionUsage; ms?: number }
  | {
    ok: false
    /**
     * `not-listening`: no plugin is polling for that surface — the agent was
     * started before the plugin carried the module, or is not Claude Code.
     * `timeout`: asked, but no answer in time. The rest are `$.model.fork`'s
     * own reasons: `nothing-to-fork` before the agent's process has made its
     * first request — a fresh agent, or one just restarted and resumed, whose
     * conversation is on disk but whose last request is not in memory.
     * `resume-failed`: an ended agent's session could not be resumed to be
     * asked (`ended-side-question.ts`).
     */
    reason: 'not-listening' | 'timeout' | 'nothing-to-fork' | 'api-error' | 'empty-reply' | 'aborted' | 'invalid-reply' | 'resume-failed'
    detail?: string
  }

/** One question on its way to a surface's plugin. */
export interface SideQuestion { id: string; prompt: string }

export interface SideQuestionsDeps {
  setTimer(fn: () => void, ms: number): () => void
}

const REAL_DEPS: SideQuestionsDeps = {
  setTimer(fn, ms) {
    const timer = setTimeout(fn, ms)
    return () => clearTimeout(timer)
  },
}

/**
 * How recently a surface's plugin must have polled to count as listening.
 * Comfortably more than one long poll, so a surface between polls still counts.
 */
export const LISTENING_WINDOW_MS = 45_000
/** How long one long poll is held open with nothing to hand out. */
export const POLL_WAIT_MS = 15_000
/** A question nobody answers in this long has failed. Generous: a big context takes a while. */
export const ANSWER_TIMEOUT_MS = 120_000

interface PendingAnswer { resolve(result: SideQuestionResult): void; cancelTimer(): void }
interface ParkedPoll { resolve(question: SideQuestion | undefined): void; cancelTimer(): void }

export class SideQuestions {
  /** Questions not yet picked up, per surface. */
  private readonly queued = new Map<string, SideQuestion[]>()
  /** At most one plugin poll held open per surface: the newest wins. */
  private readonly parked = new Map<string, ParkedPoll>()
  private readonly lastPolled = new Map<string, number>()
  private readonly pending = new Map<string, PendingAnswer>()

  /** `startedAt`: when this server began hearing polls, before which no silence means anything. */
  constructor(private readonly deps: SideQuestionsDeps = REAL_DEPS, private readonly startedAt = Date.now()) {}

  /** Whether a plugin has polled for this surface recently: it can take side questions. */
  isListening(surfaceId: string, now = Date.now()): boolean {
    const last = this.lastPolled.get(surfaceId)
    return last !== undefined && now - last <= LISTENING_WINDOW_MS
  }

  /**
   * Whether a surface takes side questions, as far as this server can tell:
   * undefined until the server has been up a whole listening window, since a
   * plugin cut off by the restart has not polled again yet. False means its
   * Claude Code predates side questions and needs a restart.
   */
  takesSideQuestions(surfaceId: string, now = Date.now()): boolean | undefined {
    if (this.isListening(surfaceId, now)) return true
    return now - this.startedAt < LISTENING_WINDOW_MS ? undefined : false
  }

  /** Ask a surface's agent a side question. Always resolves; never rejects. */
  ask(surfaceId: string, prompt: string, now = Date.now(), timeoutMs = ANSWER_TIMEOUT_MS): Promise<SideQuestionResult> {
    if (!this.isListening(surfaceId, now)) return Promise.resolve({ ok: false, reason: 'not-listening' })
    const question: SideQuestion = { id: randomUUID(), prompt }
    return new Promise<SideQuestionResult>((resolve) => {
      const cancelTimer = this.deps.setTimer(() => {
        this.pending.delete(question.id)
        const queue = this.queued.get(surfaceId)
        if (queue) this.queued.set(surfaceId, queue.filter(q => q.id !== question.id))
        resolve({ ok: false, reason: 'timeout' })
      }, timeoutMs)
      this.pending.set(question.id, { resolve, cancelTimer })
      const parked = this.parked.get(surfaceId)
      if (parked) {
        this.parked.delete(surfaceId)
        parked.cancelTimer()
        parked.resolve(question)
      } else {
        this.queued.set(surfaceId, [...(this.queued.get(surfaceId) ?? []), question])
      }
    })
  }

  /**
   * A plugin asking for its surface's next question. Resolves at once if one
   * is waiting, else holds the poll for up to `waitMs` and resolves
   * `undefined` if nothing came.
   */
  poll(surfaceId: string, now = Date.now(), waitMs = POLL_WAIT_MS): Promise<SideQuestion | undefined> {
    this.lastPolled.set(surfaceId, now)
    const queue = this.queued.get(surfaceId)
    if (queue?.length) {
      const [next, ...rest] = queue
      this.queued.set(surfaceId, rest)
      return Promise.resolve(next)
    }
    // A new poll replaces a parked one: the plugin only ever has one in flight,
    // so an older one is a connection that has gone away.
    this.parked.get(surfaceId)?.resolve(undefined)
    return new Promise((resolve) => {
      const poll: ParkedPoll = {
        resolve,
        cancelTimer: this.deps.setTimer(() => {
          if (this.parked.get(surfaceId) === poll) this.parked.delete(surfaceId)
          resolve(undefined)
        }, waitMs),
      }
      this.parked.set(surfaceId, poll)
    })
  }

  /** A plugin's answer: `$.model.fork`'s result for question `id`. Unknown ids are ignored. */
  answer(id: string, fork: unknown, ms?: number): void {
    const pending = this.pending.get(id)
    if (!pending) return
    this.pending.delete(id)
    pending.cancelTimer()
    pending.resolve(readForkResult(fork, ms))
  }
}

/** `$.model.fork`'s result, as the plugin posted it, checked rather than trusted. */
export function readForkResult(fork: unknown, ms?: number): SideQuestionResult {
  if (typeof fork !== 'object' || fork === null) return { ok: false, reason: 'invalid-reply' }
  const r = fork as { isAnswered?: unknown; text?: unknown; usage?: SideQuestionUsage; reason?: unknown; status?: unknown; error?: unknown }
  if (r.isAnswered === true && typeof r.text === 'string') return { ok: true, text: r.text, usage: r.usage, ...(ms !== undefined ? { ms } : {}) }
  const reasons = ['nothing-to-fork', 'api-error', 'empty-reply', 'aborted'] as const
  const reason = reasons.find(known => known === r.reason)
  if (!reason) return { ok: false, reason: 'invalid-reply' }
  const detail = reason === 'api-error' ? `${String(r.status ?? '?')} ${String(r.error ?? '')}`.trim() : undefined
  return { ok: false, reason, ...(detail ? { detail } : {}) }
}

/**
 * The plugin's door: HTTP over a Unix socket, which `$.http.fetch` speaks.
 *
 * - `GET /v1/side-questions/next?surface=<id>` long-polls: 200 with
 *   `{ id, prompt }`, or 204 when nothing came.
 * - `POST /v1/side-questions/answer` with `{ id, result, ms }`, the result
 *   being `$.model.fork`'s.
 *
 * The path must stay under macOS's 104-byte limit for socket paths.
 */
export function serveSideQuestions(broker: SideQuestions, socketPath: string): http.Server {
  try { fs.unlinkSync(socketPath) } catch { /* not there */ }
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://spaceterm')
    if (req.method === 'GET' && url.pathname === '/v1/side-questions/next') {
      const surface = url.searchParams.get('surface')
      if (!surface) { res.writeHead(400).end(); return }
      void broker.poll(surface).then((question) => {
        if (res.writableEnded) return
        if (!question) { res.writeHead(204).end(); return }
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(question))
      })
      return
    }
    if (req.method === 'POST' && url.pathname === '/v1/side-questions/answer') {
      let body = ''
      req.setEncoding('utf8').on('data', (chunk: string) => { body += chunk })
      req.on('end', () => {
        try {
          const { id, result, ms } = JSON.parse(body) as { id?: unknown; result?: unknown; ms?: unknown }
          if (typeof id === 'string') broker.answer(id, result, typeof ms === 'number' ? ms : undefined)
          res.writeHead(204).end()
        } catch {
          res.writeHead(400).end()
        }
      })
      return
    }
    res.writeHead(404).end()
  })
  server.on('error', (err) => serverLog(`[side-questions] server error: ${err.message}`))
  server.listen(socketPath)
  return server
}
