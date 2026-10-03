import { afterEach, describe, expect, it } from 'vitest'
import { asNodeId, type NodeId } from '../../shared/ids'
import type { ClaudeState } from '../../shared/state'
import type { ModelRequest, TranscriptMessage } from '../summary-chat'
import type { SpeechBackend, SpeechContent, SpeechStatus } from '../voice-operator'
import type { NamedVoice } from './name-voice-table'
import { RECEPTIONIST_VOICE } from './name-voice-table'
import { forkPrompt, Receptionist, type ForkClient, type SavedConversation } from './receptionist'
import { COMPACTION_PROMPT } from './prompt'
import { directoryHandleFor, handleFor, type RosterAgent } from './roster'

const KEVIN_ID = asNodeId('11111111-0000-4000-8000-000000000000')
const SALLY_ID = asNodeId('22222222-0000-4000-8000-000000000000')
const DIR_ID = asNodeId('33333333-0000-4000-8000-000000000000')
const KEVIN = handleFor(KEVIN_ID)
const SALLY = handleFor(SALLY_ID)

const TRANSCRIPTS: Record<string, TranscriptMessage[]> = {
  '/t/kevin.jsonl': [
    { role: 'user', text: 'Make the water simulation conserve volume.' },
    { role: 'assistant', text: 'Volume is conserved now; I measured 42 litres in the big tank.' },
  ],
  '/t/sally.jsonl': [
    { role: 'user', text: 'Fix the login page.' },
    { role: 'assistant', text: 'Working on the login form validation.' },
  ],
}

/** Hours-old messages that only a whole-transcript read reaches. */
const EARLY: Record<string, TranscriptMessage[]> = {
  '/t/kevin.jsonl': [{ role: 'assistant', text: 'Early on: the boundary handling uses ghost cells.' }],
}

/**
 * Failures inside a scripted reply. The receptionist catches whatever its
 * model call throws — that is a failed turn to it, not a test failure — so an
 * `expect` inside a script would fail silently without this.
 */
const scriptFailures: unknown[] = []
afterEach(() => { expect(scriptFailures.splice(0)).toEqual([]) })

type Script = string | ((request: ModelRequest) => string | Promise<string>)

/** Everything a receptionist touches, faked, with the calls it made recorded. */
function harness(opts: {
  replies: Script[]
  /** Status the speech job ends in. Defaults to completing. */
  speechEnds?: Partial<SpeechStatus>
  forks?: Partial<ForkClient>
  /** A conversation saved by an earlier server. */
  saved?: SavedConversation
}) {
  const states = new Map<NodeId, ClaudeState>([[KEVIN_ID, 'stopped'], [SALLY_ID, 'working']])
  const agents = (): RosterAgent[] => [
    { nodeId: KEVIN_ID, title: 'water sim', cwd: '/src/fluids', state: states.get(KEVIN_ID)!, transcriptPath: '/t/kevin.jsonl', claudeSessionId: 'kevin-session' },
    { nodeId: SALLY_ID, title: 'login page', cwd: '/src/web', state: states.get(SALLY_ID)!, transcriptPath: '/t/sally.jsonl', claudeSessionId: 'sally-session' },
  ]
  const requests: ModelRequest[] = []
  const replies = [...opts.replies]
  const assigned = new Map<NodeId, NamedVoice>()
  const pool: NamedVoice[] = [
    { name: 'Kevin', voice: 'am_michael', gender: 'masculine' },
    { name: 'Sally', voice: 'bf_emma', gender: 'feminine' },
  ]
  const spoken: Array<{ content: SpeechContent; voice?: string }> = []
  const focused: NodeId[] = []
  const forkCalls: Array<Record<string, unknown>> = []
  const wire: string[] = []
  const notices: string[] = []
  let saved: SavedConversation = { messages: [], summary: '' }
  const record: ModelRequest['messages'] = []
  const compactions: ModelRequest[] = []
  let job = 0
  const speech: SpeechBackend = {
    speak: async (content, voice) => {
      spoken.push({ content, voice })
      return { status: 202, body: { id: `job-${++job}`, state: 'in_progress', playback_state: 'queued', version: 1 } }
    },
    status: async (id) => ({ status: 200, body: { id, state: 'completed', version: 2, ...opts.speechEnds } }),
    drop: async (id) => ({ status: 410, body: { id, state: 'cancelled_by_client' } }),
  }
  const receptionist = new Receptionist({
    askModel: async (request) => {
      // Compaction runs beside the conversation; it never takes a scripted reply.
      if (request.instructions === COMPACTION_PROMPT) {
        compactions.push(request)
        return { text: `summary #${compactions.length}` }
      }
      requests.push(request)
      const next = replies.shift()
      if (next === undefined) throw new Error('no scripted reply left')
      if (typeof next !== 'function') return { text: next }
      try {
        return { text: await next(request) }
      } catch (err) {
        scriptFailures.push(err)
        throw err
      }
    },
    agents,
    readTranscript: (path) => (TRANSCRIPTS[path] ?? []).slice(-2),
    readWholeTranscript: (path) => [...(EARLY[path] ?? []), ...(TRANSCRIPTS[path] ?? [])],
    history: {
      load: () => opts.saved,
      save: (state) => { saved = { messages: [...state.messages], summary: state.summary } },
      append: (messages) => { record.push(...messages) },
      search: (query) => record.filter(message => message.content.includes(query)).map(message => message.content).join('\n') || 'nothing',
    },
    names: {
      get: (nodeId) => assigned.get(nodeId),
      assign: (nodeId) => {
        const next = pool[assigned.size]
        if (next) assigned.set(nodeId, next)
        return next
      },
      touch: () => {},
    },
    forks: {
      fork: async (req) => { forkCalls.push({ kind: 'fork', ...req }); return { forkId: 'fork-1', answer: 'It was 42 litres exactly.', costUsd: 0.0851 } },
      ask: async (req) => { forkCalls.push({ kind: 'ask', ...req }); return { forkId: req.forkId, answer: 'The small tank held 7.' } },
      ...opts.forks,
    },
    focus: (nodeId) => focused.push(nodeId),
    notify: (text) => notices.push(text),
    send: (nodeId, text) => wire.push(`send ${nodeId} ${text}`),
    interrupt: (nodeId) => wire.push(`escape ${nodeId}`),
    directories: () => [{ nodeId: DIR_ID, cwd: '/Users/me/spaceterm' }],
    spawn: (directory, title, prompt) => { wire.push(`spawn ${directory} ${title}: ${prompt}`); return SALLY_ID },
    log: () => {},
    sleep: async () => {},
    voiceOperatorDiscovered: () => true,
  }, { speech, onPhase: () => {}, onError: () => {} })
  return {
    receptionist, requests, spoken, focused, forkCalls, assigned, wire, notices, record, compactions,
    get saved() { return saved },
    setState(nodeId: NodeId, state: ClaudeState) {
      states.set(nodeId, state)
      receptionist.agentStateChanged(nodeId, state)
    },
    latest: (request: ModelRequest) => request.messages[request.messages.length - 1].content,
  }
}

async function flush(turns = 30): Promise<void> {
  for (let i = 0; i < turns; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

const reply = (say: Array<{ from: string; text: string }>, tools: unknown[] = []): string => JSON.stringify({ say, tools })

describe('Receptionist', () => {
  it('names an agent when it is first mentioned and quotes it in its own voice', async () => {
    const h = harness({
      replies: [reply([
        { from: 'control', text: `{${KEVIN}} is on the water simulation.` },
        { from: KEVIN, text: 'Volume is conserved now.' },
      ])],
    })
    await h.receptionist.hear('what is going on with the water sim?')
    await flush()
    expect(h.spoken).toHaveLength(1)
    expect(h.spoken[0].content).toEqual([
      { text: 'Kevin is on the water simulation.', voice: RECEPTIONIST_VOICE },
      { text: 'Kevin here. Volume is conserved now.', voice: 'am_michael' },
    ])
    // Sally was never mentioned, so she was never named.
    expect([...h.assigned.keys()]).toEqual([KEVIN_ID])
    expect(h.focused).toEqual([KEVIN_ID])
  })

  it('shows the roster in the latest message only', async () => {
    const h = harness({ replies: [reply([{ from: 'control', text: 'Hi.' }]), reply([{ from: 'control', text: 'Again.' }])] })
    await h.receptionist.hear('hello')
    await flush()
    await h.receptionist.hear('anything else?')
    await flush()
    const second = h.requests[1]
    expect(h.latest(second)).toContain('AGENT ROSTER')
    expect(h.latest(second)).toContain('THE USER SAYS: anything else?')
    expect(second.messages.slice(0, -1).some(message => message.content.includes('AGENT ROSTER'))).toBe(false)
    expect(second.messages[0].content).toBe('THE USER SAYS: hello')
  })

  it('reads a transcript and answers from it within one turn', async () => {
    const h = harness({
      replies: [
        reply([], [{ tool: 'read', agent: KEVIN, search: 'litres' }]),
        (request) => {
          expect(h.latest(request)).toContain('42 litres')
          return reply([{ from: KEVIN, text: 'I measured 42 litres in the big tank.' }])
        },
      ],
    })
    await h.receptionist.hear('how much water did Kevin measure?')
    await flush()
    expect(h.requests).toHaveLength(2)
    expect(h.spoken).toHaveLength(1)
  })

  it('tells the model what was wrong with an unusable reply and lets it try again', async () => {
    const h = harness({
      replies: ['I think Kevin is fine.', (request) => {
        expect(h.latest(request)).toMatch(/not usable/)
        return reply([{ from: 'control', text: 'Kevin is fine.' }])
      }],
    })
    await h.receptionist.hear('how is Kevin?')
    await flush()
    expect(h.spoken).toHaveLength(1)
  })

  it('speaks up when a monitored agent stops, and only then', async () => {
    const h = harness({
      replies: [
        reply([{ from: 'control', text: `I'll let you know when {${SALLY}} is done.` }], [{ tool: 'monitor', agent: SALLY }]),
        (request) => {
          expect(h.latest(request)).toContain('EVENTS')
          expect(h.latest(request)).toContain('The user has not said anything')
          return reply([{ from: 'control', text: `{${SALLY}} has finished.` }])
        },
      ],
    })
    await h.receptionist.hear('tell me when Sally is done')
    await flush()
    h.setState(SALLY_ID, 'working_background')
    await flush()
    expect(h.requests).toHaveLength(1)
    h.setState(SALLY_ID, 'stopped')
    await flush()
    expect(h.requests).toHaveLength(2)
    expect(h.spoken).toHaveLength(2)
    // The monitor was used up.
    h.setState(SALLY_ID, 'working')
    h.setState(SALLY_ID, 'stopped')
    await flush()
    expect(h.requests).toHaveLength(2)
  })

  it('stays quiet when it decides an event is not worth saying', async () => {
    const h = harness({
      replies: [
        reply([{ from: 'control', text: 'Will do.' }], [{ tool: 'monitor', agent: SALLY }]),
        reply([], [{ tool: 'monitor', agent: SALLY }]),
      ],
    })
    await h.receptionist.hear('let me know when Sally is done')
    await flush()
    h.setState(SALLY_ID, 'stopped')
    await flush()
    expect(h.spoken).toHaveLength(1)
  })

  it('holds events for the next question when talk-to-me is off', async () => {
    const h = harness({
      replies: [
        reply([{ from: 'control', text: 'Will do.' }], [{ tool: 'monitor', agent: SALLY }]),
        (request) => {
          expect(h.latest(request)).toContain('EVENTS')
          expect(h.latest(request)).toContain('THE USER SAYS: any news?')
          return reply([{ from: 'control', text: 'Sally finished.' }])
        },
      ],
    })
    h.receptionist.setTalkToMe(false)
    await h.receptionist.hear('let me know when Sally is done')
    await flush()
    h.setState(SALLY_ID, 'stopped')
    await flush()
    expect(h.requests).toHaveLength(1)
    await h.receptionist.hear('any news?')
    await flush()
    expect(h.requests).toHaveLength(2)
  })

  it('forks an agent to ask it a question, and follows up on the same copy', async () => {
    const h = harness({
      replies: [
        reply([{ from: 'control', text: `I'll ask a copy of {${KEVIN}}.` }], [{ tool: 'ask_fork', agent: KEVIN, question: 'Exactly how many litres?' }]),
        (request) => {
          expect(h.latest(request)).toContain('fork fork-1')
          expect(h.latest(request)).toContain('42 litres exactly')
          return reply([{ from: KEVIN, text: 'It was 42 litres exactly.' }])
        },
        reply([], [{ tool: 'ask_fork', agent: KEVIN, question: 'And the small tank?', fork: 'fork-1' }]),
        reply([{ from: KEVIN, text: 'The small tank held 7.' }]),
      ],
    })
    await h.receptionist.hear('ask Kevin exactly how many litres')
    await flush()
    expect(h.forkCalls[0]).toEqual({
      kind: 'fork', nodeId: KEVIN_ID, sessionId: 'kevin-session', prompt: forkPrompt('Exactly how many litres?'),
    })
    await h.receptionist.hear('and the small tank?')
    await flush()
    expect(h.forkCalls[1]).toEqual({ kind: 'ask', forkId: 'fork-1', prompt: 'And the small tank?' })
    expect(h.notices).toEqual([`Control forked Kevin: $0.09`, `Control asked Kevin's copy a follow-up: cost unknown`])
    expect(h.spoken).toHaveLength(3)
  })

  it('cuts an interrupted answer down to what was heard before the model sees it again', async () => {
    const h = harness({
      replies: [
        reply([{ from: 'control', text: 'Kevin is done.' }, { from: KEVIN, text: 'The solver works and the tests pass.' }]),
        (request) => {
          const previous = request.messages[request.messages.length - 2].content
          expect(previous).toContain('*INTERRUPTED*')
          expect(previous).not.toContain('tests pass')
          // The introduction is the system's, not the model's: it is not shown back.
          expect(previous).not.toContain('Kevin here')
          return reply([{ from: 'control', text: 'Sure.' }])
        },
      ],
      speechEnds: { state: 'interrupted_by_user', character_offset: 'Kevin is done. Kevin here. The sol'.length },
    })
    await h.receptionist.hear('how is Kevin?')
    await flush()
    await h.receptionist.hear('wait, what?')
    await flush()
    expect(h.requests).toHaveLength(2)
  })

  it('never loses an event to a turn the user talked over, and never speaks the stale answer', async () => {
    let releaseStale: ((text: string) => void) | undefined
    const h = harness({
      replies: [
        reply([{ from: 'control', text: 'Will do.' }], [{ tool: 'monitor', agent: SALLY }]),
        () => new Promise<string>((resolve) => { releaseStale = resolve }),
        reply([{ from: 'control', text: 'Hello.' }]),
        reply([{ from: 'control', text: 'Sally finished.' }]),
      ],
    })
    await h.receptionist.hear('let me know when Sally is done')
    await flush()
    h.setState(SALLY_ID, 'stopped')
    await flush()
    void h.receptionist.hear('hello')
    await flush()
    releaseStale?.(reply([{ from: 'control', text: 'Stale.' }]))
    await flush()
    const said = h.spoken.map(entry => JSON.stringify(entry.content))
    expect(said.some(text => text.includes('Stale'))).toBe(false)
    expect(said.some(text => text.includes('Sally finished'))).toBe(true)
    expect(h.latest(h.requests[3])).toContain('EVENTS')
  })

  it('sends a message to the real agent and then watches for its answer', async () => {
    const h = harness({
      replies: [
        reply([{ from: 'control', text: `Sent to {${KEVIN}}.` }], [{ tool: 'send', agent: KEVIN, message: 'Please finish up and commit.' }]),
        (request) => {
          expect(h.latest(request)).toContain('EVENTS')
          return reply([{ from: KEVIN, text: 'Committed.' }])
        },
      ],
    })
    await h.receptionist.hear('tell Kevin to finish up and commit')
    await flush()
    expect(h.wire).toEqual([`send ${KEVIN_ID} Please finish up and commit.`])
    expect(h.record.some(message => message.content === 'SENT TO Kevin: Please finish up and commit.')).toBe(true)
    h.setState(KEVIN_ID, 'working')
    h.setState(KEVIN_ID, 'stopped')
    await flush()
    expect(h.requests).toHaveLength(2)
  })

  it('retracts a misdirected message: Escape first, then the correction', async () => {
    const h = harness({
      replies: [reply([{ from: 'control', text: 'Done.' }], [
        { tool: 'interrupt', agent: SALLY },
        { tool: 'send', agent: SALLY, message: 'Please disregard my last message; it was sent to you by mistake.' },
      ])],
    })
    await h.receptionist.hear('no, that was meant for Kevin, take it back from Sally')
    await flush()
    expect(h.wire).toEqual([`escape ${SALLY_ID}`, `send ${SALLY_ID} Please disregard my last message; it was sent to you by mistake.`])
  })

  it('says "Sent to" when the model sent something and said nothing', async () => {
    const h = harness({ replies: [reply([], [{ tool: 'send', agent: KEVIN, message: 'Commit, please.' }])] })
    await h.receptionist.hear('tell Kevin to commit')
    await flush()
    expect(h.spoken[0].content).toEqual([{ text: 'Sent to Kevin.', voice: RECEPTIONIST_VOICE }])
  })

  it('starts a new agent in a directory it was shown, and watches for its first answer', async () => {
    const h = harness({
      replies: [
        (request) => {
          expect(h.latest(request)).toContain(`[${directoryHandleFor(DIR_ID)}] /Users/me/spaceterm`)
          return reply([{ from: 'control', text: 'Starting one.' }], [
            { tool: 'spawn', directory: directoryHandleFor(DIR_ID), title: 'shorter answers', prompt: 'Make Control answer in one sentence.' },
          ])
        },
        (request) => {
          expect(h.latest(request)).toContain('EVENTS')
          return reply([{ from: 'control', text: 'The new agent finished.' }])
        },
      ],
    })
    await h.receptionist.hear('yes, start a new agent for that')
    await flush()
    expect(h.wire).toEqual([`spawn ${DIR_ID} shorter answers: Make Control answer in one sentence.`])
    h.setState(SALLY_ID, 'stopped')
    await flush()
    expect(h.requests).toHaveLength(2)
  })

  it('searches the whole transcript, while a plain read stays recent', async () => {
    const h = harness({
      replies: [
        reply([], [{ tool: 'read', agent: KEVIN, search: 'ghost cells' }]),
        (request) => {
          expect(h.latest(request)).toContain('the boundary handling uses ghost cells')
          return reply([{ from: KEVIN, text: 'The boundary handling uses ghost cells.' }])
        },
      ],
    })
    await h.receptionist.hear('what did Kevin say about ghost cells?')
    await flush()
    expect(h.spoken).toHaveLength(1)
  })

  it('remembers the conversation across a restart', async () => {
    const first = harness({ replies: [reply([{ from: 'control', text: 'Kevin is on the water sim.' }])] })
    await first.receptionist.hear('what is Kevin doing?')
    await flush()
    const second = harness({
      saved: first.saved,
      replies: [(request) => {
        expect(request.messages[0].content).toBe('THE USER SAYS: what is Kevin doing?')
        expect(request.messages[1].content).toContain('water sim')
        return reply([{ from: 'control', text: 'Still on it.' }])
      }],
    })
    await second.receptionist.hear('and now?')
    await flush()
    expect(second.requests).toHaveLength(1)
  })

  it('keeps every word in the record, folds what ages out of the window into a summary, and shows that summary', async () => {
    const turns = 14
    const h = harness({
      replies: Array.from({ length: turns }, (_, i) => (request: ModelRequest) => {
        if (i === turns - 1) expect(h.latest(request)).toContain('EARLIER IN THIS CONVERSATION')
        return reply([{ from: 'control', text: `answer ${i}` }])
      }),
    })
    for (let i = 0; i < turns; i++) {
      await h.receptionist.hear(`question ${i}`)
      await flush()
    }
    expect(h.record).toHaveLength(turns * 2)
    expect(h.compactions.length).toBeGreaterThan(0)
    expect(h.compactions[0].messages[0].content).toContain('question 0')
    expect(h.saved.summary).toMatch(/^summary #/)
    expect(h.saved.messages.length).toBeLessThan(turns * 2)
  })

  it('recalls from the full record what the window no longer holds', async () => {
    const h = harness({
      replies: [
        reply([{ from: 'control', text: 'Noted the bananas.' }]),
        reply([{ from: 'control', text: 'Let me look back.' }], [{ tool: 'recall', search: 'bananas' }]),
        (request) => {
          expect(h.latest(request)).toContain('recall "bananas"')
          expect(h.latest(request)).toContain('Noted the bananas')
          return reply([{ from: 'control', text: 'You mentioned bananas.' }])
        },
      ],
    })
    await h.receptionist.hear('remember the bananas')
    await flush()
    await h.receptionist.hear('what did I say about bananas?')
    await flush()
    expect(h.spoken.map(entry => JSON.stringify(entry.content)).some(text => text.includes('Let me look back'))).toBe(true)
  })

  it('speaks what it says alongside a read before the answer', async () => {
    const h = harness({
      replies: [
        reply([{ from: 'control', text: `Let me check {${KEVIN}}'s transcript.` }], [{ tool: 'read', agent: KEVIN }]),
        reply([{ from: KEVIN, text: 'Volume is conserved now.' }]),
      ],
    })
    await h.receptionist.hear('what did Kevin finish?')
    await flush()
    expect(h.spoken.map(entry => entry.content)).toEqual([
      [{ text: "Let me check Kevin's transcript.", voice: RECEPTIONIST_VOICE }],
      [{ text: 'Kevin here. Volume is conserved now.', voice: 'am_michael' }],
    ])
  })
})
