import { describe, it, expect } from 'vitest'
import {
  SummaryChat,
  parseTranscript,
  redactUnheard,
  type SummaryChatDeps,
  type TranscriptMessage
} from './summary-chat'
import { asNodeId } from '../shared/ids'
import type { NodeId } from '../shared/ids'
import type { ClaudeState } from '../shared/state'
import type { PendingTurn } from './pending-turn'

const NODE = asNodeId('node-1234abcd')

type SpeakingEvent = { nodeId: NodeId; speaking: boolean; voice?: string }
type StatusEvent = { nodeId: NodeId; state: string; message?: string }

/**
 * A scripted stand-in for the two HTTP services SummaryChat talks to. Routes are
 * matched by URL substring so a test only has to describe the calls it cares
 * about; anything unrouted is a 404, which SummaryChat treats as "service
 * absent".
 */
interface HttpCall {
  url: string
  method: string
  body?: unknown
  /** The caller's abort signal, so a test can assert a request was dropped. */
  signal?: AbortSignal
}

type RouteHandler = (call: HttpCall) => unknown

/** A reply a test releases by hand, for observing the app mid-request. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (err: Error) => void } {
  let resolve!: (value: T) => void
  let reject!: (err: Error) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function isThenable(value: unknown): value is Promise<unknown> {
  return typeof (value as { then?: unknown } | undefined)?.then === 'function'
}

class FakeHttp {
  readonly calls: HttpCall[] = []
  private routes: Array<{ match: string; handler: RouteHandler }> = []

  /** Route by URL substring. Pass a handler for dynamic replies, or a value for a fixed one. */
  on(match: string, handler: RouteHandler | Record<string, unknown>): this {
    this.routes.push({
      match,
      handler: typeof handler === 'function' ? handler : () => handler
    })
    return this
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    // A poll route that never reaches a terminal state would hang the suite
    // rather than fail it. Fail loudly instead.
    if (this.calls.length > 500) throw new Error('FakeHttp: runaway polling — a route never terminates')
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    const call: HttpCall = { url, method, body, signal: init?.signal ?? undefined }
    this.calls.push(call)

    // Last matching route wins, so a test can override an earlier default.
    const route = [...this.routes].reverse().find((r) => url.includes(r.match))
    if (!route) return new Response('not found', { status: 404 })

    // Awaited only when the route actually deferred, so routes that answer
    // straight away keep their original microtask timing.
    const raw = route.handler(call)
    const result = isThenable(raw) ? await raw : raw
    if (result instanceof Response) return result
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })
  }
}

interface Harness {
  chat: SummaryChat
  http: FakeHttp
  speaking: SpeakingEvent[]
  statuses: StatusEvent[]
  audits: Record<string, unknown>[]
  /** Fire the voice-refresh interval by hand. */
  tickVoiceRefresh(): Promise<void>
}

function harness(options: {
  transcript?: TranscriptMessage[]
  voiceOperatorRunning?: boolean
  oauthToken?: () => string
  sleepSpy?: (ms: number) => void
  /**
   * Park the speech monitor on its inter-poll sleep instead of resolving it,
   * so a test can observe a surface mid-job rather than racing the loop.
   */
  stallBetweenPolls?: boolean
  configure?: (http: FakeHttp) => void
} = {}): Harness {
  const http = new FakeHttp()
  // Sensible defaults: Haiku answers, Voice Operator accepts and finishes.
  http.on('api.anthropic.com', { content: [{ type: 'text', text: 'A concise summary.' }] })
  http.on('/v1/voices', { voices: [{ id: 'voice-a' }, { id: 'voice-b' }, { id: 'af_nicole' }] })
  http.on('/v1/speech', { id: 'speech-1', state: 'completed' })
  options.configure?.(http)

  const speaking: SpeakingEvent[] = []
  const statuses: StatusEvent[] = []
  const audits: Record<string, unknown>[] = []
  let refresh: (() => void) | undefined

  const deps: SummaryChatDeps = {
    fetch: http.fetch,
    readDiscovery: () => (options.voiceOperatorRunning === false ? undefined : { port: 8123 }),
    readTranscript: () => options.transcript ?? [{ role: 'user', text: 'do the thing' }],
    oauthToken: options.oauthToken ?? (() => 'token-abc'),
    audit: {
      writeSnapshot: (auditId) => `/fake/${auditId}.initial-prompt.txt`,
      append: (entry) => audits.push(entry)
    },
    scheduleInterval: (fn) => {
      refresh = fn
      return () => { refresh = undefined }
    },
    // Resolve immediately: the poll floor exists to bound CPU, not to be waited on.
    sleep: (ms) => {
      options.sleepSpy?.(ms)
      return options.stallBetweenPolls ? new Promise<void>(() => {}) : Promise.resolve()
    }
  }

  const chat = new SummaryChat(
    (nodeId, isSpeaking, voice) => speaking.push({ nodeId, speaking: isSpeaking, voice }),
    (nodeId, state, message) => statuses.push({ nodeId, state, message }),
    deps
  )

  return {
    chat,
    http,
    speaking,
    statuses,
    audits,
    tickVoiceRefresh: async () => {
      refresh?.()
      await flush()
    }
  }
}

/**
 * Let the unawaited monitorSpeech loop run to completion. Each poll is a
 * macrotask turn, so drain a generous number of them.
 */
async function flush(turns = 30): Promise<void> {
  for (let i = 0; i < turns; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

function states(h: Harness): string[] {
  return h.statuses.map((s) => s.state)
}

/** Calls to the Messages API, ignoring background voice-list refreshes. */
function haikuCalls(h: Harness): HttpCall[] {
  return h.http.calls.filter((c) => c.url.includes('api.anthropic.com'))
}

/**
 * The newest user message sent to Haiku. Asserting on the whole request body is
 * misleading: it carries the bounded history, so text from an earlier turn
 * still appears there.
 */
function newestPrompt(h: Harness): string {
  const calls = haikuCalls(h)
  const body = calls[calls.length - 1].body as { messages: Array<{ content: string }> }
  return body.messages[body.messages.length - 1].content
}

/**
 * The previous answer as Haiku sees it on the newest request. Because the
 * Messages API is stateless the whole history is resent every turn, so this is
 * where an unheard tail would resurface if it were not redacted.
 */
function lastAnswerSent(h: Harness): string | undefined {
  const calls = haikuCalls(h)
  const body = calls[calls.length - 1].body as { messages: Array<{ role: string; content: string }> }
  return [...body.messages].reverse().find((m) => m.role === 'assistant')?.content
}

/** The text handed to Voice Operator — what the listener actually hears. */
function spokenText(h: Harness): string {
  const post = h.http.calls.filter((c) => c.url.includes('/v1/speech') && c.method === 'POST')
  return (post[post.length - 1]?.body as { text: string } | undefined)?.text ?? ''
}

/** Script what Haiku answers, when a test needs a specific number of sentences. */
function answers(http: FakeHttp, text: string): void {
  http.on('api.anthropic.com', { content: [{ type: 'text', text }] })
}

describe('start', () => {
  // A surface that cannot be summarized is an answer to the press, not an event
  // about the surface: it is reported back to whoever pressed the key rather
  // than broadcast to every client, so nothing is announced at all.
  it('rejects a surface with no transcript path', async () => {
    const h = harness()
    const result = await h.chat.start(NODE, {})

    expect(result).toEqual({ outcome: 'rejected', message: 'This surface has no transcript to summarize yet.' })
    expect(h.statuses).toEqual([])
    expect(haikuCalls(h)).toHaveLength(0)
  })

  it('rejects an empty or unreadable transcript as having no transcript', async () => {
    // An empty read means the resolved path is wrong or unwritten — distinct
    // from a transcript that exists but has no user turn to anchor a summary.
    const h = harness({ transcript: [] })
    const result = await h.chat.start(NODE, { transcriptPath: '/t.jsonl' })

    expect(result.outcome).toBe('rejected')
    expect(result).toMatchObject({ message: 'This surface has no transcript to summarize yet.' })
    expect(h.statuses).toEqual([])
  })

  it('rejects a transcript that exists but has no user turn', async () => {
    const h = harness({ transcript: [{ role: 'assistant', text: 'hello' }] })
    const result = await h.chat.start(NODE, { transcriptPath: '/t.jsonl' })

    expect(result.outcome).toBe('rejected')
    expect(result).toMatchObject({ message: expect.stringMatching(/no user messages/) })
    expect(h.statuses).toEqual([])
  })

  it('runs target → thinking → ready on a successful summary', async () => {
    const h = harness()
    await h.chat.start(NODE, { transcriptPath: '/t.jsonl' })
    await flush()

    expect(states(h).slice(0, 2)).toEqual(['target', 'thinking'])
    expect(states(h)).toContain('ready')
    expect(states(h)).not.toContain('error')
  })

  it('sends the transcript to Haiku with the OAuth credential', async () => {
    const h = harness({ transcript: [{ role: 'user', text: 'fix the parser' }] })
    await h.chat.start(NODE, { transcriptPath: '/t.jsonl' })

    const haiku = h.http.calls.find((c) => c.url.includes('api.anthropic.com'))
    expect(haiku?.method).toBe('POST')
    expect(JSON.stringify(haiku?.body)).toContain('fix the parser')
  })

  it('speaks the text Haiku returned', async () => {
    const h = harness({
      configure: (http) => http.on('api.anthropic.com', { content: [{ type: 'text', text: 'All done.' }] })
    })
    await h.chat.start(NODE, { transcriptPath: '/t.jsonl' })

    const speak = h.http.calls.find((c) => c.url.includes('/v1/speech') && c.method === 'POST')
    expect(speak?.body).toMatchObject({ text: 'All done.' })
  })

  it('reports an error and still settles when Haiku fails', async () => {
    const h = harness({
      configure: (http) =>
        http.on('api.anthropic.com', () => new Response('nope', { status: 500 }))
    })
    await h.chat.start(NODE, { transcriptPath: '/t.jsonl' })

    expect(states(h)).toContain('error')
    // The finally block must still run — otherwise the surface is stuck thinking.
    expect(states(h)).toContain('ready')
  })

  it('reports an error when the OAuth credential is unavailable', async () => {
    const h = harness({
      oauthToken: () => { throw new Error('Claude Code OAuth credential is unavailable') }
    })
    await h.chat.start(NODE, { transcriptPath: '/t.jsonl' })

    expect(h.statuses.find((s) => s.state === 'error')?.message).toMatch(/could not reach Haiku/)
  })

  it('reports an error when Haiku returns no text blocks', async () => {
    const h = harness({
      configure: (http) => http.on('api.anthropic.com', { content: [] })
    })
    await h.chat.start(NODE, { transcriptPath: '/t.jsonl' })

    expect(states(h)).toContain('error')
  })

  it('records the start and the response in the audit trail', async () => {
    const h = harness()
    await h.chat.start(NODE, { transcriptPath: '/t.jsonl', sourceAgentSessionId: 'agent-session-1' })

    const started = h.audits.find((a) => a.event === 'started')
    expect(started).toMatchObject({
      nodeId: NODE,
      transcriptPath: '/t.jsonl',
      sourceAgentSessionId: 'agent-session-1'
    })
    expect(h.audits.some((a) => a.event === 'haiku-response')).toBe(true)
  })

  it('records the answer text, not just how long it was', async () => {
    // "Was the text any good?" is the first question asked when nothing comes
    // out of the speakers, and a character count cannot answer it.
    const h = harness()
    await h.chat.start(NODE, { transcriptPath: '/t.jsonl' })

    expect(h.audits.find((a) => a.event === 'haiku-response')).toMatchObject({
      responseText: 'A concise summary.',
      responseCharacters: 'A concise summary.'.length
    })
  })
})

describe('when Voice Operator is not running', () => {
  it('still produces a summary rather than erroring', async () => {
    const h = harness({ voiceOperatorRunning: false })
    await h.chat.start(NODE, { transcriptPath: '/t.jsonl' })
    await flush()

    expect(states(h)).not.toContain('error')
    expect(states(h)).toContain('ready')
    // Nothing was ever spoken, so the speaking indicator must stay silent.
    expect(h.speaking).toEqual([])
  })

  it('does report an error when it is running but will not answer', async () => {
    // The distinction the surface has to make: no Voice Operator at all is a
    // supported setup and stays quiet (above), whereas one that is discoverable
    // and then fails to answer is a fault. Both used to look like success.
    const h = harness({
      configure: (http) => http.on('/v1/speech', () => { throw new Error('connection refused') })
    })
    await h.chat.start(NODE, { transcriptPath: '/t.jsonl' })
    await flush()

    expect(h.statuses.find((s) => s.state === 'error')?.message).toContain('not answering')
    expect(states(h)).toContain('ready')
  })
})

describe('when speech fails after Voice Operator accepted it', () => {
  it('reports the failure rather than settling as though it had been spoken', async () => {
    // A job that dies in synthesis makes no sound and gives no reason, and used
    // to settle down the same path as a summary read out in full. To a listener
    // those are the same event, so the one that is a fault has to say so.
    const h = harness({
      configure: (http) =>
        http.on('/v1/speech', ({ method }) =>
          method === 'POST'
            ? { id: 'speech-1', state: 'in_progress' }
            : { id: 'speech-1', state: 'synthesis_failed', error: 'synthesis_failed' })
    })
    await h.chat.start(NODE, { transcriptPath: '/t.jsonl' })
    await flush()

    expect(h.statuses.find((s) => s.state === 'error')?.message)
      .toContain('could not turn the summary into speech')
    // Still settles: a reported fault must not leave the surface spinning.
    expect(states(h)).toContain('ready')
    expect(h.speaking).toEqual([])
  })

  it('stays quiet when the job merely finishes', async () => {
    const h = harness()
    await h.chat.start(NODE, { transcriptPath: '/t.jsonl' })
    await flush()

    expect(states(h)).not.toContain('error')
  })
})

describe('speech monitoring', () => {
  it('does not light the speaking indicator while the job is merely queued', async () => {
    const h = harness({
      configure: (http) => {
        let poll = 0
        http.on('/v1/speech', ({ method }) => {
          if (method === 'POST') return { id: 'speech-1', state: 'in_progress' }
          poll++
          // Queued for several polls, then the job is cancelled without ever
          // becoming audible — the indicator must never have lit.
          return poll <= 3
            ? { id: 'speech-1', state: 'in_progress', playback_state: 'queued' }
            : { id: 'speech-1', state: 'cancelled_by_client' }
        })
      }
    })
    await h.chat.start(NODE, { transcriptPath: '/t.jsonl' })
    await flush()

    expect(h.speaking).toEqual([])
  })

  it('stops reporting thinking once Voice Operator has the job, even if it never speaks', async () => {
    // The whole point of `synthesizing`. Voice Operator starts its own waiting
    // echo the instant it accepts a job, and runs it until the first sound —
    // which on a contended synthesizer can be tens of seconds, or never. A
    // surface that stayed `thinking` across that window played a second echo
    // underneath the first one, and this is the case where it ran longest.
    const h = harness({
      configure: (http) => {
        let poll = 0
        http.on('/v1/speech', ({ method }) => {
          if (method === 'POST') return { id: 'speech-1', state: 'in_progress' }
          poll++
          // Queued and silent throughout, then it dies in synthesis.
          return poll <= 5
            ? { id: 'speech-1', state: 'in_progress', playback_state: 'queued' }
            : { id: 'speech-1', state: 'synthesis_failed' }
        })
      }
    })
    await h.chat.start(NODE, { transcriptPath: '/t.jsonl' })
    await flush()

    // One `thinking`, for the Haiku round trip, and nothing audible after it.
    expect(states(h).filter((state) => state === 'thinking')).toHaveLength(1)
    expect(states(h).indexOf('synthesizing')).toBeGreaterThan(states(h).lastIndexOf('thinking'))
    // Silent on this side is not the same as fine: the failure still surfaces.
    expect(states(h)).toContain('error')
    expect(h.speaking).toEqual([])
  })

  it('cancels a surface that is still synthesizing', async () => {
    // `synthesizing` is the longest phase on a slow synthesizer, so it is where
    // a listener is most likely to press the chord — and it must read as busy,
    // or the press starts a second answer instead of stopping the first.
    const h = harness({
      stallBetweenPolls: true,
      configure: (http) => {
        http.on('/v1/speech', ({ method }) => method === 'POST'
          ? { id: 'speech-1', state: 'in_progress' }
          : { id: 'speech-1', state: 'in_progress', playback_state: 'queued' })
      }
    })
    await h.chat.start(NODE, { transcriptPath: '/t.jsonl' })
    await flush(3)
    expect(states(h).at(-1)).toBe('synthesizing')

    expect((await h.chat.toggle(NODE)).outcome).toBe('cancelled')
    await flush(3)
    expect(states(h).at(-1)).toBe('ready')
  })

  it('lights the indicator with the chosen voice once audio is actually speaking', async () => {
    let poll = 0
    const h = harness({
      configure: (http) =>
        http.on('/v1/speech', ({ method }) => {
          if (method === 'POST') return { id: 'speech-1', state: 'in_progress' }
          poll++
          return poll === 1
            ? { id: 'speech-1', state: 'in_progress', playback_state: 'speaking' }
            : { id: 'speech-1', state: 'completed' }
        })
    })
    // The voice is picked from a list fetched in the background. Wait for it
    // rather than racing the constructor's refresh.
    await h.tickVoiceRefresh()
    await h.chat.start(NODE, { transcriptPath: '/t.jsonl' })
    await flush()

    expect(h.speaking[0]).toMatchObject({ nodeId: NODE, speaking: true })
    expect(h.speaking[0].voice).toBeTruthy()
    expect(h.speaking[h.speaking.length - 1].speaking).toBe(false)
    expect(states(h)).toContain('ready')
  })

  it('treats a missing playback_state as speaking, for older services', async () => {
    let poll = 0
    const h = harness({
      configure: (http) =>
        http.on('/v1/speech', ({ method }) => {
          if (method === 'POST') return { id: 'speech-1', state: 'in_progress' }
          poll++
          return poll === 1 ? { id: 'speech-1', state: 'in_progress' } : { id: 'speech-1', state: 'completed' }
        })
    })
    await h.chat.start(NODE, { transcriptPath: '/t.jsonl' })
    await flush()

    expect(h.speaking.some((e) => e.speaking)).toBe(true)
  })

  it('waits between polls, so a service that answers instantly cannot spin the loop', async () => {
    // The loop is normally paced by the ?wait= long poll. That is the service's
    // promise, not ours — without a floor, a service that returns immediately
    // pins a CPU.
    let poll = 0
    const sleeps: number[] = []
    const h = harness({
      sleepSpy: (ms) => sleeps.push(ms),
      configure: (http) =>
        http.on('/v1/speech', ({ method }) => {
          if (method === 'POST') return { id: 'speech-1', state: 'in_progress' }
          poll++
          return poll < 4
            ? { id: 'speech-1', state: 'in_progress', playback_state: 'speaking' }
            : { id: 'speech-1', state: 'completed' }
        })
    })
    await h.chat.start(NODE, { transcriptPath: '/t.jsonl' })
    await flush()

    expect(sleeps.length).toBeGreaterThanOrEqual(3)
    expect(sleeps.every((ms) => ms > 0)).toBe(true)
  })

  it('leaves the thinking phase at the handoff, not when audio starts or the job ends', async () => {
    // The waiting cue is a pure function of this phase, and `thinking` is the
    // only phase that makes a sound on this side. It used to persist for the
    // whole spoken answer (echo over the speech), then for the whole synthesis
    // (echo under Voice Operator's own echo). It now ends where spaceterm's
    // share of the wait does: the moment Voice Operator accepts the job.
    let poll = 0
    const h = harness({
      configure: (http) =>
        http.on('/v1/speech', ({ method }) => {
          if (method === 'POST') return { id: 'speech-1', state: 'in_progress' }
          poll++
          return poll <= 3
            ? { id: 'speech-1', state: 'in_progress', playback_state: 'speaking' }
            : { id: 'speech-1', state: 'completed' }
        })
    })
    await h.chat.start(NODE, { transcriptPath: '/t.jsonl' })
    await flush()

    expect(states(h)).toEqual(['target', 'thinking', 'synthesizing', 'speaking', 'ready'])
  })

  it('does not long-poll while it is tracking playback', async () => {
    // Measured against the real service: `?wait=N` wakes only at a *terminal*
    // state — never on queued → speaking. Long-polling while playback matters
    // is therefore asking a question that can only be answered once the answer
    // no longer matters, and it is what pinned the indicator on "thinking" for
    // the whole spoken answer.
    let poll = 0
    const h = harness({
      configure: (http) =>
        http.on('/v1/speech', ({ method }) => {
          if (method === 'POST') return { id: 'speech-1', state: 'in_progress' }
          poll++
          if (poll === 1) return { id: 'speech-1', state: 'in_progress', playback_state: 'queued' }
          if (poll <= 4) return { id: 'speech-1', state: 'in_progress', playback_state: 'speaking' }
          return { id: 'speech-1', state: 'completed' }
        })
    })
    await h.chat.start(NODE, { transcriptPath: '/t.jsonl' })
    await flush()

    const waits = h.http.calls
      .filter((c) => c.method === 'GET' && c.url.includes('/v1/speech/'))
      .map((c) => new URL(c.url).searchParams.get('wait'))
    expect(waits.every((wait) => wait === '0')).toBe(true)
  })

  it('hands the waiting back to the service while nothing is audible', async () => {
    // The other side of the same rule: `waiting_for_user` can last
    // indefinitely and shows nothing, so it must not be short-polled.
    let poll = 0
    const h = harness({
      configure: (http) =>
        http.on('/v1/speech', ({ method }) => {
          if (method === 'POST') return { id: 'speech-1', state: 'in_progress' }
          poll++
          if (poll <= 2) return { id: 'speech-1', state: 'in_progress', playback_state: 'waiting_for_user' }
          return { id: 'speech-1', state: 'completed' }
        })
    })
    await h.chat.start(NODE, { transcriptPath: '/t.jsonl' })
    await flush()

    const waits = h.http.calls
      .filter((c) => c.method === 'GET' && c.url.includes('/v1/speech/'))
      .map((c) => new URL(c.url).searchParams.get('wait'))
    // First poll tracks playback; the rest wait on a job with nothing to show.
    expect(waits[0]).toBe('0')
    expect(waits.slice(1).some((wait) => wait !== '0')).toBe(true)
  })

  it('does not fall back to thinking between an answer\'s own sentences', async () => {
    // Voice Operator's queue is sentence-at-a-time: playback_state returns to
    // `queued` at each handoff inside one job. Polling fast enough to see the
    // transitions means also seeing those gaps, and a literal reading flickers
    // the indicator once per sentence. The `queued` before the first sound is
    // different — nothing has been spoken yet, so it reads as `synthesizing`.
    let poll = 0
    const h = harness({
      configure: (http) =>
        http.on('/v1/speech', ({ method }) => {
          if (method === 'POST') return { id: 'speech-1', state: 'in_progress' }
          poll++
          const playback = poll === 1 ? 'queued'
            : poll === 4 || poll === 7 ? 'queued'   // sentence handoffs
            : 'speaking'
          if (poll > 9) return { id: 'speech-1', state: 'completed' }
          return { id: 'speech-1', state: 'in_progress', playback_state: playback }
        })
    })
    await h.chat.start(NODE, { transcriptPath: '/t.jsonl' })
    await flush()

    expect(states(h)).toEqual(['target', 'thinking', 'synthesizing', 'speaking', 'ready'])
  })

  it('does not report thinking while Voice Operator waits for the user', async () => {
    // `waiting_for_user` keeps the job `in_progress` indefinitely. Counting it
    // as "still waiting" is how a cue could run forever after an answer had
    // already been spoken.
    let poll = 0
    const h = harness({
      configure: (http) =>
        http.on('/v1/speech', ({ method }) => {
          if (method === 'POST') return { id: 'speech-1', state: 'in_progress' }
          poll++
          if (poll === 1) return { id: 'speech-1', state: 'in_progress', playback_state: 'speaking' }
          if (poll <= 4) return { id: 'speech-1', state: 'in_progress', playback_state: 'waiting_for_user' }
          return { id: 'speech-1', state: 'completed' }
        })
    })
    await h.chat.start(NODE, { transcriptPath: '/t.jsonl' })
    await flush()

    expect(states(h).lastIndexOf('thinking')).toBeLessThan(states(h).indexOf('speaking'))
    expect(states(h).at(-1)).toBe('ready')
  })

  it('settles the surface when a speech job is cancelled', async () => {
    // dispose() and a restart both cancel mid-job. The monitor loop exits
    // silently once its speech id is stale, so cancelling must settle the
    // phase itself — otherwise the surface is stuck thinking for good, and the
    // cue with it.
    const h = harness({
      stallBetweenPolls: true,
      configure: (http) =>
        http.on('/v1/speech', ({ method }) =>
          method === 'POST'
            ? { id: 'speech-1', state: 'in_progress' }
            : { id: 'speech-1', state: 'in_progress', playback_state: 'speaking' }
        )
    })
    await h.chat.start(NODE, { transcriptPath: '/t.jsonl' })
    await flush(3)
    expect(states(h)).toEqual(['target', 'thinking', 'synthesizing', 'speaking'])

    h.chat.dispose()

    expect(states(h).at(-1)).toBe('ready')
    expect(h.speaking.at(-1)).toMatchObject({ speaking: false })
  })

  it('settles to ready when the service disappears mid-job', async () => {
    const h = harness({
      configure: (http) =>
        http.on('/v1/speech', ({ method }) =>
          method === 'POST'
            ? { id: 'speech-1', state: 'in_progress' }
            : new Response('gone', { status: 500 })
        )
    })
    await h.chat.start(NODE, { transcriptPath: '/t.jsonl' })
    await flush()

    expect(states(h)).toContain('ready')
  })
})

/**
 * Cancellation is the one behaviour here with no natural resting point: it can
 * arrive at any instant between "the listener asked for a summary" and "the
 * last syllable played". Each test below picks one of those instants — and
 * several of them are instants that only exist between two awaits.
 */
describe('cancelAll', () => {
  const speaking = (http: FakeHttp, offset = 61) =>
    http.on('/v1/speech', ({ method }) => {
      if (method === 'POST') return { id: 'speech-1', state: 'in_progress' }
      if (method === 'DELETE') {
        // 410 is what Voice Operator answers a successful cancellation with,
        // and it carries how far the listener got.
        return new Response(
          JSON.stringify({ id: 'speech-1', state: 'cancelled_by_client', character_offset: offset }),
          { status: 410 }
        )
      }
      return { id: 'speech-1', state: 'in_progress', playback_state: 'speaking' }
    })

  it('does nothing, and says so, when no surface is producing', async () => {
    const h = harness()
    expect(await h.chat.cancelAll()).toBe(false)
  })

  it('drops a summary that is still waiting on Haiku', async () => {
    const gate = deferred<unknown>()
    const h = harness({ configure: (http) => http.on('api.anthropic.com', () => gate.promise) })
    void h.chat.start(NODE, { transcriptPath: '/t.jsonl' })
    await flush(3)
    expect(states(h)).toEqual(['target', 'thinking'])

    expect(await h.chat.cancelAll()).toBe(true)
    expect(states(h).at(-1)).toBe('ready')
    // The request itself is dropped, not merely ignored — an answer nobody
    // will hear is not worth paying for.
    expect(haikuCalls(h)[0].signal?.aborted).toBe(true)

    // Even if the reply arrives anyway, nothing is spoken and nothing settles
    // a surface that has already been settled by someone else.
    gate.resolve({ content: [{ type: 'text', text: 'too late' }] })
    await flush()
    expect(h.http.calls.some((c) => c.method === 'POST' && c.url.includes('/v1/speech'))).toBe(false)
    expect(states(h).filter((s) => s === 'ready')).toHaveLength(1)
  })

  it('reports no error for an answer the listener deliberately cut off', async () => {
    // The Haiku request is aborted, which surfaces as a rejected fetch. That is
    // not a failure to report: it would put an error toast on screen every
    // single time the chord was used to stop something.
    const gate = deferred<unknown>()
    const h = harness({ configure: (http) => http.on('api.anthropic.com', () => gate.promise) })
    const started = h.chat.start(NODE, { transcriptPath: '/t.jsonl' })
    await flush(2)

    await h.chat.cancelAll()
    gate.reject(new Error('This operation was aborted'))
    await started
    await flush()

    expect(states(h)).not.toContain('error')
  })

  it('drops a speech job that was created after the cancel landed', async () => {
    // The window this closes: Haiku has answered and the speech POST is in
    // flight, so there is a job about to exist that no monitor will ever adopt.
    // Left alone it speaks a whole answer at someone who asked for silence.
    const gate = deferred<unknown>()
    const h = harness({
      configure: (http) =>
        http.on('/v1/speech', ({ method }) =>
          method === 'POST' ? gate.promise : { id: 'speech-1', state: 'completed' }
        )
    })
    void h.chat.start(NODE, { transcriptPath: '/t.jsonl' })
    await flush(6)
    expect(h.http.calls.some((c) => c.method === 'POST' && c.url.includes('/v1/speech'))).toBe(true)

    expect(await h.chat.cancelAll()).toBe(true)
    gate.resolve({ id: 'speech-1', state: 'in_progress' })
    await flush()

    expect(h.http.calls.some((c) => c.method === 'DELETE' && c.url.includes('speech-1'))).toBe(true)
    expect(states(h).at(-1)).toBe('ready')
  })

  it('cuts off an answer that is already speaking', async () => {
    const h = harness({ stallBetweenPolls: true, configure: (http) => speaking(http) })
    await h.chat.start(NODE, { transcriptPath: '/t.jsonl' })
    await flush(4)
    expect(states(h).at(-1)).toBe('speaking')

    expect(await h.chat.cancelAll()).toBe(true)

    expect(h.http.calls.some((c) => c.method === 'DELETE' && c.url.includes('speech-1'))).toBe(true)
    expect(states(h).at(-1)).toBe('ready')
    expect(h.speaking.at(-1)).toMatchObject({ speaking: false })
  })

  it('strips the unheard tail of the answer out of the resent history', async () => {
    // Reading the offset at all depends on the DELETE's 410 being treated as an
    // answer rather than a failure.
    const h = harness({
      stallBetweenPolls: true,
      configure: (http) => {
        answers(http, 'First sentence. Second sentence. Third sentence.')
        speaking(http, 32) // Through "Second sentence.", partway into the third.
      }
    })
    await h.chat.start(NODE, { transcriptPath: '/t.jsonl' })
    await flush(4)
    await h.chat.cancelAll()
    h.http.calls.length = 0

    await h.chat.followUp('what was that?')

    expect(lastAnswerSent(h)).toBe('First sentence. Second sentence. *INTERRUPTED*')
    expect(newestPrompt(h)).toContain('*INTERRUPTED*')
  })

  it('drops a sentence that was only half spoken', async () => {
    const h = harness({
      stallBetweenPolls: true,
      configure: (http) => {
        answers(http, 'First sentence. Second sentence.')
        speaking(http, 24) // Mid-way through "Second sentence."
      }
    })
    await h.chat.start(NODE, { transcriptPath: '/t.jsonl' })
    await flush(4)
    await h.chat.cancelAll()
    h.http.calls.length = 0

    await h.chat.followUp('what was that?')
    expect(lastAnswerSent(h)).toBe('First sentence. *INTERRUPTED*')
  })

  it('redacts the whole answer when no sentence finished', async () => {
    // Voice Operator counts whole sentences, so a zero means the listener heard
    // nothing at all — none of the answer may be resent as though delivered.
    const h = harness({ stallBetweenPolls: true, configure: (http) => speaking(http, 0) })
    await h.chat.start(NODE, { transcriptPath: '/t.jsonl' })
    await flush(4)
    await h.chat.cancelAll()
    h.http.calls.length = 0

    await h.chat.followUp('what was that?')
    expect(lastAnswerSent(h)).toBe('*INTERRUPTED*')
  })

  it('leaves an answer that played to the end intact', async () => {
    const h = harness({ configure: (http) => answers(http, 'First sentence. Second sentence.') })
    await h.chat.start(NODE, { transcriptPath: '/t.jsonl' })
    await flush()
    h.http.calls.length = 0

    await h.chat.followUp('what was that?')
    expect(lastAnswerSent(h)).toBe('First sentence. Second sentence.')
    expect(newestPrompt(h)).not.toContain('*INTERRUPTED*')
  })

  it('settles every surface that is producing, not just one', async () => {
    const other = asNodeId('node-99999999')
    const h = harness({ stallBetweenPolls: true, configure: (http) => speaking(http) })
    await h.chat.start(NODE, { transcriptPath: '/t.jsonl' })
    await h.chat.start(other, { transcriptPath: '/t.jsonl' })
    await flush(4)
    h.statuses.length = 0

    expect(await h.chat.cancelAll()).toBe(true)

    for (const nodeId of [NODE, other]) {
      expect(h.statuses.filter((s) => s.nodeId === nodeId).at(-1)?.state).toBe('ready')
    }
  })

  it('leaves a surface alone when Voice Operator is merely listening', async () => {
    // `waiting_for_user` keeps the job open but produces nothing. There is no
    // sound to stop, so a press there is a request to start.
    const h = harness({
      stallBetweenPolls: true,
      configure: (http) =>
        http.on('/v1/speech', ({ method }) =>
          method === 'POST'
            ? { id: 'speech-1', state: 'in_progress' }
            : { id: 'speech-1', state: 'in_progress', playback_state: 'waiting_for_user' }
        )
    })
    await h.chat.start(NODE, { transcriptPath: '/t.jsonl' })
    await flush(4)
    expect(states(h).at(-1)).toBe('ready')

    expect(await h.chat.cancelAll()).toBe(false)
  })
})

describe('toggle', () => {
  it('starts a summary when nothing is happening', async () => {
    const h = harness()
    const result = await h.chat.toggle(NODE, { transcriptPath: '/t.jsonl', sourceAgentSessionId: 'claude-session-7' })
    await flush()

    expect(result).toEqual({ outcome: 'started' })
    expect(haikuCalls(h)).toHaveLength(1)
    // The surface the summary came from is part of the audit trail, so the
    // press has to carry it all the way through.
    expect(h.audits[0]).toMatchObject({ event: 'started', sourceAgentSessionId: 'claude-session-7' })
  })

  it('answers the press without waiting for the answer it starts', async () => {
    // The chirp confirms a gesture. One that waited for Haiku would arrive
    // seconds after the key, by which time a second press has its own meaning.
    const gate = deferred<unknown>()
    const h = harness({ configure: (http) => http.on('api.anthropic.com', () => gate.promise) })

    expect(await h.chat.toggle(NODE, { transcriptPath: '/t.jsonl' })).toEqual({ outcome: 'started' })

    gate.resolve({ content: [{ type: 'text', text: 'A concise summary.' }] })
    await flush()
  })

  it('rejects a press with nothing eligible focused and nothing to stop', async () => {
    const h = harness()
    const result = await h.chat.toggle(undefined)

    expect(result.outcome).toBe('rejected')
    expect(haikuCalls(h)).toHaveLength(0)
  })

  it('cancels rather than starting while an answer is in flight', async () => {
    const h = harness({ stallBetweenPolls: true, configure: (http) =>
      http.on('/v1/speech', ({ method }) =>
        method === 'POST'
          ? { id: 'speech-1', state: 'in_progress' }
          : { id: 'speech-1', state: 'in_progress', playback_state: 'speaking' }
      )
    })
    await h.chat.start(NODE, { transcriptPath: '/t.jsonl' })
    await flush(4)

    expect(await h.chat.toggle(NODE, { transcriptPath: '/t.jsonl' })).toEqual({ outcome: 'cancelled' })
    // The press meant "stop", so it must not also have queued another answer.
    expect(haikuCalls(h)).toHaveLength(1)
  })

  it('cancels whatever is speaking even with nothing focused', async () => {
    // Silence must not depend on which surface the listener is looking at.
    const h = harness({ stallBetweenPolls: true, configure: (http) =>
      http.on('/v1/speech', ({ method }) =>
        method === 'POST'
          ? { id: 'speech-1', state: 'in_progress' }
          : { id: 'speech-1', state: 'in_progress', playback_state: 'speaking' }
      )
    })
    await h.chat.start(NODE, { transcriptPath: '/t.jsonl' })
    await flush(4)

    expect(await h.chat.toggle(undefined)).toEqual({ outcome: 'cancelled' })
  })

  it('starts on a different surface on the press right after a cancel', async () => {
    // The whole point of the gesture: listening to one surface, cut it off,
    // press again, and be summarizing the surface now in front of you.
    const other = asNodeId('node-99999999')
    const h = harness({ stallBetweenPolls: true, configure: (http) =>
      http.on('/v1/speech', ({ method }) =>
        method === 'POST'
          ? { id: 'speech-1', state: 'in_progress' }
          : { id: 'speech-1', state: 'in_progress', playback_state: 'speaking' }
      )
    })
    await h.chat.start(NODE, { transcriptPath: '/t.jsonl' })
    await flush(4)

    expect(await h.chat.toggle(other, { transcriptPath: '/t.jsonl' })).toEqual({ outcome: 'cancelled' })
    expect(await h.chat.toggle(other, { transcriptPath: '/t.jsonl' })).toEqual({ outcome: 'started' })
    await flush()

    expect(h.chat.getTargetNodeId()).toBe(other)
    expect(h.statuses.filter((s) => s.nodeId === NODE).at(-1)?.state).toBe('ready')
  })
})

describe('when Voice Operator refuses the job', () => {
  it('says that speech is muted rather than falling silent', async () => {
    const h = harness({
      configure: (http) =>
        http.on('/v1/speech', () => new Response(JSON.stringify({ error: 'speech_muted' }), { status: 503 }))
    })
    await h.chat.start(NODE, { transcriptPath: '/t.jsonl' })
    await flush()

    expect(h.statuses.find((s) => s.state === 'error')?.message).toMatch(/muted/i)
    expect(states(h).at(-1)).toBe('ready')
  })
})

describe('change-cursor polling', () => {
  it('follows the job by cursor when the service offers one', async () => {
    // `?since=` is the only way to observe queued → speaking. Without it this
    // monitor has to spin; with it, the service does the waiting.
    let poll = 0
    const h = harness({
      configure: (http) =>
        http.on('/v1/speech', ({ method }) => {
          if (method === 'POST') return { id: 'speech-1', state: 'in_progress', playback_state: 'queued', version: 1 }
          poll++
          return poll === 1
            ? { id: 'speech-1', state: 'in_progress', playback_state: 'speaking', version: 2 }
            : { id: 'speech-1', state: 'completed', version: 3 }
        })
    })
    await h.chat.start(NODE, { transcriptPath: '/t.jsonl' })
    await flush()

    const polls = h.http.calls.filter((c) => c.method === 'GET' && c.url.includes('/v1/speech/'))
    expect(polls.map((c) => new URL(c.url).searchParams.get('since'))).toEqual(['1', '2'])
    expect(polls.every((c) => new URL(c.url).searchParams.get('wait') !== '0')).toBe(true)
    expect(states(h)).toEqual(['target', 'thinking', 'synthesizing', 'speaking', 'ready'])
  })

  it('does not spin when a service reports a version but ignores the cursor', async () => {
    // A long poll is only a pace if the service honours it. One that answers
    // immediately with the same version told us nothing, so fall back to the
    // floor rather than trusting it.
    let poll = 0
    const sleeps: number[] = []
    const h = harness({
      sleepSpy: (ms) => sleeps.push(ms),
      configure: (http) =>
        http.on('/v1/speech', ({ method }) => {
          if (method === 'POST') return { id: 'speech-1', state: 'in_progress', version: 7 }
          poll++
          return poll < 4
            ? { id: 'speech-1', state: 'in_progress', playback_state: 'speaking', version: 7 }
            : { id: 'speech-1', state: 'completed', version: 7 }
        })
    })
    await h.chat.start(NODE, { transcriptPath: '/t.jsonl' })
    await flush()

    expect(sleeps.length).toBeGreaterThanOrEqual(3)
    expect(sleeps.every((ms) => ms > 0)).toBe(true)
  })
})

describe('followUp', () => {
  it('is ignored when no conversation has been started', async () => {
    const h = harness()
    await h.chat.followUp('what did it say?')

    expect(haikuCalls(h)).toHaveLength(0)
    expect(h.statuses).toEqual([])
  })

  it('carries the question through to Haiku', async () => {
    const h = harness()
    await h.chat.start(NODE, { transcriptPath: '/t.jsonl' })
    h.http.calls.length = 0

    await h.chat.followUp('why did it fail?')

    const haiku = h.http.calls.find((c) => c.url.includes('api.anthropic.com'))
    expect(JSON.stringify(haiku?.body)).toContain('why did it fail?')
  })

  it('redacts what the listener never heard, and says the answer was cut off', async () => {
    const h = harness({
      configure: (http) => {
        answers(http, 'First sentence. Second sentence.')
        http.on('/v1/speech', ({ method }) =>
          method === 'POST'
            ? { id: 'speech-1', state: 'in_progress' }
            : { id: 'speech-1', state: 'interrupted_by_user', character_offset: 16 }
        )
      }
    })
    await h.chat.start(NODE, { transcriptPath: '/t.jsonl' })
    await flush()
    h.http.calls.length = 0

    await h.chat.followUp('wait, repeat that')

    expect(lastAnswerSent(h)).toBe('First sentence. *INTERRUPTED*')
    expect(newestPrompt(h)).toContain('cut off')
  })

  it('consumes the interruption once — a later answer that played out gets no context', async () => {
    let jobs = 0
    const h = harness({
      configure: (http) => {
        answers(http, 'First sentence. Second sentence.')
        http.on('/v1/speech', ({ method }) => {
          if (method === 'POST') {
            jobs++
            return { id: `speech-${jobs}`, state: 'in_progress' }
          }
          // Only the first answer is cut off; later ones play to the end.
          return jobs === 1
            ? { id: 'speech-1', state: 'interrupted_by_user', character_offset: 16 }
            : { id: `speech-${jobs}`, state: 'completed' }
        })
      }
    })
    await h.chat.start(NODE, { transcriptPath: '/t.jsonl' })
    await flush()

    await h.chat.followUp('first question')
    await flush()
    await h.chat.followUp('second question')

    expect(newestPrompt(h)).toContain('second question')
    expect(newestPrompt(h)).not.toContain('*INTERRUPTED*')
    // The first answer stays redacted — the listener never un-hears it — but
    // the answer that did play out is resent whole.
    expect(lastAnswerSent(h)).toBe('First sentence. Second sentence.')
  })

  it('adds no interruption context when the answer played to the end', async () => {
    const h = harness()
    await h.chat.start(NODE, { transcriptPath: '/t.jsonl' })
    await flush()

    await h.chat.followUp('go on')
    expect(newestPrompt(h)).not.toContain('*INTERRUPTED*')
  })

  it('keeps prior exchanges in the Haiku history', async () => {
    const h = harness()
    await h.chat.start(NODE, { transcriptPath: '/t.jsonl' })
    await h.chat.followUp('and then?')

    const haiku = h.http.calls.filter((c) => c.url.includes('api.anthropic.com'))
    const last = haiku[haiku.length - 1].body as { messages: unknown[] }
    // initial prompt, initial answer, follow-up
    expect(last.messages.length).toBeGreaterThanOrEqual(3)
  })

  it('targets the most recently used conversation', async () => {
    const other = asNodeId('node-99999999')
    const h = harness()
    await h.chat.start(NODE, { transcriptPath: '/t.jsonl' })
    await h.chat.start(other, { transcriptPath: '/t.jsonl' })

    expect(h.chat.getTargetNodeId()).toBe(other)

    h.statuses.length = 0
    await h.chat.followUp('hello')
    expect(h.statuses.every((s) => s.nodeId === other)).toBe(true)
  })
})

describe('getTargetNodeId', () => {
  it('is undefined before anything has started', () => {
    expect(harness().chat.getTargetNodeId()).toBeUndefined()
  })
})

describe('voice selection', () => {
  it('is stable for a node across conversations', async () => {
    const h = harness()
    await h.tickVoiceRefresh()

    await h.chat.start(NODE, { transcriptPath: '/t.jsonl' })
    const first = h.http.calls.find((c) => c.url.includes('/v1/speech') && c.method === 'POST')?.body as { voice?: string }

    h.http.calls.length = 0
    await h.chat.start(NODE, { transcriptPath: '/t.jsonl' })
    const second = h.http.calls.find((c) => c.url.includes('/v1/speech') && c.method === 'POST')?.body as { voice?: string }

    expect(first.voice).toBeTruthy()
    expect(second.voice).toBe(first.voice)
  })

  it('never selects a blocked voice', async () => {
    const h = harness({
      configure: (http) => http.on('/v1/voices', { voices: [{ id: 'af_nicole' }] })
    })
    await h.tickVoiceRefresh()
    await h.chat.start(NODE, { transcriptPath: '/t.jsonl' })

    const speak = h.http.calls.find((c) => c.url.includes('/v1/speech') && c.method === 'POST')?.body as { voice?: string }
    expect(speak.voice).toBeUndefined()
  })

  // The point of blocking by language rather than by id: a Hindi voice nobody
  // has seen before is blocked the first time Kokoro offers it.
  it('never selects a voice from a blocked language, whatever it is named', async () => {
    const h = harness({
      configure: (http) => http.on('/v1/voices', {
        voices: [{ id: 'hf_alpha' }, { id: 'hm_psi' }, { id: 'hf_voice_from_a_later_release' }],
      })
    })
    await h.tickVoiceRefresh()
    await h.chat.start(NODE, { transcriptPath: '/t.jsonl' })

    const speak = h.http.calls.find((c) => c.url.includes('/v1/speech') && c.method === 'POST')?.body as { voice?: string }
    expect(speak.voice).toBeUndefined()
  })

  it('keeps voices whose ids merely start with a blocked language letter', async () => {
    const h = harness({
      configure: (http) => http.on('/v1/voices', { voices: [{ id: 'harmony' }] })
    })
    await h.tickVoiceRefresh()
    await h.chat.start(NODE, { transcriptPath: '/t.jsonl' })

    const speak = h.http.calls.find((c) => c.url.includes('/v1/speech') && c.method === 'POST')?.body as { voice?: string }
    expect(speak.voice).toBe('harmony')
  })
})

describe('dispose', () => {
  it('stops the voice refresh timer', async () => {
    const h = harness()
    h.chat.dispose()
    h.http.calls.length = 0

    await h.tickVoiceRefresh()
    expect(h.http.calls).toHaveLength(0)
  })
})

describe('redactUnheard', () => {
  it('keeps whole sentences and marks the cut', () => {
    expect(redactUnheard('One. Two. Three.', 9)).toBe('One. Two. *INTERRUPTED*')
  })

  it('drops a sentence that was still being spoken', () => {
    expect(redactUnheard('One. Two. Three.', 12)).toBe('One. Two. *INTERRUPTED*')
  })

  it('keeps nothing when the first sentence never finished', () => {
    expect(redactUnheard('One. Two.', 0)).toBe('*INTERRUPTED*')
    expect(redactUnheard('One. Two.', 2)).toBe('*INTERRUPTED*')
  })

  it('leaves an answer heard to the end untouched', () => {
    expect(redactUnheard('One. Two.', 9)).toBe('One. Two.')
    expect(redactUnheard('One. Two.', 500)).toBe('One. Two.')
  })

  // A summary is spoken prose, so its terminators sit next to real text. These
  // are the shapes that would otherwise cut mid-sentence or not cut at all.
  it('does not treat a decimal point as the end of a sentence', () => {
    expect(redactUnheard('It bumped it to 3.5 today. Then it stopped.', 26))
      .toBe('It bumped it to 3.5 today. *INTERRUPTED*')
  })

  it('cuts after punctuation that closes a quote or bracket', () => {
    expect(redactUnheard('It failed (twice.) Then it stopped.', 20))
      .toBe('It failed (twice.) *INTERRUPTED*')
  })

  it('handles the terminators a voice answer actually uses', () => {
    expect(redactUnheard('Did it? Yes! Wait…  more', 12)).toBe('Did it? Yes! *INTERRUPTED*')
  })
})

describe('parseTranscript', () => {
  const line = (o: unknown): string => JSON.stringify(o)

  it('reads Claude transcript entries', () => {
    const raw = [
      line({ type: 'user', message: { content: 'hello' } }),
      line({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi there' }] } })
    ].join('\n')

    expect(parseTranscript(raw)).toEqual([
      { role: 'user', text: 'hello' },
      { role: 'assistant', text: 'hi there' }
    ])
  })

  it('reads Cursor entries, which put role at the top level', () => {
    const raw = line({ role: 'user', message: { content: 'from cursor' } })
    expect(parseTranscript(raw)).toEqual([{ role: 'user', text: 'from cursor' }])
  })

  it('prefers Codex user_message events over its injected context', () => {
    const raw = [
      line({ type: 'event_msg', payload: { type: 'user_message', message: 'real request' } }),
      line({ type: 'response_item', payload: { type: 'message', role: 'developer', content: 'injected' } }),
      line({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'answer' }] } })
    ].join('\n')

    expect(parseTranscript(raw)).toEqual([
      { role: 'user', text: 'real request' },
      { role: 'assistant', text: 'answer' }
    ])
  })

  it('reads current Codex response-item user turns but skips injected environment context', () => {
    const raw = [
      line({
        type: 'response_item',
        payload: {
          type: 'message', role: 'user',
          content: [{ type: 'input_text', text: '<environment_context>injected setup</environment_context>' }],
          internal_chat_message_metadata_passthrough: { content_item_kinds: ['environments.environment_context'] },
        },
      }),
      line({
        type: 'response_item',
        payload: {
          type: 'message', role: 'user',
          content: [{ type: 'input_text', text: 'review the current changes' }],
          internal_chat_message_metadata_passthrough: { content_item_kinds: ['user.text'] },
        },
      }),
      line({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'I found an issue.' }] } }),
    ].join('\n')

    expect(parseTranscript(raw)).toEqual([
      { role: 'user', text: 'review the current changes' },
      { role: 'assistant', text: 'I found an issue.' },
    ])
  })

  it('skips ordinary tool calls and thinking blocks', () => {
    const raw = line({
      type: 'assistant',
      message: { content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'tool_use', name: 'Bash' }] }
    })
    expect(parseTranscript(raw)).toEqual([])
  })

  it('includes Cursor CreatePlan bodies — that is the answer while waiting on approval', () => {
    const raw = [
      line({ role: 'user', message: { content: 'fix the stop cue' } }),
      line({
        role: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'Drafting the fix plan.' },
            {
              type: 'tool_use',
              name: 'CreatePlan',
              input: {
                name: 'Always play stop cue',
                overview: 'Pair the close cue to a played start cue.',
                plan: '# Root cause\n\nShort silent taps skip the finish cue.\n\n## Verification\n\n- Quick Fn tap hears both cues.',
              },
            },
          ],
        },
      }),
    ].join('\n')

    const parsed = parseTranscript(raw)
    expect(parsed).toHaveLength(2)
    expect(parsed[1].role).toBe('assistant')
    expect(parsed[1].text).toContain('Drafting the fix plan.')
    expect(parsed[1].text).toContain('Plan: Always play stop cue')
    expect(parsed[1].text).toContain('Pair the close cue to a played start cue.')
    expect(parsed[1].text).toContain('Short silent taps skip the finish cue.')
    expect(parsed[1].text).toContain('Quick Fn tap hears both cues.')
  })

  it('includes Claude ExitPlanMode plan bodies the same way', () => {
    const raw = [
      line({ type: 'user', message: { content: 'plan the viewport slots' } }),
      line({
        type: 'assistant',
        message: {
          content: [{
            type: 'tool_use',
            name: 'ExitPlanMode',
            input: { plan: '# Saved viewport slots\n\nBookmark with Cmd+Shift+N.' },
          }],
        },
      }),
    ].join('\n')

    expect(parseTranscript(raw)).toEqual([{
      role: 'user',
      text: 'plan the viewport slots',
    }, {
      role: 'assistant',
      text: 'Plan\n\n# Saved viewport slots\n\nBookmark with Cmd+Shift+N.',
    }])
  })

  it('ignores a partially written final line', () => {
    const raw = line({ type: 'user', message: { content: 'complete' } }) + '\n{"type":"assis'
    expect(parseTranscript(raw)).toEqual([{ role: 'user', text: 'complete' }])
  })

  it('returns nothing when there is no user message to anchor a turn', () => {
    const raw = line({ type: 'assistant', message: { content: 'orphan' } })
    expect(parseTranscript(raw)).toEqual([])
  })

  it('always retains the latest user message, however long the history', () => {
    const lines = []
    for (let i = 0; i < 200; i++) {
      lines.push(line({ type: 'assistant', message: { content: 'x'.repeat(1000) } }))
    }
    lines.push(line({ type: 'user', message: { content: 'the latest request' } }))

    const parsed = parseTranscript(lines.join('\n'))
    expect(parsed[parsed.length - 1]).toEqual({ role: 'user', text: 'the latest request' })
  })

  // A long unattended run: the human spoke once, hours ago, and the agent has
  // been answering ever since. The message cap used to be spent entirely on
  // that trailing output, leaving no user message to anchor a turn, and the
  // chord rejected the surface as having nothing to summarize.
  it('retains the latest user message when the turn since it outran the message cap', () => {
    const lines = [line({ type: 'user', message: { content: 'the latest request' } })]
    for (let i = 0; i < 200; i++) {
      lines.push(line({ type: 'assistant', message: { content: `step ${i}` } }))
    }

    const parsed = parseTranscript(lines.join('\n'))
    expect(parsed[0]).toEqual({ role: 'user', text: 'the latest request' })
    expect(parsed.length).toBeLessThanOrEqual(24)
    // The tail of the turn, not its opening: what the agent just did is the answer.
    expect(parsed[parsed.length - 1]).toEqual({ role: 'assistant', text: 'step 199' })
  })

  it('spends the budget on the current turn before older background', () => {
    const lines = []
    for (let i = 0; i < 40; i++) {
      lines.push(line({ type: 'assistant', message: { content: `background ${i}` } }))
    }
    lines.push(line({ type: 'user', message: { content: 'the latest request' } }))
    for (let i = 0; i < 40; i++) {
      lines.push(line({ type: 'assistant', message: { content: `turn ${i}` } }))
    }

    const parsed = parseTranscript(lines.join('\n'))
    expect(parsed[0]).toEqual({ role: 'user', text: 'the latest request' })
    expect(parsed.some(message => message.text.startsWith('background'))).toBe(false)
  })

  it('bounds how much history it keeps', () => {
    const lines = []
    for (let i = 0; i < 200; i++) {
      lines.push(line({ type: 'user', message: { content: `m${i}` } }))
    }
    expect(parseTranscript(lines.join('\n')).length).toBeLessThanOrEqual(24)
  })

  it('preserves chronological order', () => {
    const raw = [
      line({ type: 'user', message: { content: 'first' } }),
      line({ type: 'assistant', message: { content: 'second' } }),
      line({ type: 'user', message: { content: 'third' } })
    ].join('\n')

    expect(parseTranscript(raw).map((m) => m.text)).toEqual(['first', 'second', 'third'])
  })

  it('handles an empty document', () => {
    expect(parseTranscript('')).toEqual([])
  })
})

/**
 * Claude Code appends an assistant turn to its transcript only once that turn's
 * *interactive* tool resolves. `waiting_question` and `waiting_plan` are defined
 * by such a tool being unresolved, so in exactly those states the message the
 * listener wants summarized is not on disk — measured as a session file frozen
 * for the whole time a question sat on screen, then written 40ms after it was
 * answered. The hook payload is the only readable copy until then.
 */
describe('a surface parked on an interactive tool', () => {
  const QUESTION: PendingTurn = {
    tool: 'AskUserQuestion',
    text: 'The agent is asking the user to decide:\n\nQuestion (Scope): Fold in the retry fix?',
    capturedAt: 1_000,
  }
  const PLAN: PendingTurn = { tool: 'ExitPlanMode', text: 'Plan\n\nSupervise the workers.', capturedAt: 1_000 }

  /** The transcript as it reads while the turn is still buffered. */
  const beforeFlush: TranscriptMessage[] = [
    { role: 'user', text: 'look at the backlog and propose something' },
    { role: 'assistant', text: "I'll start by reading the backlog." },
  ]

  const parked = (pendingTurn: PendingTurn, claudeState: ClaudeState) => ({
    transcriptPath: '/t.jsonl',
    claudeState,
    pendingTurn,
  })

  // The bug this whole change exists for: without the injection Haiku is handed
  // a conversation that stops before the question, and confidently reports that
  // the agent has not decided anything.
  it('sends the pending question to Haiku', async () => {
    const h = harness({ transcript: beforeFlush })
    await h.chat.start(NODE, parked(QUESTION, 'waiting_question'))
    expect(newestPrompt(h)).toContain('Fold in the retry fix?')
  })

  it('sends the pending plan to Haiku', async () => {
    const h = harness({ transcript: beforeFlush })
    await h.chat.start(NODE, parked(PLAN, 'waiting_plan'))
    expect(newestPrompt(h)).toContain('Supervise the workers.')
  })

  // Appended after selectSpeakable has chosen its window, so the one message
  // the listener is waiting on cannot be the message the budget drops.
  it('keeps the pending turn even when the transcript already fills the budget', async () => {
    const full: TranscriptMessage[] = [{ role: 'user', text: 'go' }]
    for (let i = 0; i < 40; i++) full.push({ role: 'assistant', text: `step ${i} `.repeat(400) })
    const h = harness({ transcript: full })
    await h.chat.start(NODE, parked(QUESTION, 'waiting_question'))
    expect(newestPrompt(h)).toContain('Fold in the retry fix?')
  })

  it('places the pending turn last, so it reads as the current turn', async () => {
    const h = harness({ transcript: beforeFlush })
    await h.chat.start(NODE, parked(QUESTION, 'waiting_question'))
    const prompt = newestPrompt(h)
    expect(prompt.indexOf('Fold in the retry fix?')).toBeGreaterThan(prompt.indexOf('reading the backlog'))
  })

  /**
   * A chord pressed just after the listener answers finds the cache still
   * populated and the transcript finally written. Both render through
   * `speakableToolText`, so the strings match and the duplicate is dropped —
   * otherwise Haiku is handed the question twice and may report two of them.
   */
  it('does not repeat a pending turn the transcript has caught up with', async () => {
    const flushed = [...beforeFlush, { role: 'assistant' as const, text: QUESTION.text }]
    const h = harness({ transcript: flushed })
    await h.chat.start(NODE, parked(QUESTION, 'waiting_question'))
    const prompt = newestPrompt(h)
    expect(prompt.split('Fold in the retry fix?').length - 1).toBe(1)
  })

  describe('the caution note', () => {
    // The hook recovers the tool's input. Nothing recovers the prose the agent
    // wrote above it — measured for both tools — so a summary built from the
    // question alone must not read as a complete account of the turn.
    it('warns that the agent\'s message before a question is missing', async () => {
      const h = harness({ transcript: beforeFlush })
      await h.chat.start(NODE, parked(QUESTION, 'waiting_question'))
      const spoken = spokenText(h)
      expect(spoken.startsWith('Note: only the question is available')).toBe(true)
      expect(spoken).toContain('A concise summary.')
    })

    it('warns for a pending plan too, naming the plan', async () => {
      const h = harness({ transcript: beforeFlush })
      await h.chat.start(NODE, parked(PLAN, 'waiting_plan'))
      expect(spokenText(h).startsWith('Note: only the plan is available')).toBe(true)
    })

    it('stays quiet when the surface is not parked on anything', async () => {
      const h = harness({ transcript: beforeFlush })
      await h.chat.start(NODE, { transcriptPath: '/t.jsonl', claudeState: 'working' })
      expect(spokenText(h)).toBe('A concise summary.')
    })

    // Nothing was injected, so nothing is missing — warning here would train the
    // listener to ignore the warning.
    it('stays quiet when the transcript already had the pending turn', async () => {
      const flushed = [...beforeFlush, { role: 'assistant' as const, text: QUESTION.text }]
      const h = harness({ transcript: flushed })
      await h.chat.start(NODE, parked(QUESTION, 'waiting_question'))
      expect(spokenText(h)).toBe('A concise summary.')
    })

    /**
     * `redactUnheard` maps Voice Operator's `character_offset` onto the stored
     * answer. If the note were spoken but not stored, every interruption offset
     * would shift by its length — silently, and only when a listener cut an
     * answer off. One string for both is what prevents that.
     */
    it('is part of the stored answer, not a separate preamble', async () => {
      const h = harness({ transcript: beforeFlush })
      await h.chat.start(NODE, parked(QUESTION, 'waiting_question'))
      const spokenInitially = spokenText(h)
      await h.chat.followUp('what did it decide?')
      // What the follow-up request resends as the previous answer is the exact
      // string that was spoken — which is what keeps character offsets honest.
      expect(lastAnswerSent(h)?.startsWith('Note: only the question is available')).toBe(true)
      expect(lastAnswerSent(h)).toBe(spokenInitially)
    })

    // Already warned. Repeating it every turn costs the warning its meaning.
    it('is not repeated on follow-ups', async () => {
      const h = harness({ transcript: beforeFlush })
      await h.chat.start(NODE, parked(QUESTION, 'waiting_question'))
      const first = h.http.calls.filter((c) => c.url.includes('/v1/speech') && c.method === 'POST').length
      await h.chat.followUp('and then?')
      const bodies = h.http.calls
        .filter((c) => c.url.includes('/v1/speech') && c.method === 'POST')
        .map((c) => (c.body as { text: string }).text)
      expect(first).toBeGreaterThan(0)
      expect(bodies[bodies.length - 1].startsWith('Note:')).toBe(false)
    })
  })
})

/**
 * A long unattended run is what a spoken summary is most useful for, and it is
 * also the run with the least prose. One observed turn spent six minutes on 35
 * shell calls while emitting a single sentence: the transcript offered two
 * speakable messages, and Haiku correctly reported that nothing had been
 * decided. Tool calls are the only record of what actually happened.
 */
describe('tool activity in a transcript', () => {
  const line = (o: unknown): string => JSON.stringify(o)
  const MARKER = '[agent tool activity, not speech]'

  const toolUse = (name: string, input: unknown): string =>
    line({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } })
  /** Claude writes one entry per content block, with results interleaved between them. */
  const toolResult = (): string =>
    line({ type: 'user', message: { content: [{ type: 'tool_result', content: 'output' }] } })
  const said = (role: string, text: string): string =>
    line({ type: role, message: { content: [{ type: 'text', text }] } })

  const run = (...lines: string[]): TranscriptMessage[] => parseTranscript(lines.join('\n'))
  const activity = (messages: TranscriptMessage[]): TranscriptMessage[] =>
    messages.filter((m) => m.text.startsWith(MARKER))

  it('records what the agent did when it said almost nothing', () => {
    const messages = run(
      said('user', 'find the leak'),
      toolUse('Bash', { command: 'ps aux | grep worker' }), toolResult(),
      toolUse('Read', { file_path: 'src/queue.ts' }), toolResult(),
    )
    expect(activity(messages)).toHaveLength(1)
    expect(activity(messages)[0].text).toContain('ps aux | grep worker')
    expect(activity(messages)[0].text).toContain('src/queue.ts')
  })

  // Emitting one message per call would be worse than nothing: 35 of them would
  // consume the whole budget and push the prose out of the window entirely.
  it('coalesces a run into a single message despite interleaved results', () => {
    const lines = ['{"type":"user","message":{"content":"go"}}']
    for (let i = 0; i < 35; i++) { lines.push(toolUse('Bash', { command: `step ${i}` }), toolResult()) }
    const messages = run(...lines)
    expect(activity(messages)).toHaveLength(1)
    expect(activity(messages)[0].text).toContain('35 calls')
    expect(activity(messages)[0].text).toContain('Bash x35')
  })

  it('names the newest calls and says how many it left out', () => {
    const lines = ['{"type":"user","message":{"content":"go"}}']
    for (let i = 0; i < 35; i++) lines.push(toolUse('Bash', { command: `step ${i}` }))
    const text = activity(run(...lines))[0].text
    expect(text).toContain('step 34')
    expect(text).toContain('step 25')
    expect(text).not.toContain('step 24')
    // Silent truncation would read as a complete account of a much smaller run.
    expect(text).toContain('25 earlier calls not listed')
  })

  it('keeps a short run whole, with nothing to elide', () => {
    const text = activity(run(
      said('user', 'go'),
      toolUse('Bash', { command: 'ls' }),
    ))[0].text
    expect(text).toContain('1 call: Bash.')
    expect(text).not.toContain('not listed')
  })

  it('closes a run at each piece of prose, keeping the trace in step', () => {
    const messages = run(
      said('user', 'go'),
      toolUse('Bash', { command: 'first' }),
      said('assistant', 'Now I will check the other side.'),
      toolUse('Bash', { command: 'second' }),
    )
    expect(messages.map((m) => m.text.startsWith(MARKER)))
      .toEqual([false, true, false, true])
    expect(messages[1].text).toContain('first')
    expect(messages[3].text).toContain('second')
  })

  it('puts an entry\'s prose before the calls it introduces', () => {
    const messages = run(
      said('user', 'go'),
      line({ type: 'assistant', message: { content: [
        { type: 'text', text: 'Let me look.' },
        { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
      ] } }),
    )
    expect(messages[1].text).toBe('Let me look.')
    expect(messages[2].text).toContain(MARKER)
  })

  // The name alone describes a night of work and a typo equally well.
  describe('the target it picks', () => {
    const targetOf = (name: string, input: unknown): string =>
      activity(run(said('user', 'go'), toolUse(name, input)))[0].text

    it.each([
      ['Read', { file_path: 'src/a.ts' }, 'src/a.ts'],
      ['Edit', { file_path: 'src/b.ts', old_string: 'x' }, 'src/b.ts'],
      ['Grep', { pattern: 'applySchema', path: 'src' }, 'applySchema'],
      ['Glob', { pattern: '**/*.test.ts' }, '**/*.test.ts'],
      ['Bash', { command: 'npm test', description: 'Run tests' }, 'npm test'],
      ['WebFetch', { url: 'https://example.com/x' }, 'https://example.com/x'],
      ['Task', { description: 'Audit the parser', prompt: 'long prompt' }, 'Audit the parser'],
    ])('reads the identifying field for %s', (name, input, expected) => {
      expect(targetOf(name, input)).toContain(expected)
    })

    it('still records a call whose input it cannot read', () => {
      const text = targetOf('TodoWrite', { todos: [] })
      expect(text).toContain('TodoWrite')
    })

    // A trace that kept the newlines would lose the one-line-per-call shape it
    // is readable because of.
    it('collapses a multi-line command onto one line and bounds it', () => {
      const text = targetOf('Bash', { command: `echo one\n${'x'.repeat(400)}` })
      const traceLines = text.split('\n').filter((l) => l.startsWith('- '))
      expect(traceLines).toHaveLength(1)
      expect(traceLines[0].length).toBeLessThan(140)
      expect(text).toContain('…')
    })
  })

  // These carry the message itself, so they stay speech. Filing a plan as a
  // shell command would bury it.
  it('leaves the interactive tools as messages rather than activity', () => {
    const messages = run(
      said('user', 'go'),
      toolUse('ExitPlanMode', { plan: 'Supervise the workers.' }),
      toolUse('AskUserQuestion', { questions: [{ question: 'Ship it?', header: 'Scope' }] }),
    )
    expect(activity(messages)).toHaveLength(0)
    expect(messages.some((m) => m.text.includes('Supervise the workers.'))).toBe(true)
    expect(messages.some((m) => m.text.includes('Ship it?'))).toBe(true)
  })

  it('ignores a tool call attributed to the user', () => {
    const messages = run(
      said('user', 'go'),
      line({ type: 'user', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'rm -rf /' } }] } }),
    )
    expect(activity(messages)).toHaveLength(0)
  })

  // Thinking is stored as a signature with the text empty, so there is nothing
  // in it to read and nothing to report.
  it('reports nothing for thinking blocks', () => {
    const messages = run(
      said('user', 'go'),
      line({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: '', signature: 'abc' }] } }),
    )
    expect(messages).toEqual([{ role: 'user', text: 'go' }])
  })

  it('reads a Codex function call, whose input is a JSON string', () => {
    const messages = run(
      line({ type: 'event_msg', payload: { type: 'user_message', message: 'go' } }),
      line({ type: 'response_item', payload: {
        type: 'function_call', name: 'shell',
        arguments: JSON.stringify({ command: ['bash', '-lc', 'ls -la'], timeout_ms: 120000 }),
      } }),
    )
    expect(activity(messages)[0].text).toContain('shell')
    expect(activity(messages)[0].text).toContain('bash -lc ls -la')
  })

  it('keeps a Codex call whose arguments will not parse', () => {
    const messages = run(
      line({ type: 'event_msg', payload: { type: 'user_message', message: 'go' } }),
      line({ type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: '{broken' } }),
    )
    expect(activity(messages)[0].text).toContain('shell')
  })

  // Activity is not speech, so it cannot stand in for the user turn a summary
  // anchors on. A transcript of pure tool calls still has nothing to summarize.
  it('does not let activity pass as a user message', () => {
    expect(run(toolUse('Bash', { command: 'ls' }))).toEqual([])
  })
})
