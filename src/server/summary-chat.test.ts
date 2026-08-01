import { describe, it, expect } from 'vitest'
import {
  SummaryChat,
  parseTranscript,
  type SummaryChatDeps,
  type TranscriptMessage
} from './summary-chat'
import { asNodeId } from '../shared/ids'
import type { NodeId } from '../shared/ids'

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
}

type RouteHandler = (call: HttpCall) => unknown

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
    this.calls.push({ url, method, body })

    // Last matching route wins, so a test can override an earlier default.
    const route = [...this.routes].reverse().find((r) => url.includes(r.match))
    if (!route) return new Response('not found', { status: 404 })

    const result = route.handler({ url, method, body })
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
    sleep: (ms) => { options.sleepSpy?.(ms); return Promise.resolve() }
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

describe('start', () => {
  it('reports an error when the surface has no transcript path', async () => {
    const h = harness()
    await h.chat.start(NODE, undefined)

    expect(h.statuses).toEqual([
      { nodeId: NODE, state: 'error', message: 'This surface has no transcript to summarize yet.' }
    ])
    expect(haikuCalls(h)).toHaveLength(0)
  })

  it('reports an error when the transcript is empty', async () => {
    const h = harness({ transcript: [] })
    await h.chat.start(NODE, '/t.jsonl')

    expect(h.statuses[0].state).toBe('error')
    expect(h.statuses[0].message).toMatch(/no user messages/)
  })

  it('reports an error when the transcript has only assistant messages', async () => {
    // Summarising a turn requires a user request to anchor it.
    const h = harness({ transcript: [{ role: 'assistant', text: 'hello' }] })
    await h.chat.start(NODE, '/t.jsonl')

    expect(h.statuses[0].state).toBe('error')
  })

  it('runs target → thinking → ready on a successful summary', async () => {
    const h = harness()
    await h.chat.start(NODE, '/t.jsonl')
    await flush()

    expect(states(h).slice(0, 2)).toEqual(['target', 'thinking'])
    expect(states(h)).toContain('ready')
    expect(states(h)).not.toContain('error')
  })

  it('sends the transcript to Haiku with the OAuth credential', async () => {
    const h = harness({ transcript: [{ role: 'user', text: 'fix the parser' }] })
    await h.chat.start(NODE, '/t.jsonl')

    const haiku = h.http.calls.find((c) => c.url.includes('api.anthropic.com'))
    expect(haiku?.method).toBe('POST')
    expect(JSON.stringify(haiku?.body)).toContain('fix the parser')
  })

  it('speaks the text Haiku returned', async () => {
    const h = harness({
      configure: (http) => http.on('api.anthropic.com', { content: [{ type: 'text', text: 'All done.' }] })
    })
    await h.chat.start(NODE, '/t.jsonl')

    const speak = h.http.calls.find((c) => c.url.includes('/v1/speech') && c.method === 'POST')
    expect(speak?.body).toMatchObject({ text: 'All done.' })
  })

  it('reports an error and still settles when Haiku fails', async () => {
    const h = harness({
      configure: (http) =>
        http.on('api.anthropic.com', () => new Response('nope', { status: 500 }))
    })
    await h.chat.start(NODE, '/t.jsonl')

    expect(states(h)).toContain('error')
    // The finally block must still run — otherwise the surface is stuck thinking.
    expect(states(h)).toContain('ready')
  })

  it('reports an error when the OAuth credential is unavailable', async () => {
    const h = harness({
      oauthToken: () => { throw new Error('Claude Code OAuth credential is unavailable') }
    })
    await h.chat.start(NODE, '/t.jsonl')

    expect(h.statuses.find((s) => s.state === 'error')?.message).toMatch(/could not reach Haiku/)
  })

  it('reports an error when Haiku returns no text blocks', async () => {
    const h = harness({
      configure: (http) => http.on('api.anthropic.com', { content: [] })
    })
    await h.chat.start(NODE, '/t.jsonl')

    expect(states(h)).toContain('error')
  })

  it('records the start and the response in the audit trail', async () => {
    const h = harness()
    await h.chat.start(NODE, '/t.jsonl', 'agent-session-1')

    const started = h.audits.find((a) => a.event === 'started')
    expect(started).toMatchObject({
      nodeId: NODE,
      transcriptPath: '/t.jsonl',
      sourceAgentSessionId: 'agent-session-1'
    })
    expect(h.audits.some((a) => a.event === 'haiku-response')).toBe(true)
  })
})

describe('when Voice Operator is not running', () => {
  it('still produces a summary rather than erroring', async () => {
    const h = harness({ voiceOperatorRunning: false })
    await h.chat.start(NODE, '/t.jsonl')
    await flush()

    expect(states(h)).not.toContain('error')
    expect(states(h)).toContain('ready')
    // Nothing was ever spoken, so the speaking indicator must stay silent.
    expect(h.speaking).toEqual([])
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
    await h.chat.start(NODE, '/t.jsonl')
    await flush()

    expect(h.speaking).toEqual([])
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
    await h.chat.start(NODE, '/t.jsonl')
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
    await h.chat.start(NODE, '/t.jsonl')
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
    await h.chat.start(NODE, '/t.jsonl')
    await flush()

    expect(sleeps.length).toBeGreaterThanOrEqual(3)
    expect(sleeps.every((ms) => ms > 0)).toBe(true)
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
    await h.chat.start(NODE, '/t.jsonl')
    await flush()

    expect(states(h)).toContain('ready')
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
    await h.chat.start(NODE, '/t.jsonl')
    h.http.calls.length = 0

    await h.chat.followUp('why did it fail?')

    const haiku = h.http.calls.find((c) => c.url.includes('api.anthropic.com'))
    expect(JSON.stringify(haiku?.body)).toContain('why did it fail?')
  })

  it('tells Haiku how much of the previous answer was actually heard', async () => {
    const h = harness({
      configure: (http) =>
        http.on('/v1/speech', ({ method }) =>
          method === 'POST'
            ? { id: 'speech-1', state: 'in_progress' }
            : { id: 'speech-1', state: 'interrupted_by_user', character_offset: 42 }
        )
    })
    await h.chat.start(NODE, '/t.jsonl')
    await flush()
    h.http.calls.length = 0

    await h.chat.followUp('wait, repeat that')

    expect(newestPrompt(h)).toContain('character 42')
  })

  it('consumes the interruption once — a later answer that played out gets no context', async () => {
    let jobs = 0
    const h = harness({
      configure: (http) =>
        http.on('/v1/speech', ({ method }) => {
          if (method === 'POST') {
            jobs++
            return { id: `speech-${jobs}`, state: 'in_progress' }
          }
          // Only the first answer is cut off; later ones play to the end.
          return jobs === 1
            ? { id: 'speech-1', state: 'interrupted_by_user', character_offset: 42 }
            : { id: `speech-${jobs}`, state: 'completed' }
        })
    })
    await h.chat.start(NODE, '/t.jsonl')
    await flush()

    await h.chat.followUp('first question')
    await flush()
    await h.chat.followUp('second question')

    expect(newestPrompt(h)).toContain('second question')
    expect(newestPrompt(h)).not.toContain('interrupted')
  })

  it('adds no interruption context when the answer played to the end', async () => {
    const h = harness()
    await h.chat.start(NODE, '/t.jsonl')
    await flush()

    await h.chat.followUp('go on')
    expect(newestPrompt(h)).not.toContain('interrupted')
  })

  it('keeps prior exchanges in the Haiku history', async () => {
    const h = harness()
    await h.chat.start(NODE, '/t.jsonl')
    await h.chat.followUp('and then?')

    const haiku = h.http.calls.filter((c) => c.url.includes('api.anthropic.com'))
    const last = haiku[haiku.length - 1].body as { messages: unknown[] }
    // initial prompt, initial answer, follow-up
    expect(last.messages.length).toBeGreaterThanOrEqual(3)
  })

  it('targets the most recently used conversation', async () => {
    const other = asNodeId('node-99999999')
    const h = harness()
    await h.chat.start(NODE, '/t.jsonl')
    await h.chat.start(other, '/t.jsonl')

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

    await h.chat.start(NODE, '/t.jsonl')
    const first = h.http.calls.find((c) => c.url.includes('/v1/speech') && c.method === 'POST')?.body as { voice?: string }

    h.http.calls.length = 0
    await h.chat.start(NODE, '/t.jsonl')
    const second = h.http.calls.find((c) => c.url.includes('/v1/speech') && c.method === 'POST')?.body as { voice?: string }

    expect(first.voice).toBeTruthy()
    expect(second.voice).toBe(first.voice)
  })

  it('never selects a blocked voice', async () => {
    const h = harness({
      configure: (http) => http.on('/v1/voices', { voices: [{ id: 'af_nicole' }] })
    })
    await h.tickVoiceRefresh()
    await h.chat.start(NODE, '/t.jsonl')

    const speak = h.http.calls.find((c) => c.url.includes('/v1/speech') && c.method === 'POST')?.body as { voice?: string }
    expect(speak.voice).toBeUndefined()
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

  it('skips tool calls and thinking blocks', () => {
    const raw = line({
      type: 'assistant',
      message: { content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'tool_use', name: 'Bash' }] }
    })
    expect(parseTranscript(raw)).toEqual([])
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
