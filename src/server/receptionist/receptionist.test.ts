import { afterEach, describe, expect, it } from 'vitest'
import { asNodeId, type NodeId } from '../../shared/ids'
import type { ClaudeState } from '../../shared/state'
import type { TranscriptMessage } from '../summary-chat'
import type { SpeechBackend, SpeechContent, SpeechStatus } from '../voice-operator'
import type { SideQuestionResult } from '../side-questions'
import type { NamedVoice } from './name-voice-table'
import { RECEPTIONIST_VOICE } from './name-voice-table'
import { RECEPTIONIST_SYSTEM_PROMPT } from './prompt'
import {
  PROMPT_HASH, Receptionist, SessionBusy, sideQuestionPrompt, type AgentRanking, type ReceptionistDeps, type SavedSession, type SessionTurn,
} from './receptionist'
import type { RosterAgent } from './roster'
import { DIRECTORY_PREFIX, Handles, NODE_PREFIX } from './handles'

const KEVIN_ID = asNodeId('11111111-0000-4000-8000-000000000000')
const SALLY_ID = asNodeId('22222222-0000-4000-8000-000000000000')
const DIR_ID = asNodeId('33333333-0000-4000-8000-000000000000')
const HANDLES = new Handles([KEVIN_ID, SALLY_ID])
const KEVIN = HANDLES.of(KEVIN_ID)!
const SALLY = HANDLES.of(SALLY_ID)!
const DIR = new Handles([DIR_ID], DIRECTORY_PREFIX).of(DIR_ID)!
const NOTE_ID = asNodeId('note-1')
const SHELL_ID = asNodeId('shell-1')
/** Every node on the fake canvas. */
const NODE_IDS = [KEVIN_ID, SALLY_ID, DIR_ID, NOTE_ID, SHELL_ID]
const NOTE = new Handles(NODE_IDS, NODE_PREFIX).of(NOTE_ID)!
const SHELL = new Handles(NODE_IDS, NODE_PREFIX).of(SHELL_ID)!

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

type Script = string | ((turn: SessionTurn) => string | Promise<string>)

/** Everything a receptionist touches, faked, with the calls it made recorded. */
function harness(opts: {
  replies: Script[]
  /** Status the speech job ends in. Defaults to completing. */
  speechEnds?: Partial<SpeechStatus>
  /** What the user is looking at; by default nothing has said. */
  userView?: () => ReturnType<ReceptionistDeps['userView']>
  /** How the agents answer side questions; by default every one answers. */
  askAgent?: (nodeId: NodeId, prompt: string) => Promise<SideQuestionResult>
  /** The session saved by an earlier server. */
  saved?: SavedSession
  findAgents?: (query: string) => Promise<AgentRanking>
  /** Sessions the fake daemon no longer has. */
  lostSessions?: string[]
  /** When each answer says the daemon will compact the session (epoch ms); by default it never does. */
  compactsAt?: number
  /** How many messages find the session busy with a turn some earlier server left behind. */
  busyFor?: number
  /** When Kevin's prompt cache goes cold (epoch ms); by default nothing is known of it. */
  kevinCacheWarmUntil?: number
}) {
  const states = new Map<NodeId, ClaudeState>([[KEVIN_ID, 'stopped'], [SALLY_ID, 'working']])
  const agents = (): RosterAgent[] => [
    {
      nodeId: KEVIN_ID, title: 'water sim', cwd: '/src/fluids', state: states.get(KEVIN_ID)!, transcriptPath: '/t/kevin.jsonl', claudeSessionId: 'kevin-session',
      ...(opts.kevinCacheWarmUntil !== undefined ? { cacheWarmUntil: opts.kevinCacheWarmUntil, cacheWarmTokens: 38_000 } : {}),
    },
    { nodeId: SALLY_ID, title: 'login page', cwd: '/src/web', state: states.get(SALLY_ID)!, transcriptPath: '/t/sally.jsonl', claudeSessionId: 'sally-session' },
  ]
  /** Every message sent, in order, with the session it went to. */
  const turns: SessionTurn[] = []
  const replies = [...opts.replies]
  let sessions = 0
  let busy = false
  let busyFor = opts.busyFor ?? 0
  let overlapped = false
  const assigned = new Map<NodeId, NamedVoice>()
  const pool: NamedVoice[] = [
    { name: 'Kevin', voice: 'am_michael', gender: 'masculine' },
    { name: 'Sally', voice: 'bf_emma', gender: 'feminine' },
  ]
  const spoken: Array<{ content: SpeechContent; voice?: string }> = []
  const focused: NodeId[] = []
  const sideQuestions: Array<{ nodeId: NodeId; prompt: string }> = []
  const wire: string[] = []
  const notices: string[] = []
  let session: SavedSession | undefined = opts.saved
  const record: Array<{ role: 'user' | 'assistant'; content: string }> = []
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
    // As the daemon: one turn at a time per session, and a turn it has started
    // is finished even after its caller gives up — which, as the real client
    // does, rejects at once on abort.
    askModel: (turn, signal) => {
      if (busy || busyFor > 0) {
        if (busy) overlapped = true
        busyFor--
        return Promise.reject(new SessionBusy('session already has a turn in progress'))
      }
      turns.push(turn)
      busy = true
      const answering = (async () => {
        if (turn.sessionId && opts.lostSessions?.includes(turn.sessionId)) throw new Error('session not found')
        const next = replies.shift()
        if (next === undefined) throw new Error('no scripted reply left')
        let text: string
        if (typeof next !== 'function') {
          text = next
        } else {
          try {
            text = await next(turn)
          } catch (err) {
            scriptFailures.push(err)
            throw err
          }
        }
        return {
          text, sessionId: turn.sessionId ?? `session-${++sessions}`,
          ...(opts.compactsAt !== undefined ? { compactsAt: opts.compactsAt } : {}),
        }
      })().finally(() => { busy = false })
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        answering.then(resolve, reject)
      })
    },
    findAgents: opts.findAgents ?? (async () => ({
      hits: [{ nodeId: SALLY_ID, probability: 0.82 }, { nodeId: KEVIN_ID, probability: 0.1 }], noneProbability: 0.08,
    })),
    agents,
    readTranscript: (path) => (TRANSCRIPTS[path] ?? []).slice(-2),
    readWholeTranscript: (path) => [...(EARLY[path] ?? []), ...(TRANSCRIPTS[path] ?? [])],
    session: { load: () => session, save: (next) => { session = next } },
    record: {
      append: (messages) => { record.push(...messages) },
      search: (query) => record.filter(message => message.content.includes(query)).map(message => message.content).join('\n') || 'nothing',
      recent: (count) => record.slice(-count),
    },
    names: {
      get: (nodeId) => assigned.get(nodeId),
      assign: (nodeId) => {
        const next = pool[assigned.size]
        if (next) assigned.set(nodeId, next)
        return next
      },
      touch: () => {},
      byName: (name) => [...assigned].find(([, named]) => named.name.toLowerCase() === name.toLowerCase())?.[0],
    },
    askAgent: async (nodeId, prompt) => {
      sideQuestions.push({ nodeId, prompt })
      if (opts.askAgent) return opts.askAgent(nodeId, prompt)
      return { ok: true, text: 'It was 42 litres exactly.', usage: { cache_read_input_tokens: 38_291, input_tokens: 40 } }
    },
    focus: (nodeId) => focused.push(nodeId),
    nodeIds: () => NODE_IDS,
    notify: (text) => notices.push(text),
    send: (nodeId, text) => wire.push(`send ${nodeId} ${text}`),
    interrupt: (nodeId) => wire.push(`escape ${nodeId}`),
    directories: () => [{ nodeId: DIR_ID, cwd: '/Users/me/spaceterm' }],
    userView: opts.userView ?? (() => undefined),
    spawn: (directory, title, prompt) => { wire.push(`spawn ${directory} ${title}: ${prompt}`); return SALLY_ID },
    log: () => {},
    sleep: async () => {},
    voiceOperatorDiscovered: () => true,
  }, { speech, onPhase: () => {}, onError: () => {} })
  return {
    receptionist, turns, spoken, focused, sideQuestions, assigned, wire, notices, record,
    get session() { return session },
    get overlapped() { return overlapped },
    setState(nodeId: NodeId, state: ClaudeState) {
      states.set(nodeId, state)
      receptionist.agentStateChanged(nodeId, state)
    },
  }
}

async function flush(turns = 30): Promise<void> {
  for (let i = 0; i < turns; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

const reply = (say: Array<{ from: string; text: string }>, tools: unknown[] = []): string => JSON.stringify({ say, tools })
const said = (h: { spoken: Array<{ content: SpeechContent }> }): string[] => h.spoken.map(entry => JSON.stringify(entry.content))

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
    expect(h.spoken[0].content).toEqual([
      { text: 'Kevin is on the water simulation.', voice: RECEPTIONIST_VOICE },
      { text: 'Kevin here. Volume is conserved now.', voice: 'am_michael' },
    ])
    // Sally was never mentioned, so she was never named.
    expect([...h.assigned.keys()]).toEqual([KEVIN_ID])
    // Talking about an agent never moves the user's camera.
    expect(h.focused).toEqual([])
  })

  it('starts one session with the instructions, then sends only what is new into it', async () => {
    const h = harness({ replies: [reply([{ from: 'control', text: 'Hi.' }]), reply([{ from: 'control', text: 'Again.' }])] })
    await h.receptionist.hear('hello')
    await flush()
    await h.receptionist.hear('anything else?')
    await flush()
    expect(h.turns[0]).toMatchObject({ systemPrompt: RECEPTIONIST_SYSTEM_PROMPT })
    expect(h.turns[0].sessionId).toBeUndefined()
    expect(h.turns[1]).toMatchObject({ sessionId: 'session-1' })
    expect(h.turns[1].systemPrompt).toBeUndefined()
    // No roster, no history: the session has those.
    expect(h.turns[1].prompt).toMatch(/^THE USER SAYS: anything else\?/)
    expect(h.turns[1].prompt).not.toContain('hello')
    expect(h.session).toEqual({ sessionId: 'session-1', promptHash: PROMPT_HASH })
  })

  it('carries on the saved session after a restart, but not one begun on other instructions', async () => {
    const same = harness({ saved: { sessionId: 'kept', promptHash: PROMPT_HASH }, replies: [reply([{ from: 'control', text: 'Yes.' }])] })
    await same.receptionist.hear('still there?')
    await flush()
    expect(same.turns[0].sessionId).toBe('kept')

    const stale = harness({ saved: { sessionId: 'old', promptHash: 'other' }, replies: [reply([{ from: 'control', text: 'Yes.' }])] })
    await stale.receptionist.hear('still there?')
    await flush()
    expect(stale.turns[0].sessionId).toBeUndefined()
    expect(stale.turns[0].systemPrompt).toBe(RECEPTIONIST_SYSTEM_PROMPT)
  })

  it('starts afresh when the session is gone', async () => {
    const h = harness({
      saved: { sessionId: 'vanished', promptHash: PROMPT_HASH },
      lostSessions: ['vanished'],
      replies: [reply([{ from: 'control', text: 'Here.' }])],
    })
    await h.receptionist.hear('hello?')
    await flush()
    expect(h.session).toBeUndefined()
    await h.receptionist.hear('hello again')
    await flush()
    expect(h.turns.at(-1)?.sessionId).toBeUndefined()
    expect(h.session?.sessionId).toBe('session-1')
    // The new session is told what was said before it, but not this message twice.
    const prompt = h.turns.at(-1)!.prompt
    expect(prompt).toMatch(/^EARLIER CONVERSATION[^]*THE USER SAYS: hello\?[^]*THE USER SAYS: hello again/)
    expect(prompt.split('hello again')).toHaveLength(2)
  })

  it('waits out a session still busy with an abandoned turn, and keeps it', async () => {
    const h = harness({
      saved: { sessionId: 'kept', promptHash: PROMPT_HASH },
      busyFor: 2,
      replies: [reply([{ from: 'control', text: 'Here.' }])],
    })
    await h.receptionist.hear('still there?')
    await flush()
    expect(h.turns.map(turn => turn.sessionId)).toEqual(['kept'])
    expect(h.session?.sessionId).toBe('kept')
    expect(said(h)).toEqual([JSON.stringify([{ text: 'Here.', voice: RECEPTIONIST_VOICE }])])
  })

  it('repeats the last exchanges word for word to a session the daemon has since compacted', async () => {
    const run = async (compactsAt: number) => {
      const h = harness({
        compactsAt,
        replies: [reply([{ from: 'control', text: 'Kevin is on it.' }]), reply([{ from: 'control', text: 'Sent.' }])],
      })
      await h.receptionist.hear('what is Kevin doing?')
      await flush()
      await h.receptionist.hear('tell him to do that now')
      await flush()
      return h.turns[1].prompt
    }
    const compacted = await run(Date.now() - 1_000)
    expect(compacted).toMatch(/^EARLIER CONVERSATION[^]*THE USER SAYS: what is Kevin doing\?[^]*YOU: [^\n]*Kevin is on it/)
    expect(compacted).toContain('THE USER SAYS: tell him to do that now')
    // Not yet compacted: the session still has it all, and the cache does too.
    expect(await run(Date.now() + 3_600_000)).toMatch(/^THE USER SAYS: tell him to do that now/)
  })

  it('lists the agents and directories when asked', async () => {
    const h = harness({
      replies: [
        reply([], [{ tool: 'list_agents' }]),
        (turn) => {
          expect(turn.prompt).toContain(`[${KEVIN}] (no name yet): water sim`)
          expect(turn.prompt).toContain('state: working')
          expect(turn.prompt).toContain(`[${DIR}] /Users/me/spaceterm`)
          return reply([{ from: 'control', text: 'Two agents.' }])
        },
      ],
    })
    await h.receptionist.hear("what's everyone up to?")
    await flush()
    expect(h.spoken).toHaveLength(1)
  })

  it('lists just the named agents, with handle and name, when asked for named_only', async () => {
    const h = harness({
      replies: [
        reply([{ from: 'control', text: `{${KEVIN}} is here.` }]),
        reply([], [{ tool: 'list_agents', named_only: true }]),
        (turn) => {
          expect(turn.prompt).toContain(`list_agents (named only):\n[${KEVIN}] Kevin: water sim`)
          expect(turn.prompt).not.toContain('login page')
          return reply([{ from: 'control', text: 'Found him.' }])
        },
      ],
    })
    await h.receptionist.hear('who is around?')
    await flush()
    await h.receptionist.hear('which one is Kevin?')
    await flush()
    expect(h.turns).toHaveLength(3)
  })

  it('finds an agent with Jev, reporting confidences and the chance of none', async () => {
    const queries: string[] = []
    const h = harness({
      findAgents: async (query) => {
        queries.push(query)
        return { hits: [{ nodeId: SALLY_ID, probability: 0.82 }, { nodeId: KEVIN_ID, probability: 0.1 }], noneProbability: 0.08 }
      },
      replies: [
        reply([], [{ tool: 'find_agent', query: 'the one fixing the login form validation' }]),
        (turn) => {
          expect(turn.prompt).toContain(`82% [${SALLY}]: login page (working)`)
          expect(turn.prompt).toContain('8% none of these')
          return reply([{ from: 'control', text: `{${SALLY}} is on it.` }])
        },
      ],
    })
    await h.receptionist.hear('who is doing the login form?')
    await flush()
    expect(queries).toEqual(['the one fixing the login form validation'])
  })

  it('falls back to list_agents when Jev fails', async () => {
    const h = harness({
      findAgents: async () => { throw new Error('jev is down') },
      replies: [
        reply([], [{ tool: 'find_agent', query: 'login' }]),
        (turn) => {
          expect(turn.prompt).toMatch(/find_agent failed: jev is down\. Use list_agents instead\./)
          return reply([{ from: 'control', text: 'Checking another way.' }])
        },
      ],
    })
    await h.receptionist.hear('who is doing login?')
    await flush()
  })

  it('speaks what it says alongside a read before the answer', async () => {
    const h = harness({
      replies: [
        reply([{ from: 'control', text: `Let me check {${KEVIN}}'s transcript.` }], [{ tool: 'read', agent: KEVIN }]),
        (turn) => {
          expect(turn.prompt).toContain('42 litres')
          return reply([{ from: KEVIN, text: 'Volume is conserved now.' }])
        },
      ],
    })
    await h.receptionist.hear('what did Kevin finish?')
    await flush()
    expect(h.spoken.map(entry => entry.content)).toEqual([
      [{ text: "Let me check Kevin's transcript.", voice: RECEPTIONIST_VOICE }],
      [{ text: 'Kevin here. Volume is conserved now.', voice: 'am_michael' }],
    ])
  })

  it('says with a read whether the agent\'s cache is warm, which decides whether to ask it', async () => {
    const h = harness({
      kevinCacheWarmUntil: Date.now() - 20 * 60_000,
      replies: [
        reply([], [{ tool: 'read', agent: KEVIN }]),
        (turn) => {
          expect(turn.prompt).toMatch(new RegExp(`read \\{${KEVIN}\\}:\\ncache: cold for 20 minutes \\(38k tokens\\)`))
          return reply([{ from: 'control', text: 'Summarized.' }])
        },
      ],
    })
    await h.receptionist.hear('what is Kevin up to?')
    await flush()
    expect(h.turns).toHaveLength(2)
  })

  it('searches the whole transcript, while a plain read stays recent', async () => {
    const h = harness({
      replies: [
        reply([], [{ tool: 'read', agent: KEVIN, search: 'ghost cells' }]),
        (turn) => {
          expect(turn.prompt).toContain('the boundary handling uses ghost cells')
          return reply([{ from: KEVIN, text: 'The boundary handling uses ghost cells.' }])
        },
      ],
    })
    await h.receptionist.hear('what did Kevin say about ghost cells?')
    await flush()
    expect(h.spoken).toHaveLength(1)
  })

  it('tells the model what was wrong with an unusable reply and lets it try again', async () => {
    const h = harness({
      replies: ['I think Kevin is fine.', (turn) => {
        expect(turn.prompt).toMatch(/not usable/)
        return reply([{ from: 'control', text: 'Kevin is fine.' }])
      }],
    })
    await h.receptionist.hear('how is Kevin?')
    await flush()
    expect(h.spoken).toHaveLength(1)
  })

  it('tells the model how much of an interrupted reply was heard', async () => {
    const h = harness({
      replies: [
        reply([{ from: 'control', text: 'Kevin is done.' }, { from: KEVIN, text: 'The solver works and the tests pass.' }]),
        (turn) => {
          expect(turn.prompt).toMatch(/^NOTE: Your last reply was cut off before the user heard all of it\. They heard only: "Kevin is done\. Kevin here\. The \*INTERRUPTED\*"/)
          expect(turn.prompt).toContain('THE USER SAYS: wait, what?')
          return reply([{ from: 'control', text: 'Sure.' }])
        },
      ],
      speechEnds: { state: 'interrupted_by_user', character_offset: 'Kevin is done. Kevin here. The sol'.length },
    })
    await h.receptionist.hear('how is Kevin?')
    await flush()
    await h.receptionist.hear('wait, what?')
    await flush()
    expect(h.turns).toHaveLength(2)
  })

  it('never overlaps two messages to the session, and says when a reply was talked over', async () => {
    let releaseStale: ((text: string) => void) | undefined
    const h = harness({
      replies: [
        reply([{ from: 'control', text: 'Will do.' }], [{ tool: 'monitor', agent: SALLY }]),
        () => new Promise<string>((resolve) => { releaseStale = resolve }),
        (turn) => {
          expect(turn.prompt).toContain('never spoken')
          expect(turn.prompt).toContain('THE USER SAYS: hello')
          return reply([{ from: 'control', text: 'Hello.' }])
        },
        reply([{ from: 'control', text: 'Sally finished.' }]),
      ],
    })
    await h.receptionist.hear('let me know when Sally is done')
    await flush()
    h.setState(SALLY_ID, 'stopped')
    await flush()
    void h.receptionist.hear('hello')
    await flush()
    // The talked-over turn is still being answered; the next must wait for it.
    expect(h.turns).toHaveLength(2)
    releaseStale?.(reply([{ from: 'control', text: 'Stale.' }]))
    await flush()
    expect(h.overlapped).toBe(false)
    expect(said(h).some(text => text.includes('Stale'))).toBe(false)
    // The event the talked-over turn carried was not lost.
    expect(said(h).some(text => text.includes('Sally finished'))).toBe(true)
    expect(h.turns[3].prompt).toContain('EVENTS')
  })

  it('speaks up when a monitored agent stops, and only then', async () => {
    const h = harness({
      replies: [
        reply([{ from: 'control', text: `I'll let you know when {${SALLY}} is done.` }], [{ tool: 'monitor', agent: SALLY }]),
        (turn) => {
          expect(turn.prompt).toContain('EVENTS')
          expect(turn.prompt).toContain('The user has not said anything')
          return reply([{ from: 'control', text: `{${SALLY}} has finished.` }])
        },
      ],
    })
    await h.receptionist.hear('tell me when Sally is done')
    await flush()
    h.setState(SALLY_ID, 'working_background')
    await flush()
    expect(h.turns).toHaveLength(1)
    h.setState(SALLY_ID, 'stopped')
    await flush()
    expect(h.turns).toHaveLength(2)
    // The monitor was used up.
    h.setState(SALLY_ID, 'working')
    h.setState(SALLY_ID, 'stopped')
    await flush()
    expect(h.turns).toHaveLength(2)
  })

  it('never asks the model about events while the user is dictating, then sends them all at once', async () => {
    const h = harness({
      replies: [
        reply([{ from: 'control', text: 'Watching both.' }], [{ tool: 'monitor', agent: SALLY }, { tool: 'monitor', agent: KEVIN }]),
        (turn) => {
          expect(turn.prompt).toContain(`{${SALLY}} is now`)
          expect(turn.prompt).toContain(`{${KEVIN}} is now`)
          return reply([{ from: 'control', text: 'Both are done.' }])
        },
      ],
    })
    await h.receptionist.hear('tell me when Sally and Kevin are done')
    await flush()
    h.receptionist.userSpeaking(true)
    h.setState(SALLY_ID, 'stopped')
    h.setState(KEVIN_ID, 'working')
    h.setState(KEVIN_ID, 'stopped')
    await flush()
    expect(h.turns).toHaveLength(1)
    h.receptionist.userSpeaking(false)
    await flush()
    expect(h.turns).toHaveLength(2)
    expect(said(h).at(-1)).toContain('Both are done.')
  })

  it('drops an unprompted turn when the user starts talking, and brings its events back once they stop', async () => {
    let releaseStale: ((text: string) => void) | undefined
    const h = harness({
      replies: [
        reply([{ from: 'control', text: 'Will do.' }], [{ tool: 'monitor', agent: SALLY }]),
        () => new Promise<string>((resolve) => { releaseStale = resolve }),
        (turn) => {
          expect(turn.prompt).toContain('never spoken')
          expect(turn.prompt).toContain(`{${SALLY}} is now`)
          return reply([{ from: 'control', text: 'Sally finished.' }])
        },
      ],
    })
    await h.receptionist.hear('let me know when Sally is done')
    await flush()
    h.setState(SALLY_ID, 'stopped')
    await flush()
    expect(h.turns).toHaveLength(2)
    h.receptionist.userSpeaking(true)
    releaseStale?.(reply([{ from: 'control', text: 'Stale news.' }]))
    await flush()
    expect(said(h).some(text => text.includes('Stale'))).toBe(false)
    expect(h.turns).toHaveLength(2)
    h.receptionist.userSpeaking(false)
    await flush()
    expect(said(h).at(-1)).toContain('Sally finished.')
  })

  it('holds a reply the user asked for until they stop talking', async () => {
    let answer: ((text: string) => void) | undefined
    const h = harness({ replies: [() => new Promise<string>((resolve) => { answer = resolve })] })
    void h.receptionist.hear('what is Kevin doing?')
    await flush()
    h.receptionist.userSpeaking(true)
    answer?.(reply([{ from: 'control', text: 'Kevin is testing.' }]))
    await flush()
    expect(h.spoken).toHaveLength(0)
    h.receptionist.userSpeaking(false)
    await flush()
    expect(said(h)).toEqual([JSON.stringify([{ text: 'Kevin is testing.', voice: RECEPTIONIST_VOICE }])])
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
        (turn) => {
          expect(turn.prompt).toContain('EVENTS')
          expect(turn.prompt).toContain('THE USER SAYS: any news?')
          return reply([{ from: 'control', text: 'Sally finished.' }])
        },
      ],
    })
    h.receptionist.setTalkToMe(false)
    await h.receptionist.hear('let me know when Sally is done')
    await flush()
    h.setState(SALLY_ID, 'stopped')
    await flush()
    expect(h.turns).toHaveLength(1)
    await h.receptionist.hear('any news?')
    await flush()
    expect(h.turns).toHaveLength(2)
  })

  it('asks the agent itself a side question, and toasts what it used', async () => {
    const h = harness({
      replies: [
        reply([{ from: 'control', text: `I'll ask {${KEVIN}}.` }], [{ tool: 'ask_agent', agent: KEVIN, question: 'Exactly how many litres?' }]),
        (turn) => {
          expect(turn.prompt).toContain(`{${KEVIN}} was asked "Exactly how many litres?" and answered: It was 42 litres exactly.`)
          return reply([{ from: KEVIN, text: 'It was 42 litres exactly.' }])
        },
      ],
    })
    await h.receptionist.hear('ask Kevin exactly how many litres')
    await flush()
    expect(h.sideQuestions).toEqual([{ nodeId: KEVIN_ID, prompt: sideQuestionPrompt('Exactly how many litres?') }])
    // The agent is told its answer is heard, word for word, so it writes something quotable.
    expect(h.sideQuestions[0].prompt).toMatch(/text-to-speech[^]*concise and conversational[^]*summarized by the receptionist[^]*Question: Exactly how many litres\?$/)
    expect(h.notices).toEqual(['Control asked Kevin: 38.3k cached, 0k new'])
    expect(h.spoken).toHaveLength(2)
  })

  it('tells the model why an agent could not answer, so it can send instead', async () => {
    const h = harness({
      askAgent: async () => ({ ok: false, reason: 'not-listening' }),
      replies: [
        reply([{ from: 'control', text: `I'll ask {${KEVIN}}.` }], [{ tool: 'ask_agent', agent: KEVIN, question: 'Done yet?' }]),
        (turn) => {
          expect(turn.prompt).toContain(`Asking {${KEVIN}} "Done yet?" failed: that agent cannot take side questions`)
          return reply([{ from: 'control', text: `{${KEVIN}} needs a restart before I can ask it things.` }])
        },
      ],
    })
    await h.receptionist.hear('ask Kevin if he is done')
    await flush()
    expect(h.notices).toEqual(["Control's question to Kevin failed: not-listening"])
  })

  it('sends a message to the real agent, records it, and then watches for its answer', async () => {
    const h = harness({
      replies: [
        reply([{ from: 'control', text: `Sent to {${KEVIN}}.` }], [{ tool: 'send', agent: KEVIN, message: 'Please finish up and commit.' }]),
        (turn) => {
          expect(turn.prompt).toContain('EVENTS')
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
    expect(h.turns).toHaveLength(2)
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

  it('starts a new agent in a directory, and watches for its first answer', async () => {
    const h = harness({
      replies: [
        reply([{ from: 'control', text: 'Starting one.' }], [
          { tool: 'spawn', directory: DIR, title: 'shorter answers', prompt: 'Make Control answer in one sentence.' },
        ]),
        (turn) => {
          expect(turn.prompt).toContain('EVENTS')
          return reply([{ from: 'control', text: 'The new agent finished.' }])
        },
      ],
    })
    await h.receptionist.hear('yes, start a new agent for that')
    await flush()
    expect(h.wire).toEqual([`spawn ${DIR_ID} shorter answers: Make Control answer in one sentence.`])
    h.setState(SALLY_ID, 'stopped')
    await flush()
    expect(h.turns).toHaveLength(2)
  })

  it('recalls from the full record what the session may have compacted away', async () => {
    const h = harness({
      replies: [
        reply([{ from: 'control', text: 'Noted the bananas.' }]),
        reply([{ from: 'control', text: 'Let me look back.' }], [{ tool: 'recall', search: 'bananas' }]),
        (turn) => {
          expect(turn.prompt).toContain('recall "bananas"')
          expect(turn.prompt).toContain('remember the bananas')
          expect(turn.prompt).toContain('Noted the bananas')
          return reply([{ from: 'control', text: 'You mentioned bananas.' }])
        },
      ],
    })
    await h.receptionist.hear('remember the bananas')
    await flush()
    await h.receptionist.hear('what did I say about bananas?')
    await flush()
    expect(said(h).some(text => text.includes('Let me look back'))).toBe(true)
  })

  it('refuses a miscopied handle before anything runs or is spoken, and suggests the real one', async () => {
    const typo = KEVIN.slice(0, -1) + (KEVIN.endsWith('x') ? 'y' : 'x')
    const h = harness({
      replies: [
        reply([{ from: 'control', text: `Sent to {${typo}}.` }], [{ tool: 'send', agent: typo, message: 'Commit, please.' }]),
        (turn) => {
          expect(turn.prompt).toMatch(/^NOTHING WAS DONE AND NOTHING YOU SAID WAS SPOKEN\./)
          expect(turn.prompt).toContain(`"${typo}" (in send) is not a live agent's name or handle. Did you mean [${KEVIN}]`)
          return reply([{ from: 'control', text: `Sent to {${KEVIN}}.` }], [{ tool: 'send', agent: KEVIN, message: 'Commit, please.' }])
        },
      ],
    })
    await h.receptionist.hear('tell Kevin to commit')
    await flush()
    expect(h.wire).toEqual([`send ${KEVIN_ID} Commit, please.`])
    expect(h.spoken.map(entry => entry.content)).toEqual([[{ text: 'Sent to Kevin.', voice: RECEPTIONIST_VOICE }]])
  })

  it('catches a miscopied handle in what it would say, too', async () => {
    const h = harness({
      replies: [
        reply([{ from: 'control', text: '{not-a-handle} finished.' }]),
        (turn) => {
          expect(turn.prompt).toContain('"not-a-handle" (in what you said) is not a live agent\'s name or handle.')
          return reply([{ from: 'control', text: `{${KEVIN}} finished.` }])
        },
      ],
    })
    await h.receptionist.hear('who finished?')
    await flush()
    expect(h.spoken.map(entry => entry.content)).toEqual([[{ text: 'Kevin finished.', voice: RECEPTIONIST_VOICE }]])
  })

  it('tells the model which agent each action reached, with the next message', async () => {
    const h = harness({
      replies: [
        reply([{ from: 'control', text: `Sent to {${KEVIN}}.` }], [{ tool: 'send', agent: KEVIN, message: 'Commit, please.' }, { tool: 'monitor', agent: SALLY }]),
        (turn) => {
          expect(turn.prompt).toContain(`NOTE: Your last actions: send delivered to [${KEVIN}] Kevin ("water sim")`)
          expect(turn.prompt).toContain(`monitor is watching [${SALLY}] Sally ("login page")`)
          return reply([{ from: 'control', text: 'Done.' }])
        },
      ],
    })
    await h.receptionist.hear('tell Kevin to commit and watch the login one')
    await flush()
    await h.receptionist.hear('ok')
    await flush()
    expect(h.turns).toHaveLength(2)
  })

  it('takes a live agent\'s name wherever a handle goes', async () => {
    const h = harness({
      replies: [
        reply([{ from: 'control', text: `{${KEVIN}} is on the water sim.` }]),
        reply([{ from: 'control', text: 'Sent to {Kevin}.' }, { from: 'kevin', text: 'Volume is conserved.' }], [{ tool: 'send', agent: 'Kevin', message: 'Commit, please.' }]),
      ],
    })
    await h.receptionist.hear('who is on the water sim?')
    await flush()
    await h.receptionist.hear('tell him to commit')
    await flush()
    expect(h.wire).toEqual([`send ${KEVIN_ID} Commit, please.`])
    expect(h.spoken[1].content).toEqual([
      { text: 'Sent to Kevin.', voice: RECEPTIONIST_VOICE },
      { text: 'Kevin here. Volume is conserved.', voice: 'am_michael' },
    ])
  })

  it('suggests the real name for a misheard one', async () => {
    const h = harness({
      replies: [
        reply([{ from: 'control', text: `{${KEVIN}} is here.` }]),
        reply([{ from: 'control', text: 'Asking {Kevn}.' }], [{ tool: 'monitor', agent: 'Kevn' }]),
        (turn) => {
          expect(turn.prompt).toContain(`"Kevn" (in monitor) is not a live agent's name or handle. Did you mean [${KEVIN}] Kevin ("water sim")?`)
          return reply([{ from: 'control', text: 'Watching {Kevin}.' }], [{ tool: 'monitor', agent: 'Kevin' }])
        },
      ],
    })
    await h.receptionist.hear('who is around?')
    await flush()
    await h.receptionist.hear('watch kevin')
    await flush()
    expect(h.turns).toHaveLength(3)
  })

  it('says what the user is looking at: an agent by handle, anything else for what it is', async () => {
    const view = { x: -500, y: -300, width: 1000, height: 600 }
    const h = harness({
      userView: () => ({
        view,
        nodes: [
          { nodeId: SALLY_ID, type: 'terminal', label: 'login page', distance: 0, inView: true },
          { nodeId: NOTE_ID, type: 'markdown', label: 'Design notes', distance: 120, inView: true },
          { nodeId: SHELL_ID, type: 'terminal', label: 'zsh', distance: 9_000, inView: false },
        ],
      }),
      replies: [
        reply([{ from: 'control', text: 'Let me see.' }], [{ tool: 'nearby' }]),
        (turn) => {
          expect(turn.prompt).toContain(`under the middle of the screen: [${SALLY}] ("login page"), an agent, working`)
          expect(turn.prompt).toContain(`on screen: [${NOTE}] a note "Design notes"`)
          expect(turn.prompt).toContain(`off screen, about 9 screens away: [${SHELL}] a terminal "zsh", not an agent you can act on`)
          return reply([{ from: 'control', text: `That's {${SALLY}}.` }])
        },
      ],
    })
    await h.receptionist.hear('what is this one doing?')
    await flush()
    expect(h.turns).toHaveLength(2)
  })

  it('moves the camera only with force_user_camera: to an agent, a directory, or a node from nearby', async () => {
    const h = harness({
      replies: [
        reply([{ from: 'control', text: `Here is {${KEVIN}}.` }], [{ tool: 'force_user_camera', target: KEVIN }]),
        reply([{ from: 'control', text: 'There.' }], [{ tool: 'force_user_camera', target: DIR }, { tool: 'force_user_camera', target: NOTE }]),
        (turn) => {
          expect(turn.prompt).toContain(`force_user_camera took the user to [${DIR}]`)
          return reply([{ from: 'control', text: 'Done.' }])
        },
      ],
    })
    await h.receptionist.hear('take me to Kevin')
    await flush()
    expect(h.focused).toEqual([KEVIN_ID])
    await h.receptionist.hear('show me the spaceterm directory, then the design notes')
    await flush()
    await h.receptionist.hear('thanks')
    await flush()
    expect(h.focused).toEqual([KEVIN_ID, DIR_ID, NOTE_ID])
  })

  it('refuses a camera target that is nothing, before anything moves', async () => {
    const h = harness({
      replies: [
        reply([{ from: 'control', text: 'Going there.' }], [{ tool: 'force_user_camera', target: 'node-nowhere-at-all' }]),
        (turn) => {
          expect(turn.prompt).toContain('"node-nowhere-at-all" (in force_user_camera) is not a live agent, a directory, or a node from nearby')
          return reply([{ from: 'control', text: 'I could not find that.' }])
        },
      ],
    })
    await h.receptionist.hear('take me there')
    await flush()
    expect(h.focused).toEqual([])
  })

  it('says so when no screen has reported where it is looking', async () => {
    const h = harness({
      replies: [
        reply([], [{ tool: 'nearby' }]),
        (turn) => {
          expect(turn.prompt).toContain('where the user is looking is unknown')
          return reply([{ from: 'control', text: 'Which one do you mean?' }])
        },
      ],
    })
    await h.receptionist.hear('what is this one doing?')
    await flush()
  })
})
