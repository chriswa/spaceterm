import { afterEach, describe, expect, it } from 'vitest'
import { asNodeId, type NodeId } from '../../shared/ids'
import type { ClaudeState } from '../../shared/state'
import type { TranscriptMessage } from '../summary-chat'
import type { SpeechBackend, SpeechContent, SpeechStatus } from '../voice-operator'
import type { SideQuestionResult } from '../side-questions'
import type { NamedVoice } from './name-voice-table'
import { RECEPTIONIST_VOICE } from './name-voice-table'
import { ASK_AGENT_REMINDER, BACK_REQUEST, HANDOVER_PROMPT, QUIET_OVER, RECEPTIONIST_SYSTEM_PROMPT } from './prompt'
import {
  PROMPT_HASH, Receptionist, SessionBusy, sideQuestionPrompt, type AgentRanking, type ReceptionistDeps, type SavedSession, type SessionTurn,
} from './receptionist'
import type { RosterAgent } from './roster'
import { DIRECTORY_PREFIX, Handles, NODE_PREFIX } from './handles'
import { Backlog } from './backlog'

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
  /** Where Control speaks to begin with, in place of the recording fake. */
  speech?: SpeechBackend
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
  /** Jev's verdict on cutting a reply short; by default never. */
  judgeInterruption?: ReceptionistDeps['judgeInterruption']
  /** Jev's probabilities for the backlog's items; by default it cannot say. */
  judgeBacklog?: ReceptionistDeps['judgeBacklog']
  /** What Control set aside before this server started. */
  backlog?: string[]
  /** How an unarchived agent comes back; by default up and ready. */
  unarchived?: 'ready' | 'not-ready' | 'failed'
  /** When Kevin's prompt cache goes cold (epoch ms); by default nothing is known of it. */
  kevinCacheWarmUntil?: number
}) {
  const states = new Map<NodeId, ClaudeState>([[KEVIN_ID, 'stopped'], [SALLY_ID, 'working']])
  /** Agents off the live roster: ended, or archived. */
  const gone = new Set<NodeId>()
  const agents = (): RosterAgent[] => [
    {
      nodeId: KEVIN_ID, title: 'water sim', cwd: '/src/fluids', state: states.get(KEVIN_ID)!, transcriptPath: '/t/kevin.jsonl', claudeSessionId: 'kevin-session',
      ...(opts.kevinCacheWarmUntil !== undefined ? { cacheWarmUntil: opts.kevinCacheWarmUntil, cacheWarmTokens: 38_000 } : {}),
    },
    { nodeId: SALLY_ID, title: 'login page', cwd: '/src/web', state: states.get(SALLY_ID)!, transcriptPath: '/t/sally.jsonl', claudeSessionId: 'sally-session' },
  ].filter(agent => !gone.has(agent.nodeId))
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
  let backlogJson: string | undefined
  const backlog = new Backlog({ store: { load: () => backlogJson, save: (json) => { backlogJson = json } } })
  // Set aside a minute apart, the last a minute ago.
  opts.backlog?.forEach((item, i, all) => backlog.add(item, Date.now() - (all.length - i) * 60_000))
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
      // The registry's rules are name-registry.test.ts's; this keeps only their shape.
      nameProblem: (nodeId, name) => {
        if (!/^[A-Za-z]+$/.test(name)) return { kind: 'not-a-name' }
        const holder = [...assigned].find(([id, named]) => id !== nodeId && named.name.toLowerCase() === name.toLowerCase())
        return holder ? { kind: 'taken', by: holder[0], name: holder[1].name } : undefined
      },
      setName: (nodeId, name, gender) => {
        const holder = [...assigned].find(([id, named]) => id !== nodeId && named.name.toLowerCase() === name.toLowerCase())
        if (holder) return { ok: false, problem: { kind: 'taken', by: holder[0], name: holder[1].name } }
        const previous = assigned.get(nodeId)
        const voice = previous?.gender === gender ? previous.voice : gender === 'feminine' ? 'af_bella' : 'am_adam'
        assigned.set(nodeId, { name, voice, gender })
        return { ok: true, named: assigned.get(nodeId)!, voiceChanged: previous !== undefined && previous.voice !== voice }
      },
    },
    askAgent: async (nodeId, prompt) => {
      sideQuestions.push({ nodeId, prompt })
      if (opts.askAgent) return opts.askAgent(nodeId, prompt)
      return { ok: true, text: 'It was 42 litres exactly.', usage: { cache_read_input_tokens: 38_291, input_tokens: 40 } }
    },
    focus: (nodeId) => focused.push(nodeId),
    nodeIds: () => NODE_IDS,
    judgeInterruption: opts.judgeInterruption ?? (async () => 0),
    backlog,
    judgeBacklog: opts.judgeBacklog ?? (async () => { throw new Error('no judge') }),
    archive: (nodeId) => { wire.push(`archive ${nodeId}`); gone.add(nodeId); return nodeId === KEVIN_ID ? 3 : 1 },
    unarchive: async (nodeId) => {
      wire.push(`unarchive ${nodeId}`)
      if (!gone.has(nodeId)) return 'not-archived'
      gone.delete(nodeId)
      return opts.unarchived ?? 'ready'
    },
    notify: (text) => notices.push(text),
    send: (nodeId, text) => wire.push(`send ${nodeId} ${text}`),
    interrupt: (nodeId) => wire.push(`escape ${nodeId}`),
    // As the server does: no device holds Control, so nobody hears it.
    letGo: () => { wire.push('let go'); receptionist.setListener(undefined) },
    directories: () => [{ nodeId: DIR_ID, cwd: '/Users/me/spaceterm' }],
    userView: opts.userView ?? (() => undefined),
    spawn: (directory, title, prompt) => { wire.push(`spawn ${directory} ${title}: ${prompt}`); return SALLY_ID },
    retitle: (nodeId, title) => wire.push(`retitle ${nodeId} ${title}`),
    log: () => {},
    sleep: async () => {},
    voiceOperatorDiscovered: () => true,
  }, { listener: { id: 'here', speech: opts.speech ?? speech }, onPhase: () => {}, onError: () => {} })
  return {
    receptionist, listener: { id: 'here', speech }, backlog, turns, spoken, focused, sideQuestions, assigned, wire, notices, record,
    get session() { return session },
    get overlapped() { return overlapped },
    setState(nodeId: NodeId, state: ClaudeState) {
      states.set(nodeId, state)
      receptionist.agentStateChanged(nodeId, state)
    },
    /** The agent's session exits and its surface goes into the archive, as a self-terminate does. */
    end(nodeId: NodeId) {
      const agent = agents().find(candidate => candidate.nodeId === nodeId)!
      gone.add(nodeId)
      receptionist.agentEnded(agent, true)
    },
  }
}

async function flush(turns = 30): Promise<void> {
  for (let i = 0; i < turns; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

/** An agent's token with whatever name it was given, then `rest`: the fake names agents in the order they are acted on. */
const namedToken = (handle: string, rest = ''): RegExp => new RegExp(`\\{\\w+:${handle}\\}${rest.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)
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

  it('starts one session, then sends only what is new into it, always with the instructions', async () => {
    const h = harness({ replies: [reply([{ from: 'control', text: 'Hi.' }]), reply([{ from: 'control', text: 'Again.' }])] })
    await h.receptionist.hear('hello')
    await flush()
    await h.receptionist.hear('anything else?')
    await flush()
    expect(h.turns[0]).toMatchObject({ systemPrompt: RECEPTIONIST_SYSTEM_PROMPT })
    expect(h.turns[0].sessionId).toBeUndefined()
    // The instructions go every time: a process the daemon resumes on the
    // session runs on whatever prompt the message carries, and on none if it
    // carries none, which leaves Control without its tools.
    expect(h.turns[1]).toMatchObject({ sessionId: 'session-1', systemPrompt: RECEPTIONIST_SYSTEM_PROMPT })
    // No roster, no history: the session has those.
    expect(h.turns[1].prompt).toMatch(/^THE USER SAYS: anything else\?/)
    expect(h.turns[1].prompt).not.toContain('hello')
    expect(h.session).toEqual({ sessionId: 'session-1', promptHash: PROMPT_HASH })
  })

  it('carries on the saved session after a restart', async () => {
    const same = harness({ saved: { sessionId: 'kept', promptHash: PROMPT_HASH }, replies: [reply([{ from: 'control', text: 'Yes.' }])] })
    await same.receptionist.hear('still there?')
    await flush()
    expect(same.turns).toHaveLength(1)
    expect(same.turns[0]).toMatchObject({ sessionId: 'kept', systemPrompt: RECEPTIONIST_SYSTEM_PROMPT })
  })

  it('moves to a new session on new instructions, after the old one hands over what it knows', async () => {
    const h = harness({
      saved: { sessionId: 'old', promptHash: 'other' },
      replies: ['The user is waiting on Kevin\'s water sim and wants to hear when it is done.', reply([{ from: 'control', text: 'Yes.' }]), reply([{ from: 'control', text: 'Still.' }])],
    })
    await h.receptionist.hear('still there?')
    await flush()
    // The old session runs on the instructions it keeps, so none are sent, and it is let go afterwards.
    expect(h.turns[0]).toEqual({ prompt: HANDOVER_PROMPT, sessionId: 'old', retiring: true })
    // A new session, on the new instructions, told what the old one knew.
    expect(h.turns[1].sessionId).toBeUndefined()
    expect(h.turns[1].systemPrompt).toBe(RECEPTIONIST_SYSTEM_PROMPT)
    expect(h.turns[1].prompt).toMatch(/^HANDOVER, from your previous session:\nThe user is waiting on Kevin's water sim[^]*THE USER SAYS: still there\?/)
    expect(h.session).toEqual({ sessionId: 'session-1', promptHash: PROMPT_HASH })
    // Once.
    await h.receptionist.hear('and now?')
    await flush()
    expect(h.turns[2]).toMatchObject({ sessionId: 'session-1' })
    expect(h.turns[2].prompt).not.toContain('HANDOVER')
  })

  it('still moves to a new session when the old one cannot hand over', async () => {
    const h = harness({
      saved: { sessionId: 'old', promptHash: 'other' },
      lostSessions: ['old'],
      replies: [reply([{ from: 'control', text: 'Yes.' }])],
    })
    await h.receptionist.hear('still there?')
    await flush()
    expect(h.turns.map(turn => turn.sessionId)).toEqual(['old', undefined])
    expect(h.turns[1].prompt).toMatch(/^THE USER SAYS: still there\?/)
    expect(said(h)).toEqual([JSON.stringify([{ text: 'Yes.', voice: RECEPTIONIST_VOICE }])])
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
      return h.turns[1]
    }
    const after = await run(Date.now() - 1_000)
    // The process that resumes the compacted session takes its instructions,
    // tool list included, from this message: Claude Code does not keep them.
    expect(after.systemPrompt).toBe(RECEPTIONIST_SYSTEM_PROMPT)
    const compacted = after.prompt
    expect(compacted).toMatch(/^EARLIER CONVERSATION[^]*THE USER SAYS: what is Kevin doing\?[^]*YOU: [^\n]*Kevin is on it/)
    expect(compacted).toContain('THE USER SAYS: tell him to do that now')
    // Not yet compacted: the session still has it all, and the cache does too.
    expect((await run(Date.now() + 3_600_000)).prompt).toMatch(/^THE USER SAYS: tell him to do that now/)
  })

  it('lists the agents and directories when asked', async () => {
    const h = harness({
      replies: [
        reply([], [{ tool: 'list_agents' }]),
        (turn) => {
          expect(turn.prompt).toContain(`{${KEVIN}} (no name yet): water sim`)
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
          expect(turn.prompt).toContain(`list_agents (named only):\n{Kevin:${KEVIN}}: water sim`)
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
          expect(turn.prompt).toContain(`82% {${SALLY}}: login page (working)`)
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
          expect(turn.prompt).toMatch(namedToken(SALLY, ' is now'))
          expect(turn.prompt).toMatch(namedToken(KEVIN, ' is now'))
          return reply([{ from: 'control', text: 'Both are done.' }])
        },
      ],
    })
    h.setState(KEVIN_ID, 'working')
    await h.receptionist.hear('tell me when Sally and Kevin are done')
    await flush()
    h.receptionist.userSpeaking(true)
    h.setState(SALLY_ID, 'stopped')
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
          expect(turn.prompt).toMatch(namedToken(SALLY, ' is now'))
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

  it('reports an answer that came before the monitor did, and ignores the stop of a declined question', async () => {
    // Sally is sitting on a question. The send's Escape declines it — a stop —
    // before the message goes in; then she works, and answers.
    const h = harness({
      replies: [
        reply([{ from: 'control', text: `Sent to {${SALLY}}.` }], [{ tool: 'send', agent: SALLY, message: 'Do not push.' }]),
        (turn) => {
          // Only her real answer, not the declined question's stop.
          expect(turn.prompt).toMatch(namedToken(SALLY, ' is now stopped'))
          expect(turn.prompt).toContain('Working on the login form validation.')
          return reply([{ from: 'control', text: 'She answered.' }])
        },
      ],
    })
    h.setState(SALLY_ID, 'waiting_question')
    await h.receptionist.hear('tell Sally not to push')
    await flush()
    h.setState(SALLY_ID, 'stopped')
    await flush()
    expect(h.turns).toHaveLength(1)
    h.setState(SALLY_ID, 'working')
    h.setState(SALLY_ID, 'stopped')
    await flush()
    expect(h.turns).toHaveLength(2)
  })

  it('fires a monitor set on an agent that already stopped unreported, but not again for a stop it reported', async () => {
    const h = harness({
      replies: [
        reply([{ from: 'control', text: 'Watching.' }], [{ tool: 'monitor', agent: KEVIN }]),
        (turn) => {
          expect(turn.prompt).toContain(`{Kevin:${KEVIN}} is now stopped`)
          return reply([], [{ tool: 'monitor', agent: KEVIN }])
        },
      ],
    })
    await h.receptionist.hear('tell me when Kevin is done')
    await flush()
    // Reported at once; watched again, the same stop is not reported twice.
    expect(h.turns).toHaveLength(2)
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

  it('acts on what it was asked while nobody can hear, refusing a reply that talks, and catches the user up on their return', async () => {
    const h = harness({
      replies: [
        reply([{ from: 'control', text: 'Will do.' }], [{ tool: 'monitor', agent: SALLY }]),
        (turn) => {
          expect(turn.prompt).toMatch(namedToken(SALLY, ' is now stopped'))
          expect(turn.prompt).toContain('THE USER IS AWAY')
          return reply([{ from: 'control', text: `Passing it to {${KEVIN}}.` }], [{ tool: 'send', agent: KEVIN, message: 'Sally fixed the form.' }])
        },
        (turn) => {
          expect(turn.prompt).toContain('the user is away, so "say" must be empty')
          return reply([], [{ tool: 'send', agent: KEVIN, message: 'Sally fixed the form.' }])
        },
        (turn) => {
          expect(turn.prompt).toContain('THE USER IS BACK')
          // What happened while they were gone, told again: the session may have compacted it away.
          expect(turn.prompt).toMatch(namedToken(SALLY, ' is now stopped'))
          expect(turn.prompt).not.toContain('THE USER IS AWAY')
          return reply([{ from: 'control', text: 'Sally finished, and I told Kevin.' }])
        },
      ],
    })
    await h.receptionist.hear('when Sally is done, tell Kevin what she did')
    await flush()
    h.receptionist.setListener(undefined)
    h.setState(SALLY_ID, 'stopped')
    await flush()
    // The refused reply's send never went; the silent one did, once.
    expect(h.wire).toEqual([`send ${KEVIN_ID} Sally fixed the form.`])
    expect(said(h)).toHaveLength(1)
    h.receptionist.setListener(h.listener)
    await flush()
    expect(h.turns).toHaveLength(4)
    expect(said(h).at(-1)).toContain('Sally finished, and I told Kevin.')
  })

  it('tells the user on their return where they left the reply they walked out on', async () => {
    const h = harness({
      replies: [
        reply([{ from: 'control', text: 'Kevin is done.' }, { from: KEVIN, text: 'The solver works and the tests pass.' }]),
        (turn) => {
          expect(turn.prompt).toContain('They left in the middle of your reply, and heard only: "Kevin is done. Kevin here. The *INTERRUPTED*')
          return reply([{ from: 'control', text: 'As I was saying.' }])
        },
      ],
      // The phone's page went, mid-sentence.
      speechEnds: { state: 'cancelled_by_client', character_offset: 'Kevin is done. Kevin here. The sol'.length },
    })
    await h.receptionist.hear('how is Kevin?')
    await flush()
    h.receptionist.setListener(undefined)
    await flush()
    expect(h.turns).toHaveLength(1)
    h.receptionist.setListener(h.listener)
    await flush()
    expect(h.turns).toHaveLength(2)
  })

  it('comes back without a word when nothing happened while the user was away', async () => {
    const h = harness({ replies: [reply([{ from: 'control', text: 'Hi.' }])] })
    await h.receptionist.hear('hello')
    await flush()
    h.receptionist.setListener(undefined)
    await flush()
    h.receptionist.setListener(h.listener)
    await flush()
    expect(h.turns).toHaveLength(1)
    // The same listener handed over again is no move either.
    h.receptionist.setListener(h.listener)
    await flush()
    expect(h.turns).toHaveLength(1)
  })

  it('after go_quiet with nothing missed, says nothing on return, and is told it is heard again with the next event', async () => {
    const h = harness({
      replies: [
        reply([], [{ tool: 'monitor', agent: KEVIN }, { tool: 'go_quiet' }]),
        (turn) => {
          expect(turn.prompt.indexOf(QUIET_OVER)).toBeGreaterThanOrEqual(0)
          expect(turn.prompt.indexOf(QUIET_OVER)).toBeLessThan(turn.prompt.indexOf('EVENTS:'))
          expect(turn.prompt).not.toContain('THE USER IS BACK')
          return reply([{ from: 'control', text: `{${KEVIN}} stopped.` }])
        },
        (turn) => {
          // Told once.
          expect(turn.prompt).not.toContain(QUIET_OVER)
          return reply([{ from: 'control', text: 'Sure.' }])
        },
      ],
    })
    // Working, so the monitor waits for its next stop.
    h.setState(KEVIN_ID, 'working')
    await h.receptionist.hear('watch Kevin, and be quiet')
    await flush()
    expect(h.wire).toEqual(['let go'])
    h.receptionist.setListener(h.listener)
    await flush()
    expect(h.turns).toHaveLength(1)
    h.setState(KEVIN_ID, 'stopped')
    await flush()
    expect(h.turns).toHaveLength(2)
    expect(said(h).join(' ')).toContain('stopped.')
    await h.receptionist.hear('thanks')
    await flush()
    expect(h.turns).toHaveLength(3)
  })

  it('after go_quiet, coming back by talking tells it it is heard again with the user\'s words, in one turn', async () => {
    const h = harness({
      replies: [
        reply([], [{ tool: 'go_quiet' }]),
        (turn) => {
          expect(turn.prompt).toContain(QUIET_OVER)
          expect(turn.prompt).toContain('THE USER SAYS: how is Kevin?')
          // Nothing was missed: no catching up.
          expect(turn.prompt).not.toContain('THE USER IS BACK')
          return reply([{ from: 'control', text: 'Kevin is fine.' }])
        },
      ],
    })
    await h.receptionist.hear('be quiet')
    await flush()
    // As the server does: speaking to Control takes it back, then is heard.
    h.receptionist.setListener(h.listener)
    void h.receptionist.hear('how is Kevin?')
    await flush()
    expect(h.turns).toHaveLength(2)
    expect(said(h)).toHaveLength(1)
  })

  it('after go_quiet, news that came while away gets a turn on return, which says it is heard again', async () => {
    const h = harness({
      replies: [
        reply([], [{ tool: 'monitor', agent: KEVIN }, { tool: 'go_quiet' }]),
        (turn) => {
          // Away: still quiet, and not told otherwise.
          expect(turn.prompt).toContain('THE USER IS AWAY')
          expect(turn.prompt).not.toContain(QUIET_OVER)
          return reply([])
        },
        (turn) => {
          expect(turn.prompt).toContain(QUIET_OVER)
          expect(turn.prompt).toContain('THE USER IS BACK')
          expect(turn.prompt).toContain(`They say: "${BACK_REQUEST}"`)
          expect(turn.prompt).toMatch(namedToken(KEVIN, ' is now stopped'))
          return reply([{ from: 'control', text: `{${KEVIN}} stopped while you were away.` }])
        },
      ],
    })
    h.setState(KEVIN_ID, 'working')
    await h.receptionist.hear('watch Kevin, and be quiet')
    await flush()
    h.setState(KEVIN_ID, 'stopped')
    await flush()
    expect(h.turns).toHaveLength(2)
    h.receptionist.setListener(h.listener)
    await flush()
    expect(h.turns).toHaveLength(3)
    expect(said(h).join(' ')).toContain('stopped while you were away.')
  })

  it('cuts off a reply when Control moves to another device, and carries on there from where it was cut', async () => {
    const cut = { id: 'long', state: 'cancelled_by_client' as const, character_offset: 'Kevin is done. Kevin here. The sol'.length, version: 2 }
    let dropped: (() => void) | undefined
    // The Mac, still talking when the phone takes Control.
    const mac: SpeechBackend = {
      speak: async () => ({ status: 202, body: { id: 'long', state: 'in_progress', playback_state: 'speaking', version: 1 } }),
      status: () => new Promise((resolve) => { dropped = () => resolve({ status: 410, body: cut }) }),
      drop: async () => { dropped?.(); return { status: 410, body: cut } },
    }
    const h = harness({
      speech: mac,
      replies: [
        reply([{ from: 'control', text: 'Kevin is done.' }, { from: KEVIN, text: 'The solver works and the tests pass.' }]),
        (turn) => {
          expect(turn.prompt).toContain('THE USER SWITCHED DEVICES')
          expect(turn.prompt).toContain('heard only: "Kevin is done. Kevin here. The *INTERRUPTED*')
          return reply([{ from: KEVIN, text: 'The solver works and the tests pass.' }])
        },
      ],
    })
    await h.receptionist.hear('how is Kevin?')
    await flush()
    expect(h.spoken).toHaveLength(0)
    h.receptionist.setListener({ id: 'phone', speech: h.listener.speech })
    await flush()
    expect(said(h)).toEqual([JSON.stringify([{ text: 'Kevin here. The solver works and the tests pass.', voice: 'am_michael' }])])
  })

  describe('self-interruption', () => {
    const LONG = `{${KEVIN}} is still working on the solver. He expects to need another hour, and then he will run the full test suite before he commits anything.`
    /** Speech that is audibly playing until dropped; a bare status read says where the voice is. */
    function playing(offset: () => number) {
      const spoken: SpeechContent[] = []
      const pending = new Map<string, () => void>()
      const polled = new Set<string>()
      let jobs = 0
      const cut = (id: string) => ({ status: 410, body: { id, state: 'cancelled_by_client' as const, character_offset: offset(), version: 3 } })
      const backend: SpeechBackend = {
        speak: async (content) => {
          spoken.push(content)
          return { status: 202, body: { id: `job-${++jobs}`, state: 'in_progress', playback_state: 'queued', version: 1 } }
        },
        status: (id, opts) => {
          if (opts === undefined) return Promise.resolve({ status: 200, body: { id, state: 'in_progress', playback_state: 'speaking', character_offset: offset(), version: 2 } })
          if (!polled.has(id)) {
            polled.add(id)
            return Promise.resolve({ status: 200, body: { id, state: 'in_progress', playback_state: 'speaking', version: 2 } })
          }
          return new Promise((resolve) => pending.set(id, () => resolve(cut(id))))
        },
        drop: async (id) => { pending.get(id)?.(); return cut(id) },
      }
      return { backend, spoken }
    }
    // The monitor ahead of the words: it is set at once, so news can come while they play.
    const watchSally = JSON.stringify({ say: [{ tool: 'monitor', agent: SALLY }, { from: 'control', text: LONG }], tools: [] })

    it('cuts its own reply short for news that makes the rest stale, says "Hang on.", and tells the model what was heard', async () => {
      const speech = playing(() => 'Kevin is still working'.length)
      const judged: string[] = []
      const h = harness({
        speech: speech.backend,
        judgeInterruption: async (ctx) => { judged.push(`${ctx.speech.currentWord}|${ctx.speech.remaining.slice(0, 15)}|${ctx.events.length}`); return 0.9 },
        replies: [
          watchSally,
          (turn) => {
            expect(turn.prompt).toContain('You stopped your own last reply to bring the news below, and have just said "Hang on."')
            // Cut where the voice was: the word being said counts as heard, the rest does not.
            expect(turn.prompt).toMatch(/The user heard only: "\w+ is still \*INTERRUPTED\*"/)
            expect(turn.prompt).toMatch(namedToken(SALLY, ' is now stopped'))
            return reply([{ from: 'control', text: `{${SALLY}} just finished.` }])
          },
        ],
      })
      await h.receptionist.hear('what is Kevin doing? and watch Sally')
      await flush()
      h.setState(SALLY_ID, 'stopped')
      await flush()
      expect(judged).toEqual(['working|on the solver. |1'])
      expect(speech.spoken.map(c => JSON.stringify(c))).toContainEqual(JSON.stringify([{ text: 'Hang on.', voice: RECEPTIONIST_VOICE }]))
      expect(h.turns).toHaveLength(2)
    })

    it('finishes without asking when a dozen words or fewer are left', async () => {
      const text = 'Kevin is still working on the solver. He expects to need another hour, and then he will run the full test suite before he commits anything.'
      const speech = playing(() => text.indexOf('run the full'))
      let asked = false
      const h = harness({ speech: speech.backend, judgeInterruption: async () => { asked = true; return 1 }, replies: [watchSally] })
      await h.receptionist.hear('what is Kevin doing? and watch Sally')
      await flush()
      h.setState(SALLY_ID, 'stopped')
      await flush()
      expect(asked).toBe(false)
      expect(h.turns).toHaveLength(1)
    })

    it('carries on below the threshold, and weighs the same news only once', async () => {
      const speech = playing(() => 'Kevin is'.length)
      let asked = 0
      const h = harness({ speech: speech.backend, judgeInterruption: async () => { asked++; return 0.2 }, replies: [watchSally] })
      await h.receptionist.hear('what is Kevin doing? and watch Sally')
      await flush()
      h.setState(SALLY_ID, 'stopped')
      await flush()
      h.receptionist.agentStateChanged(KEVIN_ID, 'working')
      await flush()
      expect(asked).toBe(1)
      expect(h.turns).toHaveLength(1)
    })
  })

  it('drops the words of a reply finished after the user left, and says so', async () => {
    let answer: ((text: string) => void) | undefined
    const h = harness({
      replies: [
        () => new Promise<string>((resolve) => { answer = resolve }),
        (turn) => {
          expect(turn.prompt).toContain('the user was away, so they heard none of it')
          expect(turn.prompt).toContain('A reply you wrote just as they left was never spoken.')
          return reply([{ from: 'control', text: 'Sorry, as I was saying.' }])
        },
      ],
    })
    void h.receptionist.hear('tell Kevin to commit')
    await flush()
    h.receptionist.setListener(undefined)
    answer?.(reply([{ from: 'control', text: `Sent to {${KEVIN}}.` }], [{ tool: 'send', agent: KEVIN, message: 'Commit.' }]))
    await flush()
    // Its tools ran all the same.
    expect(h.wire).toEqual([`send ${KEVIN_ID} Commit.`])
    expect(h.spoken).toHaveLength(0)
    h.receptionist.setListener(h.listener)
    await flush()
    expect(said(h)).toHaveLength(1)
  })

  it('asks the agent itself a side question, and toasts what it used', async () => {
    const h = harness({
      replies: [
        reply([{ from: 'control', text: `I'll ask {${KEVIN}}.` }], [{ tool: 'ask_agent', agent: KEVIN, question: 'Exactly how many litres?' }]),
        (turn) => {
          expect(turn.prompt).toContain(`{Kevin:${KEVIN}} was asked "Exactly how many litres?" and answered: It was 42 litres exactly. ${ASK_AGENT_REMINDER}`)
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

  it('says a just-resumed agent has nothing to ask yet, and to read its transcript instead', async () => {
    const h = harness({
      askAgent: async () => ({ ok: false, reason: 'nothing-to-fork' }),
      replies: [
        reply([{ from: 'control', text: `I'll ask {${KEVIN}}.` }], [{ tool: 'ask_agent', agent: KEVIN, question: 'Done yet?' }]),
        (turn) => {
          expect(turn.prompt).toContain('it was just restarted or resumed')
          expect(turn.prompt).toContain('answer from that with read instead')
          return reply([{ from: 'control', text: 'Reading instead.' }], [])
        },
      ],
    })
    await h.receptionist.hear('ask Kevin if he is done')
    await flush()
    expect(h.notices).toEqual(["Control's question to Kevin failed: it has not taken a turn since it was started or resumed"])
  })

  it('tells the model why an agent could not answer, so it can send instead', async () => {
    const h = harness({
      askAgent: async () => ({ ok: false, reason: 'not-listening' }),
      replies: [
        reply([{ from: 'control', text: `I'll ask {${KEVIN}}.` }], [{ tool: 'ask_agent', agent: KEVIN, question: 'Done yet?' }]),
        (turn) => {
          expect(turn.prompt).toContain(`Asking {Kevin:${KEVIN}} "Done yet?" failed: that agent's Claude Code was started before side questions were added`)
          expect(turn.prompt).toContain('This is not because it is busy')
          return reply([{ from: 'control', text: `{${KEVIN}} needs a restart before I can ask it things.` }])
        },
      ],
    })
    await h.receptionist.hear('ask Kevin if he is done')
    await flush()
    expect(h.notices).toEqual(["Control's question to Kevin failed: it was started before side questions existed, and takes them after a restart"])
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

  it('archives an agent when asked, says what went with it, and stops watching it', async () => {
    const h = harness({
      replies: [
        reply([{ from: 'control', text: 'Watching.' }], [{ tool: 'monitor', agent: KEVIN }]),
        reply([{ from: 'control', text: `Archived {${KEVIN}}.` }], [{ tool: 'archive_agent', agent: KEVIN }]),
        (turn) => {
          expect(turn.prompt).toContain(`archive_agent archived {Kevin:${KEVIN}}`)
          expect(turn.prompt).toContain('with the 2 nodes under it')
          return reply([{ from: 'control', text: 'Sure.' }])
        },
      ],
    })
    h.setState(KEVIN_ID, 'working')
    await h.receptionist.hear('tell me when Kevin is done')
    await flush()
    await h.receptionist.hear('archive Kevin')
    await flush()
    expect(h.wire).toEqual([`archive ${KEVIN_ID}`])
    // Archived once "Archived Kevin." had been said, so recorded after it.
    expect(h.record.at(-1)?.content).toMatch(/^ARCHIVED \{Kevin:/)
    // No longer watched: its stopping says nothing.
    h.setState(KEVIN_ID, 'working')
    h.setState(KEVIN_ID, 'stopped')
    await flush()
    expect(h.turns).toHaveLength(2)
    await h.receptionist.hear('thanks')
    await flush()
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

  it('starts a new agent with the name it was given, in a voice of that gender', async () => {
    const h = harness({
      replies: [
        reply([{ from: 'control', text: 'Starting Bob on the login page.' }], [
          { tool: 'spawn', directory: DIR, title: 'login page', prompt: 'Fix the login page.', name: 'Bob', gender: 'masculine' },
        ]),
        (turn) => {
          // The fake spawns onto Sally's node, so the new handle is hers with a suffix.
          expect(turn.prompt).toMatch(new RegExp(`spawn started \\{Bob:${SALLY}[-\\w]*\\} "login page"`))
          return reply([{ from: 'control', text: 'Yes.' }])
        },
      ],
    })
    await h.receptionist.hear('start an agent called Bob on the login page')
    await flush()
    expect(h.assigned.get(SALLY_ID)).toEqual({ name: 'Bob', voice: 'am_adam', gender: 'masculine' })
    await h.receptionist.hear('did it start?')
    await flush()
    expect(h.turns).toHaveLength(2)
  })

  it('renames an agent of the other gender into a voice to match, and is told its new token', async () => {
    const h = harness({
      replies: [
        reply([{ from: 'control', text: `{${KEVIN}} is now Ruth.` }], [
          { tool: 'rename_agent', agent: KEVIN, name: 'Ruth', gender: 'feminine' },
        ]),
        (turn) => {
          expect(turn.prompt).toContain(`rename_agent named it Ruth, in a new feminine voice to match: {Kevin:${KEVIN}} ("water sim") is now {Ruth:${KEVIN}}`)
          return reply([{ from: `{Ruth:${KEVIN}}`, text: 'Volume is conserved now.' }])
        },
      ],
    })
    await h.receptionist.hear('call Kevin Ruth from now on')
    await flush()
    expect(h.spoken[0].content).toEqual([{ text: 'Kevin is now Ruth.', voice: RECEPTIONIST_VOICE }])
    await h.receptionist.hear('what did she do?')
    await flush()
    expect(h.spoken[1].content).toEqual([{ text: 'Ruth here. Volume is conserved now.', voice: 'af_bella' }])
    expect(h.wire).toEqual([])
  })

  it('keeps the voice of an agent renamed to a name of the same gender, and retitles it', async () => {
    const h = harness({
      replies: [
        reply([{ from: 'control', text: `{${KEVIN}} is now Jim, on the fluids.` }], [
          { tool: 'rename_agent', agent: KEVIN, name: 'Jim', gender: 'masculine', title: 'fluids' },
        ]),
        (turn) => {
          expect(turn.prompt).toContain(`rename_agent named it Jim and titled it "fluids": {Kevin:${KEVIN}} ("water sim") is now {Jim:${KEVIN}}`)
          return reply([{ from: 'control', text: 'Yes.' }])
        },
      ],
    })
    await h.receptionist.hear('rename Kevin to Jim, and call it fluids')
    await flush()
    expect(h.assigned.get(KEVIN_ID)).toEqual({ name: 'Jim', voice: 'am_michael', gender: 'masculine' })
    expect(h.wire).toEqual([`retitle ${KEVIN_ID} fluids`])
    await h.receptionist.hear('done?')
    await flush()
    expect(h.turns).toHaveLength(2)
  })

  it('refuses a reply that gives an agent a name another agent has, before anything is said or done', async () => {
    const h = harness({
      replies: [
        reply([{ from: 'control', text: `{${KEVIN}} is on the water simulation.` }]),
        reply([{ from: 'control', text: `{${SALLY}} is now Kevin.` }], [
          { tool: 'rename_agent', agent: SALLY, name: 'kevin', gender: 'masculine' },
        ]),
        (turn) => {
          expect(turn.prompt).toContain('NOTHING WAS DONE AND NOTHING YOU SAID WAS SPOKEN.')
          expect(turn.prompt).toContain(`"kevin" (in rename_agent) cannot be given: that is, or sounds like, the name of {Kevin:${KEVIN}}`)
          return reply([{ from: 'control', text: 'Kevin is taken. What else should I call it?' }])
        },
      ],
    })
    await h.receptionist.hear('what is Kevin doing?')
    await flush()
    await h.receptionist.hear('call the login agent Kevin')
    await flush()
    expect(said(h).some(text => text.includes('is now Kevin'))).toBe(false)
    expect(h.assigned.get(SALLY_ID)).toBeUndefined()
    expect(said(h).at(-1)).toContain('Kevin is taken')
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
          expect(turn.prompt).toContain(`"${typo}" (in send) is not a live agent's token, name or handle. Did you mean {${KEVIN}}`)
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
          expect(turn.prompt).toContain('"not-a-handle" (in what you said) is not a live agent\'s token, name or handle.')
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
          expect(turn.prompt).toContain(`NOTE: Your last actions: send delivered to {Kevin:${KEVIN}} ("water sim")`)
          expect(turn.prompt).toContain(`monitor is watching {Sally:${SALLY}} ("login page")`)
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

  it('shows a named agent as one token, name and handle, in lists, results, events and read headers', async () => {
    const h = harness({
      replies: [
        reply([{ from: 'control', text: `Watching {${KEVIN}}.` }], [{ tool: 'monitor', agent: KEVIN }]),
        (turn) => {
          expect(turn.prompt).toContain(`monitor is watching {Kevin:${KEVIN}} ("water sim")`)
          expect(turn.prompt).toContain(`{Kevin:${KEVIN}} is now stopped`)
          return reply([], [{ tool: 'list_agents' }, { tool: 'read', agent: KEVIN }])
        },
        (turn) => {
          expect(turn.prompt).toContain(`{Kevin:${KEVIN}}: water sim`)
          expect(turn.prompt).toContain(`{${SALLY}} (no name yet): login page`)
          expect(turn.prompt).toContain(`read {Kevin:${KEVIN}}:`)
          // Never the handle and the name side by side, which is what the model copied.
          expect(turn.prompt).not.toContain(`${KEVIN}] Kevin`)
          return reply([{ from: 'control', text: `{Kevin:${KEVIN}} is done.` }])
        },
      ],
    })
    h.setState(KEVIN_ID, 'working')
    await h.receptionist.hear('tell me when Kevin is done')
    await flush()
    h.setState(KEVIN_ID, 'stopped')
    await flush()
    expect(said(h).at(-1)).toContain('Kevin is done.')
  })

  it('takes the full token wherever an agent goes, braces or not, and speaks the name once', async () => {
    const h = harness({
      replies: [
        reply([{ from: 'control', text: `{${KEVIN}} is on the water sim.` }]),
        reply(
          [{ from: 'control', text: `Sent to {Kevin:${KEVIN}}.` }, { from: `{Kevin:${KEVIN}}`, text: 'Volume is conserved.' }],
          [{ tool: 'send', agent: `{Kevin:${KEVIN}}`, message: 'Commit, please.' }, { tool: 'monitor', agent: `Kevin:${KEVIN}` }],
        ),
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

  it('lets the handle decide when the name in a token is wrong: the real name is spoken, and the model told', async () => {
    const h = harness({
      replies: [
        reply([{ from: 'control', text: `{${KEVIN}} is on the water sim.` }]),
        reply([{ from: 'control', text: `Sent to {Kevn:${KEVIN}}.` }], [{ tool: 'send', agent: `Kevn:${KEVIN}`, message: 'Commit, please.' }]),
        (turn) => {
          expect(turn.prompt).toContain(`you wrote {Kevn:${KEVIN}}, but ${KEVIN} is {Kevin:${KEVIN}}`)
          return reply([{ from: 'control', text: 'Okay.' }])
        },
      ],
    })
    await h.receptionist.hear('who is on the water sim?')
    await flush()
    await h.receptionist.hear('tell him to commit')
    await flush()
    expect(h.wire).toEqual([`send ${KEVIN_ID} Commit, please.`])
    expect(said(h)[1]).toBe(JSON.stringify([{ text: 'Sent to Kevin.', voice: RECEPTIONIST_VOICE }]))
    await h.receptionist.hear('thanks')
    await flush()
    expect(h.turns).toHaveLength(3)
  })

  it('refuses a token whose handle is no agent\'s, even when the name in front is right', async () => {
    const h = harness({
      replies: [
        reply([{ from: 'control', text: `{${KEVIN}} is here.` }]),
        reply([{ from: 'control', text: 'Watching {Kevin:not-a-handle}.' }], [{ tool: 'monitor', agent: 'Kevin:not-a-handle' }]),
        (turn) => {
          expect(turn.prompt).toMatch(/^NOTHING WAS DONE/)
          expect(turn.prompt).toContain(`"Kevin:not-a-handle" (in monitor) is not a live agent's token, name or handle. Did you mean {Kevin:${KEVIN}}`)
          return reply([{ from: 'control', text: `Watching {Kevin:${KEVIN}}.` }], [{ tool: 'monitor', agent: `Kevin:${KEVIN}` }])
        },
      ],
    })
    h.setState(KEVIN_ID, 'working')
    await h.receptionist.hear('who is around?')
    await flush()
    await h.receptionist.hear('watch kevin')
    await flush()
    expect(said(h).at(-1)).toBe(JSON.stringify([{ text: 'Watching Kevin.', voice: RECEPTIONIST_VOICE }]))
  })

  it('suggests the real name for a misheard one', async () => {
    const h = harness({
      replies: [
        reply([{ from: 'control', text: `{${KEVIN}} is here.` }]),
        reply([{ from: 'control', text: 'Asking {Kevn}.' }], [{ tool: 'monitor', agent: 'Kevn' }]),
        (turn) => {
          expect(turn.prompt).toContain(`"Kevn" (in monitor) is not a live agent's token, name or handle. Did you mean {Kevin:${KEVIN}} ("water sim")?`)
          return reply([{ from: 'control', text: 'Watching {Kevin}.' }], [{ tool: 'monitor', agent: 'Kevin' }])
        },
      ],
    })
    h.setState(KEVIN_ID, 'working')
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
          expect(turn.prompt).toContain(`under the middle of the screen: {${SALLY}} ("login page"), an agent, working`)
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

  it('goes quiet with go_quiet at once, saying nothing, even when the model wrote words around it', async () => {
    const h = harness({
      replies: [
        // Words before the call, among the parts, and after it: none of them is spoken.
        JSON.stringify({
          say: [{ from: 'control', text: 'Going quiet.' }, { tool: 'go_quiet' }, { from: 'control', text: 'Talk to me when you want me back.' }],
          tools: [{ tool: 'send', agent: KEVIN, message: 'carry on' }],
        }),
        (turn) => {
          expect(turn.prompt).toContain('go_quiet disconnected you at once, saying nothing')
          return reply([])
        },
      ],
    })
    await h.receptionist.hear('send Kevin carry on, then be quiet')
    await flush()
    expect(h.spoken).toEqual([])
    // The other actions in the reply still run; they just go unannounced.
    expect(h.wire).toEqual(['let go', `send ${KEVIN_ID} carry on`])
    expect(h.receptionist.phase).toBe('ready')
    // Disconnected: nothing it says from now on is heard.
    await h.receptionist.hear('anything?')
    await flush()
    expect(h.spoken).toEqual([])
    expect(h.wire).toEqual(['let go', `send ${KEVIN_ID} carry on`])
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

describe('Receptionist: agents it started, and agents that end', () => {
  it('hears from an agent it started at its next stop only, as after a send', async () => {
    const h = harness({
      replies: [
        reply([{ from: 'control', text: 'Starting one.' }], [
          { tool: 'spawn', directory: DIR, title: 'tidy', prompt: 'Tidy the imports.' },
        ]),
        (turn) => {
          expect(turn.prompt).toContain('which is now watched for its next stop')
          expect(turn.prompt).toContain('is now stopped')
          return reply([], [])
        },
      ],
    })
    h.setState(SALLY_ID, 'stopped')
    await h.receptionist.hear('start one to tidy the imports')
    await flush()
    // A stop on the way in — before it has worked on its prompt — is not its answer.
    h.setState(SALLY_ID, 'stopped')
    await flush()
    expect(h.turns).toHaveLength(1)
    h.setState(SALLY_ID, 'working')
    h.setState(SALLY_ID, 'stopped')
    await flush()
    expect(h.turns).toHaveLength(2)
    // The monitor was used up: neither a later stop nor its end is told.
    h.setState(SALLY_ID, 'working')
    h.setState(SALLY_ID, 'stopped')
    h.end(SALLY_ID)
    await flush()
    expect(h.turns).toHaveLength(2)
  })

  it('is told when an agent it started ends itself, and can still read what it said', async () => {
    const h = harness({
      replies: [
        reply([{ from: 'control', text: 'Starting one.' }], [
          { tool: 'spawn', directory: DIR, title: 'login page', prompt: 'Fix the login page.' },
        ]),
        (turn) => {
          expect(turn.prompt).toContain(`{${SALLY}} has ended: its session closed, and its surface went into the archive`)
          expect(turn.prompt).toContain('It last said: Working on the login form validation.')
          return reply([], [{ tool: 'read', agent: SALLY }])
        },
        (turn) => {
          expect(turn.prompt).toContain(`read {${SALLY}}:`)
          expect(turn.prompt).toContain('This agent has ended, so it cannot be asked')
          expect(turn.prompt).toContain('Fix the login page.')
          return reply([{ from: 'control', text: 'The login agent finished and closed itself.' }])
        },
      ],
    })
    await h.receptionist.hear('start one on the login page')
    await flush()
    h.end(SALLY_ID)
    await flush()
    expect(h.turns).toHaveLength(3)
    expect(said(h).some(text => text.includes('closed itself'))).toBe(true)
  })

  it('is told when a monitored agent ends, and only once, even with its last stop still unsaid', async () => {
    const h = harness({
      replies: [
        reply([{ from: 'control', text: 'Watching.' }], [{ tool: 'monitor', agent: KEVIN }]),
        (turn) => {
          expect(turn.prompt).toContain(`{Kevin:${KEVIN}} has ended`)
          expect(turn.prompt).not.toContain('is now stopped')
          return reply([{ from: 'control', text: 'Kevin has ended.' }])
        },
      ],
    })
    h.setState(KEVIN_ID, 'working')
    await h.receptionist.hear('tell me when Kevin is done')
    await flush()
    // Stopped and ended in one breath, while the user was talking: one event, the end.
    h.receptionist.userSpeaking(true)
    h.setState(KEVIN_ID, 'stopped')
    h.end(KEVIN_ID)
    h.receptionist.userSpeaking(false)
    await flush()
    expect(h.turns).toHaveLength(2)
  })

  it('says nothing when an agent nobody watched ends', async () => {
    const h = harness({ replies: [] })
    h.end(KEVIN_ID)
    await flush()
    expect(h.turns).toHaveLength(0)
  })

  it('refuses an ended agent for anything but read and unarchive_agent', async () => {
    const h = harness({
      replies: [
        reply([{ from: 'control', text: 'Watching.' }], [{ tool: 'monitor', agent: KEVIN }]),
        reply([], []),
        reply([{ from: 'control', text: `Sent to {Kevin:${KEVIN}}.` }], [{ tool: 'send', agent: `Kevin:${KEVIN}`, message: 'Carry on.' }]),
        (turn) => {
          expect(turn.prompt).toContain(`"Kevin:${KEVIN}" (in send) is no longer live: only read and unarchive_agent take it`)
          return reply([{ from: 'control', text: 'Kevin has ended; I can bring him back.' }])
        },
      ],
    })
    h.setState(KEVIN_ID, 'working')
    await h.receptionist.hear('tell me when Kevin is done')
    await flush()
    h.end(KEVIN_ID)
    await flush()
    await h.receptionist.hear('tell Kevin to carry on')
    await flush()
    expect(h.wire).toEqual([])
  })

  it('brings an ended agent back with unarchive_agent, after which it is live again', async () => {
    const h = harness({
      replies: [
        reply([{ from: 'control', text: 'Watching.' }], [{ tool: 'monitor', agent: KEVIN }]),
        reply([], []),
        reply([{ from: 'control', text: 'Bringing Kevin back.' }], [{ tool: 'unarchive_agent', agent: `Kevin:${KEVIN}` }]),
        (turn) => {
          expect(turn.prompt).toContain(`unarchive_agent brought back {Kevin:${KEVIN}} ("water sim"): it is live again`)
          return reply([{ from: 'control', text: `Sent to {Kevin:${KEVIN}}.` }], [{ tool: 'send', agent: `Kevin:${KEVIN}`, message: 'Carry on.' }])
        },
      ],
    })
    h.setState(KEVIN_ID, 'working')
    await h.receptionist.hear('tell me when Kevin is done')
    await flush()
    h.end(KEVIN_ID)
    await flush()
    await h.receptionist.hear('bring Kevin back')
    await flush()
    await h.receptionist.hear('tell him to carry on')
    await flush()
    expect(h.wire).toEqual([`unarchive ${KEVIN_ID}`, `send ${KEVIN_ID} Carry on.`])
    expect(h.record.some(message => message.content === `UNARCHIVED {Kevin:${KEVIN}}`)).toBe(true)
  })

  it('brings back an agent it archived itself, by name', async () => {
    const h = harness({
      replies: [
        reply([{ from: 'control', text: 'Watching.' }], [{ tool: 'monitor', agent: KEVIN }]),
        reply([{ from: 'control', text: 'Archived Kevin.' }], [{ tool: 'archive_agent', agent: KEVIN }]),
        reply([{ from: 'control', text: 'Bringing Kevin back.' }], [{ tool: 'unarchive_agent', agent: 'Kevin' }]),
        (turn) => {
          expect(turn.prompt).toContain('unarchive_agent brought back')
          return reply([{ from: 'control', text: 'Sure.' }])
        },
      ],
    })
    h.setState(KEVIN_ID, 'working')
    await h.receptionist.hear('tell me when Kevin is done')
    await flush()
    await h.receptionist.hear('archive Kevin')
    await flush()
    await h.receptionist.hear('actually, bring Kevin back')
    await flush()
    await h.receptionist.hear('thanks')
    await flush()
    expect(h.wire).toEqual([`archive ${KEVIN_ID}`, `unarchive ${KEVIN_ID}`])
  })

  it('says unarchive_agent changed nothing for an agent that is live', async () => {
    const h = harness({
      replies: [
        reply([{ from: 'control', text: 'Done.' }], [{ tool: 'unarchive_agent', agent: KEVIN }]),
        (turn) => {
          expect(turn.prompt).toContain('is live, not archived, so nothing changed')
          return reply([{ from: 'control', text: 'Kevin was never archived.' }])
        },
      ],
    })
    await h.receptionist.hear('unarchive Kevin')
    await flush()
    await h.receptionist.hear('ok')
    await flush()
    expect(h.wire).toEqual([])
  })
})

/**
 * Speech the test plays by hand, as Voice Operator reports it: `heard` moves
 * the voice on through the newest job, `end` finishes it or cuts it off.
 * Long polls wait for the next change, as `?since=` does.
 */
function handPlayed() {
  const spoken: SpeechContent[] = []
  const jobs = new Map<string, { status: Partial<SpeechStatus>; version: number; waiters: Array<() => void> }>()
  let count = 0
  const update = (id: string, status: Partial<SpeechStatus>): void => {
    const job = jobs.get(id)!
    job.status = { ...job.status, ...status }
    job.version++
    for (const wake of job.waiters.splice(0)) wake()
  }
  const newest = (): string => `job-${count}`
  const backend: SpeechBackend = {
    speak: async (content) => {
      spoken.push(content)
      const id = `job-${++count}`
      jobs.set(id, { status: { state: 'in_progress', playback_state: 'queued' }, version: 1, waiters: [] })
      return { status: 202, body: { id, state: 'in_progress', playback_state: 'queued', version: 1 } }
    },
    status: async (id, opts) => {
      const job = jobs.get(id)!
      if (opts?.since !== undefined && job.version <= opts.since && job.status.state === 'in_progress') {
        await new Promise<void>((resolve) => job.waiters.push(resolve))
      }
      return { status: 200, body: { id, ...job.status, version: job.version } }
    },
    drop: async (id) => {
      if (jobs.get(id)!.status.state === 'in_progress') update(id, { state: 'cancelled_by_client' })
      return { status: 410, body: { id, ...jobs.get(id)!.status } }
    },
  }
  return {
    backend, spoken,
    heard: (offset: number, id = newest()) => update(id, { playback_state: 'speaking', character_offset: offset }),
    end: (state: Exclude<SpeechStatus['state'], 'in_progress'>, offset?: number, id = newest()) =>
      update(id, { state, ...(offset !== undefined ? { character_offset: offset } : {}) }),
  }
}

describe('Receptionist actions wait for the words before them', () => {
  /** "Sent to Kevin." with a send to Kevin after it, then more words, then a send to Sally after all of them. */
  const sendBoth = JSON.stringify({
    say: [
      { from: 'control', text: `Sent to {${KEVIN}}.` },
      { tool: 'send', agent: KEVIN, message: 'Run the tests.' },
      { from: 'control', text: 'And Sally is still on the login page.' },
    ],
    tools: [{ tool: 'send', agent: SALLY, message: 'Push it.' }],
  })
  const toKevin = `send ${KEVIN_ID} Run the tests.`
  const toSally = `send ${SALLY_ID} Push it.`

  it('runs each action the moment its words are heard', async () => {
    const speech = handPlayed()
    const h = harness({ speech: speech.backend, replies: [sendBoth] })
    await h.receptionist.hear('tell Kevin to run the tests and Sally to push')
    await flush()
    expect(h.wire).toEqual([])
    speech.heard('Sent to Kev'.length)
    await flush()
    expect(h.wire).toEqual([])
    speech.heard('Sent to Kevin'.length)
    await flush()
    expect(h.wire).toEqual([toKevin])
    speech.end('completed', 'Sent to Kevin. And Sally is still on the login page.'.length)
    await flush()
    expect(h.wire).toEqual([toKevin, toSally])
  })

  it('does not run an action whose words the user talked over, and tells the model exactly which', async () => {
    const speech = handPlayed()
    const h = harness({
      speech: speech.backend,
      replies: [
        sendBoth,
        (turn) => {
          expect(turn.prompt).toContain(
            `NOT DONE: the user talked over the words that lead up to them, so this action was not carried out: {"tool":"send","agent":"${SALLY}","message":"Push it."}.`,
          )
          return reply([{ from: 'control', text: 'Holding off.' }])
        },
      ],
    })
    await h.receptionist.hear('tell Kevin to run the tests and Sally to push')
    await flush()
    speech.heard('Sent to Kevin'.length)
    speech.end('interrupted_by_user', 'Sent to Kevin. And Sally'.length)
    await flush()
    expect(h.wire).toEqual([toKevin])
    await h.receptionist.hear('wait, not Sally')
    await flush()
    expect(h.wire).toEqual([toKevin])
    expect(h.turns).toHaveLength(2)
  })

  it('does not run what was still waiting when the user speaks over the reply, or stops Control', async () => {
    const speech = handPlayed()
    const h = harness({
      speech: speech.backend,
      replies: [
        sendBoth,
        (turn) => {
          expect(turn.prompt).toContain('NOT DONE: the user stopped you before the words that lead up to them were said, so these actions were not carried out:')
          expect(turn.prompt).toContain(`{"tool":"send","agent":"${KEVIN}","message":"Run the tests."}; {"tool":"send","agent":"${SALLY}","message":"Push it."}`)
          return reply([{ from: 'control', text: 'Stopped.' }])
        },
      ],
    })
    await h.receptionist.hear('tell Kevin to run the tests and Sally to push')
    await flush()
    await h.receptionist.cancel()
    await flush()
    expect(h.wire).toEqual([])
    await h.receptionist.hear('what did you do?')
    await flush()
    expect(h.wire).toEqual([])
  })

  it('runs everything still waiting when nobody is left to hear it', async () => {
    const speech = handPlayed()
    const h = harness({ speech: speech.backend, replies: [sendBoth] })
    await h.receptionist.hear('tell Kevin to run the tests and Sally to push')
    await flush()
    expect(h.wire).toEqual([])
    h.receptionist.setListener(undefined)
    await flush()
    expect(h.wire).toEqual([toKevin, toSally])
  })

  it('acts on a monitor with nobody listening, without waiting for speech', async () => {
    const h = harness({
      replies: [
        reply([{ from: 'control', text: `I'll tell {${SALLY}} when {${KEVIN}} is done.` }], [{ tool: 'monitor', agent: KEVIN }]),
        (turn) => {
          expect(turn.prompt).toMatch(namedToken(KEVIN, ' is now stopped'))
          return reply([], [{ tool: 'send', agent: SALLY, message: 'Kevin says the solver is done.' }])
        },
      ],
    })
    h.setState(KEVIN_ID, 'working')
    await h.receptionist.hear('when Kevin finishes, tell Sally what he said')
    await flush()
    h.receptionist.setListener(undefined)
    h.setState(KEVIN_ID, 'stopped')
    await flush()
    expect(h.wire).toEqual([`send ${SALLY_ID} Kevin says the solver is done.`])
  })

  it('tells the model which actions never ran when its unprompted reply was dropped for the user talking', async () => {
    let releaseStale: ((text: string) => void) | undefined
    const h = harness({
      replies: [
        reply([{ from: 'control', text: 'Will do.' }], [{ tool: 'monitor', agent: SALLY }]),
        () => new Promise<string>((resolve) => { releaseStale = resolve }),
        (turn) => {
          expect(turn.prompt).toContain('Your previous reply was never spoken')
          expect(turn.prompt).toContain(`so this action was not carried out: {"tool":"send","agent":"${KEVIN}","message":"Restart the daemon."}`)
          return reply([{ from: 'control', text: 'Sending it now.' }], [{ tool: 'send', agent: KEVIN, message: 'Restart the daemon.' }])
        },
      ],
    })
    await h.receptionist.hear('let me know when Sally is done')
    await flush()
    h.setState(SALLY_ID, 'stopped')
    await flush()
    h.receptionist.userSpeaking(true)
    releaseStale?.(reply([{ from: 'control', text: `Asked {${KEVIN}}.` }], [{ tool: 'send', agent: KEVIN, message: 'Restart the daemon.' }]))
    await flush()
    expect(h.wire).toEqual([])
    // Their words were for someone else: the events get their turn again, with the note.
    h.receptionist.userSpeaking(false)
    await flush()
    expect(h.wire).toEqual([`send ${KEVIN_ID} Restart the daemon.`])
  })
})

describe('Receptionist unarchive_agent', () => {
  it('brings the agent back after its words are heard, waits until it is ready, and lets the next step send to it', async () => {
    const speech = handPlayed()
    const h = harness({
      speech: speech.backend,
      replies: [
        // Not live yet, so named in plain words.
        reply([{ from: 'control', text: 'Bringing Kevin back.' }], [{ tool: 'unarchive_agent', agent: KEVIN }]),
        (turn) => {
          expect(turn.prompt).toContain(`{${KEVIN}} ("water sim"): it is live again and ready`)
          return reply([{ from: 'control', text: `Sent to {${KEVIN}}.` }], [{ tool: 'send', agent: KEVIN, message: 'Restart the daemon.' }])
        },
      ],
    })
    h.end(KEVIN_ID)
    // Not awaited: the turn waits for its words to be heard.
    void h.receptionist.hear('bring Kevin back and have him restart the daemon')
    await flush()
    expect(h.wire).toEqual([])
    speech.end('completed', 'Bringing Kevin back.'.length)
    await flush()
    expect(h.wire).toEqual([`unarchive ${KEVIN_ID}`])
    expect(h.turns).toHaveLength(2)
    speech.end('completed')
    await flush()
    expect(h.wire).toEqual([`unarchive ${KEVIN_ID}`, `send ${KEVIN_ID} Restart the daemon.`])
  })

  it('says so when the agent came back but did not say it was ready', async () => {
    const h = harness({
      unarchived: 'not-ready',
      replies: [
        reply([{ from: 'control', text: 'Bringing it back.' }], [{ tool: 'unarchive_agent', agent: KEVIN }]),
        (turn) => {
          expect(turn.prompt).toContain('has not said it is ready yet, so a message sent now may be lost')
          return reply([{ from: 'control', text: 'It is coming back.' }])
        },
      ],
    })
    h.end(KEVIN_ID)
    await h.receptionist.hear('bring Kevin back')
    await flush()
    expect(h.turns).toHaveLength(2)
  })
})

describe('Receptionist backlog', () => {
  it('shows how many items are set aside on every turn while there are any, and not after', async () => {
    const h = harness({
      backlog: ['Leon finished; the user has not heard its report.'],
      replies: [
        (turn) => {
          expect(turn.prompt).toContain('BACKLOG: 1 item set aside for later.')
          return reply([], [{ tool: 'backlog_next' }])
        },
        reply([{ from: 'control', text: 'Leon finished.' }]),
        (turn) => {
          expect(turn.prompt).not.toContain('BACKLOG')
          return reply([{ from: 'control', text: 'Sure.' }])
        },
      ],
    })
    await h.receptionist.hear('thanks, that settles it')
    await flush()
    await h.receptionist.hear('ok')
    await flush()
    expect(h.turns).toHaveLength(3)
  })

  it('sets something aside silently, in the same step, as neither an action nor a lookup', async () => {
    const h = harness({
      replies: [
        reply([{ from: 'control', text: 'Will do.' }], [{ tool: 'monitor', agent: SALLY }]),
        reply([], [{ tool: 'backlog_add', item: `{${SALLY}} finished the login page.` }]),
        (turn) => {
          expect(turn.prompt).toContain('BACKLOG: 1 item set aside for later.')
          expect(turn.prompt).not.toContain('NOT DONE')
          expect(turn.prompt).not.toContain('Your last actions')
          return reply([{ from: 'control', text: 'Yes.' }])
        },
      ],
    })
    await h.receptionist.hear('let me know when Sally is done')
    await flush()
    h.setState(SALLY_ID, 'stopped')
    await flush()
    // One model step for the event: setting it aside cost no second one.
    expect(h.turns).toHaveLength(2)
    expect(h.spoken).toHaveLength(1)
    expect(h.backlog.all().map(item => item.text)).toEqual([`{${SALLY}} finished the login page.`])
    await h.receptionist.hear('right, so we agree?')
    await flush()
  })

  it('gives Control the item Jev picks, and takes it off the backlog', async () => {
    const h = harness({
      backlog: ['Dean asked two questions.', 'Leon finished the go-quiet follow-up.', 'Sally is stuck on an error.'],
      judgeBacklog: async (ctx) => {
        expect(ctx.items.map(item => item.text)).toHaveLength(3)
        expect(ctx.conversation).toContain('that settles it')
        return [0.1, 0.2, 0.7]
      },
      replies: [
        reply([], [{ tool: 'backlog_next' }]),
        (turn) => {
          expect(turn.prompt).toMatch(/backlog_next: Sally is stuck on an error\. \(set aside 1 minute ago\)\. It is off the backlog now; 2 items are still waiting\./)
          return reply([{ from: 'control', text: 'Sally is stuck. Two more things after that.' }])
        },
      ],
    })
    await h.receptionist.hear('thanks, that settles it')
    await flush()
    expect(h.backlog.all().map(item => item.text)).toEqual(['Dean asked two questions.', 'Leon finished the go-quiet follow-up.'])
  })

  it('takes the one item about what the user asks about', async () => {
    const h = harness({
      backlog: ['Dean asked two questions.', 'Leon finished the go-quiet follow-up.', 'Sally is stuck on an error.'],
      judgeBacklog: async (ctx) => {
        expect(ctx.about).toBe("Leon's go-quiet follow-up")
        return [0.05, 0.9, 0.03]
      },
      replies: [
        reply([], [{ tool: 'backlog_next', about: "Leon's go-quiet follow-up" }]),
        (turn) => {
          expect(turn.prompt).toContain('backlog_next: Leon finished the go-quiet follow-up. (set aside 2 minutes ago). It is off the backlog now; 2 items are still waiting.')
          return reply([{ from: 'control', text: 'Leon finished it.' }])
        },
      ],
    })
    await h.receptionist.hear('what happened with Leon?')
    await flush()
    expect(h.backlog.all().map(item => item.text)).toEqual(['Dean asked two questions.', 'Sally is stuck on an error.'])
  })

  it('takes every item about what the user asks about, and puts them all back if the reply goes unheard', async () => {
    let h: ReturnType<typeof harness> | undefined
    h = harness({
      backlog: ['Leon finished the go-quiet work.', 'Dean asked two questions.', 'Leon asked whether to restart the server.'],
      judgeBacklog: async () => [0.8, 0.1, 0.7],
      replies: [
        reply([], [{ tool: 'backlog_next', about: "Leon's go-quiet work" }]),
        (turn) => {
          expect(turn.prompt).toContain('backlog_next: 2 items:\n- Leon finished the go-quiet work. (set aside 3 minutes ago)\n- Leon asked whether to restart the server.')
          expect(turn.prompt).toContain('They are off the backlog now; 1 item is still waiting. If the user does not want any of them now, add those back with backlog_add.')
          h!.receptionist.userSpeaking(true)
          return reply([{ from: 'control', text: 'Two things from Leon.' }])
        },
        reply([{ from: 'control', text: 'Go ahead.' }]),
      ],
    })
    void h.receptionist.hear('where are we with Leon?')
    await flush()
    expect(h.backlog.all().map(item => item.text)).toEqual(['Dean asked two questions.'])
    const answered = h.receptionist.hear('actually, wait')
    h.receptionist.userSpeaking(false)
    await answered
    await flush()
    expect(h.backlog.size).toBe(3)
  })

  it('takes nothing when no item is the one Control asks for', async () => {
    const h = harness({
      backlog: ['Dean asked two questions.', 'Leon finished.'],
      judgeBacklog: async () => [0.1, 0.1],
      replies: [
        reply([], [{ tool: 'backlog_next', about: 'the release notes' }]),
        (turn) => {
          expect(turn.prompt).toContain('backlog_next: nothing on the backlog is about the release notes, so nothing was taken off it; 2 items are still waiting.')
          return reply([{ from: 'control', text: 'Nothing new on the release notes.' }])
        },
      ],
    })
    await h.receptionist.hear('any news on the release notes?')
    await flush()
    expect(h.backlog.size).toBe(2)
  })

  it('notes the agents an item names, and warns Jev when one is about to go cold', async () => {
    const h = harness({
      kevinCacheWarmUntil: Date.now() + 3 * 60_000,
      backlog: ['Dean asked two questions.'],
      judgeBacklog: async (ctx) => {
        expect(ctx.items[0].cache).toBeUndefined()
        expect(ctx.items[1].cache).toMatch(new RegExp(`^WARNING: \\{(\\w+:)?${KEVIN}\\}'s prompt cache goes cold in 3 minutes`))
        return [0.3, 0.7]
      },
      replies: [
        reply([{ from: 'control', text: 'Noted.' }], [{ tool: 'backlog_add', item: `{${KEVIN}} finished the water simulation.` }]),
        reply([], [{ tool: 'backlog_next' }]),
        reply([{ from: 'control', text: 'Kevin finished.' }]),
      ],
    })
    await h.receptionist.hear('anyway')
    await flush()
    expect(h.backlog.all()[1].agents).toEqual([KEVIN_ID])
    await h.receptionist.hear('done with that')
    await flush()
    expect(h.backlog.all().map(item => item.text)).toEqual(['Dean asked two questions.'])
  })

  it('gives the oldest item when Jev cannot say', async () => {
    const h = harness({
      backlog: ['Dean asked two questions.', 'Leon finished.'],
      replies: [
        reply([], [{ tool: 'backlog_next' }]),
        (turn) => {
          expect(turn.prompt).toContain('backlog_next: Dean asked two questions.')
          return reply([{ from: 'control', text: 'Dean asked you two things.' }])
        },
      ],
    })
    await h.receptionist.hear('done with that')
    await flush()
    expect(h.backlog.all().map(item => item.text)).toEqual(['Leon finished.'])
  })

  it('puts the item back when the reply that would bring it up is never heard', async () => {
    let h: ReturnType<typeof harness> | undefined
    h = harness({
      backlog: ['Leon finished.'],
      replies: [
        reply([], [{ tool: 'backlog_next' }]),
        () => {
          // The user starts talking before the reply can be said.
          h!.receptionist.userSpeaking(true)
          return reply([{ from: 'control', text: 'Leon finished.' }])
        },
        (turn) => {
          expect(turn.prompt).toContain('BACKLOG: 1 item set aside for later.')
          return reply([{ from: 'control', text: 'Go ahead.' }])
        },
      ],
    })
    void h.receptionist.hear('ok, done')
    await flush()
    expect(h.backlog.size).toBe(0)
    const answered = h.receptionist.hear('wait, one more thing')
    h.receptionist.userSpeaking(false)
    await answered
    await flush()
    expect(said(h).some(text => text.includes('Leon finished'))).toBe(false)
    expect(h.backlog.all().map(item => item.text)).toEqual(['Leon finished.'])
  })

  it('keeps news set aside mid-topic in front of Control until the topic is wrapped up', async () => {
    // Today's sequence: Leon stops while Control and the user are going through
    // Dean's questions. Control sets it aside; when the user says "Yeah" and the
    // answers go to Dean, it is still there to bring up.
    const h = harness({
      replies: [
        reply([{ from: 'control', text: 'Will do.' }], [{ tool: 'monitor', agent: SALLY }]),
        reply([{ from: 'control', text: 'Shall I send Kevin the three answers?' }]),
        reply([], [{ tool: 'backlog_add', item: `{${SALLY}} finished; the user has not heard its report.` }]),
        (turn) => {
          expect(turn.prompt).toContain('THE USER SAYS: Yeah.')
          expect(turn.prompt).toContain('BACKLOG: 1 item set aside for later.')
          return reply([], [{ tool: 'backlog_next' }])
        },
        (turn) => {
          expect(turn.prompt).toContain('finished; the user has not heard its report')
          return reply([{ from: 'control', text: `Sent. Meanwhile, {${SALLY}} finished.` }], [{ tool: 'send', agent: KEVIN, message: 'the answers' }])
        },
      ],
    })
    await h.receptionist.hear('let me know when Sally is done')
    await flush()
    await h.receptionist.hear('early audio: drop it for now')
    await flush()
    h.setState(SALLY_ID, 'stopped')
    await flush()
    await h.receptionist.hear('Yeah.')
    await flush()
    expect(said(h).some(text => text.includes('Meanwhile'))).toBe(true)
    expect(h.backlog.size).toBe(0)
  })
})
