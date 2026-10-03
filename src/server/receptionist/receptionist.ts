import { createHash } from 'crypto'
import type { NodeId } from '../../shared/ids'
import type { ClaudeState } from '../../shared/state'
import { serverLog } from '../server-log'
import { finalAgentMessage, type TranscriptMessage } from '../summary-chat'
import type { SpeechBackend } from '../voice-operator'
import { SpeechChannel, speechFailureMessage, type Attempt, type SpeechPhase } from '../speech-channel'
import type { NamedVoice } from './name-voice-table'
import { RECEPTIONIST_VOICE } from './name-voice-table'
import { DIRECTORY_PREFIX, Handles } from './handles'
import type { SideQuestionResult, SideQuestionUsage } from '../side-questions'
import {
  FORMAT_REMINDER, RECEPTIONIST_SYSTEM_PROMPT, renderTurnBody, type ReceptionistEvent,
} from './prompt'
import {
  CONTROL, isBlocking, parseReply, redactSpoken, renderSpeech, type RenderedPart, type Reply, type SayPart, type ToolCall,
} from './reply'
import {
  readAgent, renderDirectories, renderRoster, STATE_WORDS, type RosterAgent, type RosterDirectory,
} from './roster'

/**
 * Control: one voice conversation about every live agent.
 *
 * Summary Chat is a conversation *about one surface*; this is a conversation
 * about all of them, which is what lets "what's Kevin up to?" mean anything.
 * It reads transcripts, asks agents side questions their transcripts do not answer,
 * passes the user's messages on to agents as though the user had typed them,
 * and watches agents the user is waiting to hear from.
 *
 * The conversation lives in one long-lived Claude Code session, through
 * claude-print-daemon, and each turn sends only what is new. That is what lets
 * the prompt cache read the whole conversation back every turn — a history
 * resent as one block of text can never be read back, because the cache only
 * matches a prefix ending at a block boundary. The daemon keeps the session
 * warm for an hour and compacts it just before its cache would go cold.
 *
 * The price is that the past cannot be edited. An interrupted answer used to
 * be cut down to what was heard; now the next message says what was heard.
 */

/** One message to Control's session: the session to continue, or none to start one. */
export interface SessionTurn {
  prompt: string
  sessionId?: string
  /** The system prompt, for a new session only. */
  systemPrompt?: string
}

export interface SessionAnswer {
  text: string
  sessionId: string
  /** The session's context after this turn, which is what compaction keeps down. */
  contextTokens?: number
  source?: string
  wallMs?: number
  costUsd?: number
}

/** Which session Control is in, and which instructions it was started with. */
export interface SavedSession {
  sessionId: string
  /** A new prompt means a new session: an old one keeps the instructions it began with. */
  promptHash: string
}

/** Jev's ranking of the agents against a description. */
export interface AgentRanking {
  hits: Array<{ nodeId: NodeId; probability: number }>
  noneProbability: number
}

type RecordMessage = { role: 'user' | 'assistant'; content: string }


export interface ReceptionistDeps {
  /** One message to Control's Claude Code session. Rejects on failure or abort. */
  askModel(turn: SessionTurn, signal: AbortSignal): Promise<SessionAnswer>
  /** Rank the live agents against a description, with Jev. */
  findAgents(query: string, agents: readonly RosterAgent[]): Promise<AgentRanking>
  /** Every live Claude Code surface, freshly read. */
  agents(): RosterAgent[]
  /** The transcript's recent window, as Summary Chat reads it. */
  readTranscript(path: string): TranscriptMessage[]
  /** The whole transcript, for searches. */
  readWholeTranscript(path: string): TranscriptMessage[]
  /** Control's session, across server restarts. Best-effort. */
  session: {
    load(): SavedSession | undefined
    save(session: SavedSession | undefined): void
  }
  /**
   * The full record of the conversation, never trimmed, which `recall`
   * searches: compaction keeps the session small by forgetting detail, and
   * this is where the detail still is. Best-effort.
   */
  record: {
    append(messages: readonly RecordMessage[]): void
    search(query: string): string
  }
  names: {
    get(nodeId: NodeId): NamedVoice | undefined
    assign(nodeId: NodeId): NamedVoice | undefined
    touch(nodeId: NodeId): void
  }
  /**
   * Ask an agent a side question: answered inside the agent from its own
   * cached context, without interrupting it or entering its transcript. See
   * `side-questions.ts`. Always resolves.
   */
  askAgent(nodeId: NodeId, prompt: string): Promise<SideQuestionResult>
  /** Move the camera to a surface, on every client. */
  focus(nodeId: NodeId): void
  /**
   * A toast on every client. Side questions are what the receptionist pays
   * the agents' model for, so each one is announced with what it used.
   */
  notify(text: string): void
  /** Type `text` into an agent's prompt and submit it — Ship it. */
  send(nodeId: NodeId, text: string): void
  /** Press Escape in an agent's terminal. */
  interrupt(nodeId: NodeId): void
  /** Directory nodes, where a new agent can be started. */
  directories(): RosterDirectory[]
  /** Start a new Claude surface under a directory node. Returns its node. */
  spawn(directoryNodeId: NodeId, title: string, prompt: string): NodeId
  /** Append-only record of every turn. Best-effort. */
  log(entry: Record<string, unknown>): void
  sleep(ms: number): Promise<void>
  /** Whether Voice Operator is publishing a port: see SpeechChannel's deps. */
  voiceOperatorDiscovered(): boolean
}

export interface ReceptionistOptions {
  /** Where speech goes until someone talks to the receptionist from somewhere else. */
  speech: SpeechBackend
  onPhase(phase: SpeechPhase): void
  onError(message: string): void
}

/** Model calls in one turn, counting retries and each round of blocking tools. */
const MAX_STEPS = 5
/** Generous: a turn may wait behind a compaction the daemon is running. */
const MODEL_TIMEOUT_MS = 90_000
const LAST_SAID_EVENT_CHARS = 1_500
/** Agents `find_agent` reports, best first. */
const FIND_AGENT_RESULTS = 10

/** What each failure means for what to do next, as the model is told it. */
const SIDE_QUESTION_FAILURES: Record<Exclude<SideQuestionResult, { ok: true }>['reason'], string> = {
  'not-listening': 'that agent cannot take side questions (it was started before they existed, and needs a restart); send it a message instead if it matters',
  'nothing-to-fork': 'that agent has not finished its first reply yet, so there is nothing to ask',
  timeout: 'no answer came in time',
  'api-error': 'the model request failed',
  'empty-reply': 'the agent gave no answer',
  aborted: 'the question was cut off',
  'invalid-reply': 'the answer came back garbled',
}

/** Identifies a version of the instructions; a session started on another one is replaced. */
export const PROMPT_HASH = createHash('sha256').update(RECEPTIONIST_SYSTEM_PROMPT).digest('hex').slice(0, 16)
/**
 * How long a send waits after an interrupt in the same reply, so Claude Code
 * has left the turn it was in before the next prompt is typed.
 */
const INTERRUPT_SETTLE_MS = 800
const TURN_FAILED_SPEECH = 'Sorry, I lost my train of thought. Could you say that again?'

/**
 * The question an agent is actually given. Unframed, an agent answering a bare
 * question out of nowhere is suspicious and long-winded.
 */
export function sideQuestionPrompt(question: string): string {
  return "A quick side question from the user's receptionist. Answer briefly, in a sentence or two, from what you already know; " +
    `you cannot use tools for this.\n\nQuestion: ${question}`
}

export class Receptionist {
  private session: SavedSession | undefined
  /** Model calls go one at a time: a session takes one message after another. */
  private queue: Promise<unknown> = Promise.resolve()
  /** Told to the model with the next message: what became of its last reply. */
  private notes: string[] = []
  /** The last reply spoken, so an interruption can say how much of it was heard. */
  private lastSpoken?: RenderedPart[]
  private events: ReceptionistEvent[] = []
  private readonly monitors = new Set<NodeId>()
  private readonly channel: SpeechChannel
  private talkToMe = true

  private readonly onError: (message: string) => void

  constructor(private readonly deps: ReceptionistDeps, opts: ReceptionistOptions) {
    this.onError = opts.onError
    const saved = deps.session.load()
    // Instructions are fixed when a session starts, so a session begun on an
    // older prompt would quietly keep following it.
    this.session = saved?.promptHash === PROMPT_HASH ? saved : undefined
    this.channel = new SpeechChannel({
      speech: opts.speech,
      label: 'receptionist',
      onPhase: (phase) => {
        opts.onPhase(phase)
        // Background results that arrived while the receptionist was busy wait
        // for it to go quiet, then get their turn.
        if (phase === 'ready') this.maybeSpeakUp()
      },
      onFailure: (failure) => opts.onError(speechFailureMessage(failure, 'the answer')),
      deps: {
        sleep: (ms) => this.deps.sleep(ms),
        voiceOperatorDiscovered: () => this.deps.voiceOperatorDiscovered(),
      },
    })
  }

  get phase(): SpeechPhase { return this.channel.phase }

  /** The user said something to the receptionist, from the device `speech` plays on. */
  async hear(text: string, speech?: SpeechBackend): Promise<void> {
    if (speech) this.channel.speech = speech
    await this.runTurn(text)
  }

  /** Stop whatever the receptionist is saying or about to say. */
  cancel(): Promise<boolean> {
    return this.channel.cancel()
  }

  /**
   * Whether background results may be spoken unprompted. Off, they wait and
   * come with the user's next question instead.
   */
  setTalkToMe(enabled: boolean): void {
    this.talkToMe = enabled
    if (enabled) this.maybeSpeakUp()
  }

  /** An agent's Claude state changed. Fires a monitor if one is waiting on it. */
  agentStateChanged(nodeId: NodeId, state: ClaudeState): void {
    if (!this.monitors.has(nodeId) || !isSettled(state)) return
    const agent = this.deps.agents().find(candidate => candidate.nodeId === nodeId)
    this.monitors.delete(nodeId)
    if (!agent) return
    const lastSaid = agent.transcriptPath ? finalAgentMessage(this.deps.readTranscript(agent.transcriptPath)) : ''
    this.events.push({
      kind: 'agent-stopped', handle: this.handles([agent]).of(nodeId) ?? nodeId, state: STATE_WORDS[state],
      lastSaid: lastSaid.slice(-LAST_SAID_EVENT_CHARS),
    })
    this.maybeSpeakUp()
  }

  private maybeSpeakUp(): void {
    if (!this.talkToMe || !this.events.length || this.channel.isProducing()) return
    void this.runTurn(undefined)
  }

  /**
   * One turn: the user's words (or, with none, pending events), as many model
   * steps as its `read` calls need, and then speech.
   */
  private async runTurn(heard: string | undefined): Promise<void> {
    const attempt = this.channel.begin('thinking')
    if (heard !== undefined) await this.noteInterruption()
    const events = this.events.splice(0)
    const body = renderTurnBody(events, heard)
    if (heard !== undefined) this.deps.record.append([{ role: 'user', content: body }])
    let monitoring = false
    try {
      const reply = await this.converse(attempt, body)
      if (!attempt.isCurrent) {
        this.requeue(events)
        return
      }
      if (!reply) return
      monitoring = await this.speak(attempt, body, heard === undefined ? reply : acknowledgeSends(reply))
    } catch (err) {
      if (!attempt.isCurrent) { this.requeue(events); return }
      if (err instanceof LostSession) this.forgetSession()
      const message = err instanceof Error ? err.message : String(err)
      serverLog(`[receptionist] turn failed: ${message}`)
      this.deps.log({ event: 'turn-failed', heard: heard ?? null, error: message })
      this.onError(`The receptionist could not answer: ${message}`)
      monitoring = await this.channel.deliver(attempt, [{ text: TURN_FAILED_SPEECH, voice: RECEPTIONIST_VOICE }])
    } finally {
      if (!monitoring) this.channel.settle(attempt)
    }
  }

  /**
   * Give a superseded turn's events back. They were never heard, and the turn
   * that superseded this one may already be over by now — so this has to
   * offer them a turn of their own, not just wait for the next phase change.
   */
  private requeue(events: readonly ReceptionistEvent[]): void {
    if (!events.length) return
    this.events.unshift(...events)
    this.maybeSpeakUp()
  }

  /**
   * The model steps of one turn. `read` results go back to the model within
   * the turn; everything else runs as soon as it is asked for. Returns the
   * final reply, or undefined if the attempt lost ownership.
   */
  private async converse(attempt: Attempt, body: string): Promise<Reply | undefined> {
    let message = body
    for (let step = 1; step <= MAX_STEPS; step++) {
      const answer = await this.ask(attempt, `${message}\n\n${FORMAT_REMINDER}`)
      if (!attempt.isCurrent) return undefined
      this.deps.log({
        event: 'model-step', step, raw: answer.text, sessionId: answer.sessionId, source: answer.source ?? null,
        contextTokens: answer.contextTokens ?? null, wallMs: answer.wallMs ?? null, costUsd: answer.costUsd ?? null,
      })
      let reply: Reply
      try {
        reply = parseReply(answer.text)
      } catch (err) {
        message = `That reply was not usable: ${err instanceof Error ? err.message : String(err)}. Reply with the JSON object only.`
        continue
      }
      const agents = this.deps.agents()
      const handles = this.handles(agents)
      // A handle the model miscopied would send to nobody, or to the wrong
      // agent, or be spoken as "an agent". Check every one before anything
      // runs or is said, and have the model correct it.
      const problems = this.checkHandles(reply, handles, agents)
      if (problems.length && step < MAX_STEPS) {
        this.deps.log({ event: 'bad-handles', step, problems })
        message = `NOTHING WAS DONE AND NOTHING YOU SAID WAS SPOKEN. ${problems.join(' ')} Reply again with the right handles.`
        continue
      }
      // Words that came with a blocking tool are spoken now, while it runs:
      // the listener hears "let me check" instead of silence.
      if (reply.tools.some(isBlocking) && step < MAX_STEPS && reply.say.length) {
        const { spoken } = this.render(reply.say, agents)
        await this.channel.deliverInterim(attempt, spoken.map(({ text, voice }) => ({ text, voice })))
        if (!attempt.isCurrent) return undefined
      }
      const { results, done } = await this.runTools(reply.tools, agents, handles)
      if (!attempt.isCurrent) return undefined
      if (!reply.tools.some(isBlocking) || step === MAX_STEPS) {
        // What the actions reached, told with the next message rather than
        // costing a round trip now: enough to notice a wrong agent and
        // retract, since the action itself has already happened.
        if (done.length) this.notes.push(`Your last actions: ${done.join('; ')}.`)
        return reply
      }
      message = `TOOL RESULTS:\n${[...results, ...done.map(line => `done: ${line}`)].join('\n\n')}`
    }
    throw new Error(`no usable reply in ${MAX_STEPS} steps`)
  }

  /**
   * One message to the session, starting one if there is none. Messages are
   * queued: a turn that supersedes another waits for the session to finish
   * answering the old one, since the daemon finishes a turn it started even
   * after its caller has gone.
   */
  private ask(attempt: Attempt, prompt: string): Promise<SessionAnswer> {
    const run = async (): Promise<SessionAnswer> => {
      // Superseded while queued: never sent, so there is nothing to answer.
      if (!attempt.isCurrent) throw new Error('superseded before it was sent')
      const signal = AbortSignal.any([attempt.signal, AbortSignal.timeout(MODEL_TIMEOUT_MS)])
      const sessionId = this.session?.sessionId
      // Notes go on whatever message leaves next, read only now: the message
      // ahead of this one in the queue may have just produced one.
      const notes = this.notes.splice(0)
      const message = notes.length ? `NOTE: ${notes.join(' ')}\n\n${prompt}` : prompt
      try {
        const answer = await this.deps.askModel(
          sessionId ? { prompt: message, sessionId } : { prompt: message, systemPrompt: RECEPTIONIST_SYSTEM_PROMPT }, signal,
        )
        if (answer.sessionId !== sessionId) {
          this.session = { sessionId: answer.sessionId, promptHash: PROMPT_HASH }
          this.deps.session.save(this.session)
        }
        // The session answered, but the turn that asked is gone: nobody will
        // hear this reply, and the model has to be told or it builds on it.
        // Noted here, before the next queued message is sent, not by the
        // turn — which only finds out after that message has already left.
        if (!attempt.isCurrent) {
          this.notes.push('Your previous reply was never spoken: the user spoke over it, so they heard none of it.')
        }
        return answer
      } catch (err) {
        if (sessionId && !signal.aborted) throw new LostSession(err)
        throw err
      }
    }
    const next = this.queue.then(run, run)
    this.queue = next.catch(() => undefined)
    return next
  }

  /** A session that will not answer is abandoned; the next turn starts a fresh one. */
  private forgetSession(): void {
    serverLog(`[receptionist] abandoning session ${this.session?.sessionId ?? '?'}`)
    this.deps.log({ event: 'session-abandoned', sessionId: this.session?.sessionId ?? null })
    this.session = undefined
    this.deps.session.save(undefined)
  }

  /** Run a reply's tools. Returns the results of the blocking ones, for the model. */
  /**
   * Run a reply's tools, all of whose handles `checkHandles` has passed.
   * Returns what the blocking ones found, for the model now, and a line per
   * action saying which agent it reached, so a wrong pick can be noticed.
   */
  private async runTools(
    calls: readonly ToolCall[], agents: readonly RosterAgent[], handles: Handles,
  ): Promise<{ results: string[]; done: string[] }> {
    const results: string[] = []
    const done: string[] = []
    const interrupted = new Set<NodeId>()
    for (const call of calls) {
      if (call.tool === 'spawn') {
        done.push(this.spawn(call, agents))
        continue
      }
      if (call.tool === 'recall') {
        results.push(`recall "${call.search}":\n${this.deps.record.search(call.search)}`)
        continue
      }
      if (call.tool === 'list_agents') {
        results.push(call.namedOnly ? this.listNamedAgents(agents, handles) : this.listAgents(agents, handles))
        continue
      }
      if (call.tool === 'find_agent') {
        results.push(await this.findAgent(call.query, agents, handles))
        continue
      }
      const nodeId = handles.find(call.agent)
      const agent = agents.find(candidate => candidate.nodeId === nodeId)
      // checkHandles already refused unknown handles; this only guards an agent
      // that vanished between the check and now.
      if (!agent) {
        results.push(`${call.tool} {${call.agent}}: that agent is gone.`)
        continue
      }
      // An agent acted on is about to be spoken of, so it is named now: the
      // confirmation should carry the name the user will hear.
      if (call.tool !== 'read') this.deps.names.get(agent.nodeId) ?? this.deps.names.assign(agent.nodeId)
      const who = this.describe(agent, handles)
      switch (call.tool) {
        case 'read': {
          // A search covers the whole session; a plain read is the recent part.
          const read = call.search ? this.deps.readWholeTranscript : this.deps.readTranscript
          const messages = agent.transcriptPath ? read(agent.transcriptPath) : []
          results.push(`read {${call.agent}}${call.search ? ` for "${call.search}"` : ''}:\n${readAgent(messages, call.search)}`)
          break
        }
        case 'monitor':
          this.monitors.add(agent.nodeId)
          done.push(`monitor is watching ${who}`)
          break
        case 'ask_agent':
          void this.askAgent(agent, call.question, handles)
          done.push(`ask_agent asked ${who}; the answer will come as an event`)
          break
        case 'interrupt':
          interrupted.add(agent.nodeId)
          this.deps.interrupt(agent.nodeId)
          done.push(`interrupt pressed Escape for ${who}`)
          break
        case 'send':
          void this.send(agent.nodeId, call.message, interrupted.has(agent.nodeId))
          done.push(`send delivered to ${who}, which is now watched for its reply`)
          break
      }
      this.deps.log({ event: 'tool', ...call, nodeId: agent.nodeId })
    }
    return { results, done }
  }

  /** Start a new agent, and watch for its first answer as for a send. */
  private spawn(call: Extract<ToolCall, { tool: 'spawn' }>, agents: readonly RosterAgent[]): string {
    const directories = this.deps.directories()
    const directoryId = this.directoryHandles(directories).find(call.directory)
    const directory = directories.find(candidate => candidate.nodeId === directoryId)
    if (!directory) return `spawn {${call.directory}}: that directory is gone.`
    try {
      const nodeId = this.deps.spawn(directory.nodeId, call.title, call.prompt)
      this.monitors.add(nodeId)
      this.deps.log({ event: 'spawned', nodeId, directory: directory.cwd, title: call.title, prompt: call.prompt })
      this.deps.record.append([{ role: 'assistant', content: `STARTED AN AGENT in ${directory.cwd}: ${call.prompt}` }])
      const handle = this.handles([...agents.map(agent => agent.nodeId), nodeId].map(id => ({ nodeId: id }))).of(nodeId)
      return `spawn started [${handle}] "${call.title}" in ${directory.cwd}, which is now watched for its first reply`
    } catch (err) {
      return `spawn in ${directory.cwd} failed: ${err instanceof Error ? err.message : String(err)}`
    }
  }

  /**
   * Ship a message to a real agent, and watch for its answer: whoever sends
   * an agent something wants to hear back.
   */
  private async send(nodeId: NodeId, message: string, afterInterrupt: boolean): Promise<void> {
    if (afterInterrupt) await this.deps.sleep(INTERRUPT_SETTLE_MS)
    this.deps.send(nodeId, message)
    this.monitors.add(nodeId)
    // Named now if it has none: "Sent to Kevin" is about to be said anyway.
    const name = (this.deps.names.get(nodeId) ?? this.deps.names.assign(nodeId))?.name ?? 'an agent'
    this.deps.log({ event: 'sent', nodeId, name, message })
    // Into the full record, so `recall` can answer "what did I tell Kevin?".
    this.deps.record.append([{ role: 'assistant', content: `SENT TO ${name}: ${message}` }])
  }

  /**
   * Ask an agent a side question, in the background: the answer comes back
   * as an event, with a toast saying what it used.
   */
  private async askAgent(agent: RosterAgent, question: string, handles: Handles): Promise<void> {
    const handle = handles.of(agent.nodeId) ?? agent.nodeId
    // Named now if it has no name yet: its answer will be quoted in its voice,
    // and the toast should already call it what the listener will hear.
    const named = this.deps.names.get(agent.nodeId) ?? this.deps.names.assign(agent.nodeId)
    const name = named?.name ?? agent.title
    const result = await this.deps.askAgent(agent.nodeId, sideQuestionPrompt(question))
    this.deps.log({ event: 'side-question', nodeId: agent.nodeId, question, result })
    if (result.ok) {
      this.deps.notify(`Control asked ${name}: ${usageWords(result.usage)}`)
      this.events.push({ kind: 'agent-answer', handle, question, answer: result.text })
    } else {
      serverLog(`[receptionist] side question to ${handle} failed: ${result.reason}${result.detail ? ` ${result.detail}` : ''}`)
      this.deps.notify(`Control's question to ${name} failed: ${result.reason}`)
      this.events.push({ kind: 'agent-answer-failed', handle, question, reason: SIDE_QUESTION_FAILURES[result.reason] })
    }
    this.maybeSpeakUp()
  }

  /** Handles for these agents, distinct among them. See `handles.ts`. */
  private handles(agents: ReadonlyArray<{ nodeId: NodeId }>): Handles {
    return new Handles(agents.map(agent => agent.nodeId))
  }

  private directoryHandles(directories: readonly RosterDirectory[]): Handles {
    return new Handles(directories.map(directory => directory.nodeId), DIRECTORY_PREFIX)
  }

  /** An agent as a confirmation names it: handle, name, and title, so a wrong pick shows. */
  private describe(agent: RosterAgent, handles: Handles): string {
    const name = this.deps.names.get(agent.nodeId)?.name
    return `[${handles.of(agent.nodeId)}]${name ? ` ${name}` : ''} ("${agent.title}")`
  }

  /**
   * Every handle a reply uses — in tool calls, in placeholders, and as who a
   * spoken part comes from — that is not a live agent's (or, for spawn, a
   * directory's). One sentence per problem, with the nearest real handles.
   */
  private checkHandles(reply: Reply, handles: Handles, agents: readonly RosterAgent[]): string[] {
    const problems: string[] = []
    const byId = new Map(agents.map(agent => [agent.nodeId, agent]))
    const suggest = (handle: string): string => {
      const near = handles.nearest(handle).flatMap(candidate => {
        const agent = byId.get(handles.find(candidate)!)
        return agent ? [this.describe(agent, handles)] : []
      })
      return near.length ? ` Did you mean ${near.join(' or ')}?` : ' Use list_agents or find_agent to look it up.'
    }
    const unknownAgent = (handle: string, where: string): void => {
      if (!handles.find(handle)) problems.push(`"${handle}" (${where}) is not a live agent's handle.${suggest(handle)}`)
    }
    for (const call of reply.tools) {
      if (call.tool === 'spawn') {
        const directories = this.directoryHandles(this.deps.directories())
        if (!directories.find(call.directory)) {
          const near = directories.nearest(call.directory)
          problems.push(`"${call.directory}" (in spawn) is not a directory's handle.${near.length ? ` Did you mean ${near.join(' or ')}?` : ' Use list_agents to see the directories.'}`)
        }
      } else if ('agent' in call) {
        unknownAgent(call.agent, `in ${call.tool}`)
      }
    }
    for (const part of reply.say) {
      if (part.from !== CONTROL) unknownAgent(part.from, 'as who a spoken part is from')
      for (const [, handle] of part.text.matchAll(/\{([A-Za-z0-9_-]+)\}/g)) unknownAgent(handle, 'in what you said')
    }
    return [...new Set(problems)]
  }

  /** The list_agents tool: every live agent, and the directories. */
  private listAgents(agents: readonly RosterAgent[], handles: Handles): string {
    const handleOf = (nodeId: NodeId) => handles.of(nodeId) ?? nodeId
    const sections = [`AGENTS:\n${renderRoster(agents, nodeId => this.deps.names.get(nodeId)?.name, this.deps.readTranscript, handleOf)}`]
    const directoryList = this.deps.directories()
    const directoryHandles = this.directoryHandles(directoryList)
    const directories = renderDirectories(directoryList, nodeId => directoryHandles.of(nodeId) ?? nodeId)
    if (directories) sections.push(`DIRECTORIES:\n${directories}`)
    return `list_agents:\n${sections.join('\n\n')}`
  }

  /**
   * list_agents with named_only: just the handle, name and title of every agent
   * that has a name. A few hundred tokens instead of the full list's thousands,
   * for when the user names an agent and the only question is which handle
   * that is.
   */
  private listNamedAgents(agents: readonly RosterAgent[], handles: Handles): string {
    const lines = agents.flatMap(agent => {
      const name = this.deps.names.get(agent.nodeId)?.name
      return name ? [`[${handles.of(agent.nodeId)}] ${name}: ${agent.title}`] : []
    })
    return `list_agents (named only):\n${lines.length ? lines.join('\n') : 'No agent has a name yet.'}`
  }

  /** The find_agent tool: Jev's ranking, best first, with confidences. */
  private async findAgent(query: string, agents: readonly RosterAgent[], handles: Handles): Promise<string> {
    if (!agents.length) return 'find_agent: no agents are running.'
    try {
      const ranking = await this.deps.findAgents(query, agents)
      const byId = new Map(agents.map(agent => [agent.nodeId, agent]))
      const lines = ranking.hits.slice(0, FIND_AGENT_RESULTS).flatMap(hit => {
        const agent = byId.get(hit.nodeId)
        if (!agent) return []
        const name = this.deps.names.get(agent.nodeId)?.name
        return [`${Math.round(hit.probability * 100)}% [${handles.of(agent.nodeId)}]${name ? ` ${name}` : ''}: ${agent.title} (${STATE_WORDS[agent.state]})`]
      })
      return `find_agent "${query}":\n${lines.join('\n')}\n${Math.round(ranking.noneProbability * 100)}% none of these`
    } catch (err) {
      return `find_agent failed: ${err instanceof Error ? err.message : String(err)}. Use list_agents instead.`
    }
  }

  /**
   * A reply's parts as speech, naming each agent the first time it is spoken
   * of. Returns which agents came up, first mention first.
   */
  private render(say: readonly SayPart[], agents: readonly RosterAgent[]): {
    spoken: RenderedPart[]; mentioned: NodeId[]; byHandle: Map<string, RosterAgent>
  } {
    const handles = this.handles(agents)
    const byHandle = new Map(agents.map(agent => [handles.of(agent.nodeId)!, agent]))
    const mentioned: NodeId[] = []
    const resolve = (handle: string): { name: string; voice: string } | undefined => {
      const agent = byHandle.get(handle)
      if (!agent) return undefined
      const named = this.deps.names.get(agent.nodeId) ?? this.deps.names.assign(agent.nodeId)
      if (!named) return undefined
      if (!mentioned.includes(agent.nodeId)) mentioned.push(agent.nodeId)
      return { name: named.name, voice: named.voice }
    }
    const spoken = renderSpeech(say, resolve, RECEPTIONIST_VOICE)
    for (const nodeId of mentioned) this.deps.names.touch(nodeId)
    return { spoken, mentioned, byHandle }
  }

  private async speak(attempt: Attempt, body: string, reply: Reply): Promise<boolean> {
    const { spoken, mentioned, byHandle } = this.render(reply.say, this.deps.agents())
    const froms = reply.say.map(part => part.from)
    this.lastSpoken = spoken
    this.deps.record.append([{ role: 'assistant', content: storedReply(froms, spoken) }])
    this.deps.log({ event: 'turn', body, say: reply.say, spoken, tools: reply.tools })
    // The camera follows the conversation: the agent quoted first, else the
    // agent mentioned first.
    const quoted = froms.find(from => byHandle.has(from))
    const focus = quoted ? byHandle.get(quoted)?.nodeId : mentioned[0]
    if (focus) this.deps.focus(focus)
    if (!spoken.length) return false
    return this.channel.deliver(attempt, spoken.map(({ text, voice }) => ({ text, voice })))
  }

  /**
   * If the listener cut the last reply off, tell the model how much of it they
   * heard: the session keeps the whole reply, and the next answer must not
   * build on words nobody heard.
   */
  private async noteInterruption(): Promise<void> {
    const heard = await this.channel.heardPrefix()
    const spoken = this.lastSpoken
    this.lastSpoken = undefined
    if (heard === undefined || !spoken) return
    const kept = redactSpoken(spoken, heard)
    const audible = kept.map(part => part.text).join(' ')
    this.notes.push(`The user cut your last reply off. They heard only: "${audible}". They did not hear the rest.`)
  }
}

/**
 * A reply that sent something and said nothing gets a few words of its own.
 * Silence after "tell Kevin to commit" leaves the listener unsure it went
 * anywhere, and the model does not reliably fill it.
 */
function acknowledgeSends(reply: Reply): Reply {
  if (reply.say.length) return reply
  const recipients = [...new Set(reply.tools.flatMap(call => call.tool === 'send' ? [call.agent] : []))]
  if (!recipients.length) return reply
  return { ...reply, say: [{ from: 'control', text: `Sent to ${recipients.map(handle => `{${handle}}`).join(' and ')}.` }] }
}

/** What a side question cost, in tokens: the cached context it read, and what it paid for afresh. */
function usageWords(usage: SideQuestionUsage | undefined): string {
  if (!usage) return 'usage unknown'
  const k = (n: number | undefined) => `${Math.round((n ?? 0) / 100) / 10}k`
  return `${k(usage.cache_read_input_tokens)} cached, ${k((usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0))} new`
}

/** The states an agent stops in: anything that is not working. */
function isSettled(state: ClaudeState): boolean {
  return state !== 'working' && state !== 'working_background'
}

/** A reply as the model sees it later: what was actually spoken, without the introductions it never wrote. */
function storedReply(froms: readonly string[], spoken: readonly RenderedPart[]): string {
  const say: SayPart[] = spoken.map((part, i) => ({ from: froms[i], text: part.text.slice(part.introLength) }))
  return JSON.stringify({ say })
}

/** A session that failed to answer, as against a turn that was cancelled. */
class LostSession extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause))
  }
}
