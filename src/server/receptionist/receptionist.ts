import type { NodeId } from '../../shared/ids'
import type { ClaudeState } from '../../shared/state'
import { serverLog } from '../server-log'
import {
  finalAgentMessage, type ModelAnswer, type ModelRequest, type TranscriptMessage,
} from '../summary-chat'
import type { SpeechBackend } from '../voice-operator'
import { SpeechChannel, speechFailureMessage, type Attempt, type SpeechPhase } from '../speech-channel'
import type { NamedVoice } from './name-voice-table'
import { RECEPTIONIST_VOICE } from './name-voice-table'
import {
  FORMAT_REMINDER, RECEPTIONIST_SYSTEM_PROMPT, renderContext, renderTurnBody, type ForkSummary, type ReceptionistEvent,
} from './prompt'
import {
  isBlocking, parseReply, redactSpoken, renderSpeech, type RenderedPart, type Reply, type SayPart, type ToolCall,
} from './reply'
import {
  directoryHandleFor, handleFor, readAgent, renderDirectories, renderRoster, STATE_WORDS, type RosterAgent, type RosterDirectory,
} from './roster'

/**
 * Control: one voice conversation about every live agent.
 *
 * Summary Chat is a conversation *about one surface*; this is a conversation
 * about all of them, which is what lets "what's Kevin up to?" mean anything.
 * It reads transcripts, asks disposable forks what transcripts do not say,
 * passes the user's messages on to agents as though the user had typed them,
 * and watches agents the user is waiting to hear from.
 *
 * Like Summary Chat, the history is held here and resent whole each turn,
 * because an interrupted answer has to be cut down to what the listener heard
 * before the model sees it again.
 */

type HistoryMessage = ModelRequest['messages'][number]

/** What a fork said, and what saying it cost when Claude reports that. */
export interface ForkAnswer { forkId: string; answer: string; costUsd?: number }

/** Disposable copies of a live surface's Claude session. See `SessionForks`. */
export interface ForkClient {
  /** Fork the surface's current session `sessionId` and ask the copy `prompt`. */
  fork(req: { nodeId: NodeId; sessionId: string; prompt: string }): Promise<ForkAnswer>
  /** Ask an existing fork again. */
  ask(req: { forkId: string; prompt: string }): Promise<ForkAnswer>
}

export interface ReceptionistDeps {
  askModel(request: ModelRequest, signal: AbortSignal): Promise<ModelAnswer>
  /** Every live Claude Code surface, freshly read. */
  agents(): RosterAgent[]
  /** The transcript's recent window, as Summary Chat reads it. */
  readTranscript(path: string): TranscriptMessage[]
  /** The whole transcript, for searches. */
  readWholeTranscript(path: string): TranscriptMessage[]
  /** The conversation, kept across server restarts. Best-effort both ways. */
  history: {
    load(): Array<{ role: 'user' | 'assistant'; content: string }> | undefined
    save(messages: ReadonlyArray<{ role: 'user' | 'assistant'; content: string }>): void
  }
  names: {
    get(nodeId: NodeId): NamedVoice | undefined
    assign(nodeId: NodeId): NamedVoice | undefined
    touch(nodeId: NodeId): void
  }
  forks: ForkClient
  /** Move the camera to a surface, on every client. */
  focus(nodeId: NodeId): void
  /**
   * A toast on every client. Forks are the receptionist's one expensive
   * action — a read is nearly free — so each one is announced with its cost.
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

const MAX_HISTORY_MESSAGES = 24
const MAX_HISTORY_CHARS = 40_000
/** Model calls in one turn, counting retries and each round of `read`. */
const MAX_STEPS = 4
const MODEL_TIMEOUT_MS = 30_000
const LAST_SAID_EVENT_CHARS = 1_500
/**
 * How long a send waits after an interrupt in the same reply, so Claude Code
 * has left the turn it was in before the next prompt is typed.
 */
const INTERRUPT_SETTLE_MS = 800
const TURN_FAILED_SPEECH = 'Sorry, I lost my train of thought. Could you say that again?'

/** The question a fork is actually given, so it answers instead of resuming the work. */
export function forkPrompt(question: string): string {
  return 'Halt and pivot. Another agent is continuing your work, so do not continue it, and do not start anything new. ' +
    'You have been copied only to answer one question from the user, from what you already know. ' +
    `Answer in a few plain sentences.\n\nQuestion: ${question}`
}

interface ForkRecord {
  forkId: string
  nodeId: NodeId
  /** The agent's last message and session when the copy was made, to tell when it has moved on. */
  lastSaidAtFork: string
  sessionAtFork?: string
}

/** The answer the listener last heard, kept so an interruption can cut it down in the history. */
interface LastAnswer {
  historyIndex: number
  froms: string[]
  spoken: RenderedPart[]
}

export class Receptionist {
  private history: HistoryMessage[] = []
  private events: ReceptionistEvent[] = []
  private readonly monitors = new Set<NodeId>()
  private readonly forks = new Map<string, ForkRecord>()
  private readonly channel: SpeechChannel
  private lastAnswer?: LastAnswer
  private talkToMe = true

  private readonly onError: (message: string) => void

  constructor(private readonly deps: ReceptionistDeps, opts: ReceptionistOptions) {
    this.onError = opts.onError
    this.history = bounded(deps.history.load() ?? [])
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
      kind: 'agent-stopped', handle: handleFor(nodeId), state: STATE_WORDS[state],
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
    if (heard !== undefined) await this.redactInterrupted()
    const events = this.events.splice(0)
    const body = renderTurnBody(events, heard)
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
    const turn: HistoryMessage[] = [{ role: 'user', content: body }]
    for (let step = 1; step <= MAX_STEPS; step++) {
      const agents = this.deps.agents()
      const context = renderContext(
        renderRoster(agents, nodeId => this.deps.names.get(nodeId)?.name, this.deps.readTranscript),
        this.forkSummaries(agents),
        renderDirectories(this.deps.directories()),
      )
      const [first, ...rest] = turn
      const messages = bounded([...this.history, { role: 'user', content: `${context}\n\n${first.content}` }, ...rest])
      const last = messages[messages.length - 1]
      messages[messages.length - 1] = { ...last, content: `${last.content}\n\n${FORMAT_REMINDER}` }
      const answer = await this.deps.askModel(
        { instructions: RECEPTIONIST_SYSTEM_PROMPT, messages },
        AbortSignal.any([attempt.signal, AbortSignal.timeout(MODEL_TIMEOUT_MS)]),
      )
      if (!attempt.isCurrent) return undefined
      this.deps.log({
        event: 'model-step', step, raw: answer.text, claudeSessionId: answer.claudeSessionId ?? null,
        wallMs: answer.wallMs ?? null, costUsd: answer.costUsd ?? null,
      })
      let reply: Reply
      try {
        reply = parseReply(answer.text)
      } catch (err) {
        turn.push({ role: 'assistant', content: answer.text })
        turn.push({ role: 'user', content: `That reply was not usable: ${err instanceof Error ? err.message : String(err)}. Reply with the JSON object only.` })
        continue
      }
      const results = this.runTools(reply.tools, agents)
      if (!reply.tools.some(isBlocking) || step === MAX_STEPS) return reply
      turn.push({ role: 'assistant', content: answer.text })
      turn.push({ role: 'user', content: `TOOL RESULTS:\n${results.join('\n\n')}` })
    }
    throw new Error(`no usable reply in ${MAX_STEPS} steps`)
  }

  /** Run a reply's tools. Returns the results of the blocking ones, for the model. */
  private runTools(calls: readonly ToolCall[], agents: readonly RosterAgent[]): string[] {
    const results: string[] = []
    const interrupted = new Set<NodeId>()
    for (const call of calls) {
      if (call.tool === 'spawn') {
        results.push(this.spawn(call))
        continue
      }
      const agent = agents.find(candidate => handleFor(candidate.nodeId) === call.agent)
      if (!agent) {
        results.push(`${call.tool} ${call.agent}: no live agent has that handle.`)
        continue
      }
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
          break
        case 'ask_fork':
          void this.askFork(agent, call.question, call.fork)
          break
        case 'interrupt':
          interrupted.add(agent.nodeId)
          this.deps.interrupt(agent.nodeId)
          break
        case 'send':
          void this.send(agent.nodeId, call.message, interrupted.has(agent.nodeId))
          break
      }
      this.deps.log({ event: 'tool', ...call, nodeId: agent.nodeId })
    }
    return results
  }

  /** Start a new agent, and watch for its first answer as for a send. */
  private spawn(call: Extract<ToolCall, { tool: 'spawn' }>): string {
    const directory = this.deps.directories().find(candidate => directoryHandleFor(candidate.nodeId) === call.directory)
    if (!directory) return `spawn ${call.directory}: no directory has that handle.`
    try {
      const nodeId = this.deps.spawn(directory.nodeId, call.title, call.prompt)
      this.monitors.add(nodeId)
      this.deps.log({ event: 'spawned', nodeId, directory: directory.cwd, title: call.title, prompt: call.prompt })
      return `spawn: started {${handleFor(nodeId)}} in ${directory.cwd}.`
    } catch (err) {
      return `spawn ${call.directory} failed: ${err instanceof Error ? err.message : String(err)}`
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
    this.deps.log({ event: 'sent', nodeId, name: this.deps.names.get(nodeId)?.name ?? null, message })
  }

  private async askFork(agent: RosterAgent, question: string, forkId: string | undefined): Promise<void> {
    const handle = handleFor(agent.nodeId)
    const existing = forkId ? this.forks.get(forkId) : undefined
    // Named now if it has no name yet: its answer will be quoted in its voice,
    // and the toast should already call it what the listener will hear.
    const named = this.deps.names.get(agent.nodeId) ?? this.deps.names.assign(agent.nodeId)
    const name = (): string => named?.name ?? agent.title
    const following = Boolean(existing && existing.nodeId === agent.nodeId)
    try {
      let result: ForkAnswer
      if (existing && following) {
        result = await this.deps.forks.ask({ forkId: existing.forkId, prompt: question })
      } else {
        if (!agent.claudeSessionId) throw new Error('that agent has no Claude Code session to copy')
        const lastSaidAtFork = this.lastSaid(agent)
        result = await this.deps.forks.fork({
          nodeId: agent.nodeId, sessionId: agent.claudeSessionId, prompt: forkPrompt(question),
        })
        this.forks.set(result.forkId, {
          forkId: result.forkId, nodeId: agent.nodeId, lastSaidAtFork, sessionAtFork: agent.claudeSessionId,
        })
      }
      const cost = result.costUsd === undefined ? 'cost unknown' : `$${result.costUsd.toFixed(2)}`
      this.deps.notify(following ? `Control asked ${name()}'s copy a follow-up: ${cost}` : `Control forked ${name()}: ${cost}`)
      this.events.push({ kind: 'fork-answer', handle, forkId: result.forkId, question, answer: result.answer })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      serverLog(`[receptionist] fork of ${handle} failed: ${message}`)
      this.deps.notify(`Control's fork of ${name()} failed: ${message.slice(0, 120)}`)
      this.events.push({ kind: 'fork-failed', handle, question, error: message })
    }
    this.maybeSpeakUp()
  }

  private forkSummaries(agents: readonly RosterAgent[]): ForkSummary[] {
    const summaries: ForkSummary[] = []
    for (const record of this.forks.values()) {
      const agent = agents.find(candidate => candidate.nodeId === record.nodeId)
      if (!agent) { this.forks.delete(record.forkId); continue }
      const movedOn = agent.state !== 'stopped'
        || agent.claudeSessionId !== record.sessionAtFork
        || this.lastSaid(agent) !== record.lastSaidAtFork
      summaries.push({ forkId: record.forkId, handle: handleFor(agent.nodeId), agentMovedOn: movedOn })
    }
    return summaries
  }

  private lastSaid(agent: RosterAgent): string {
    return agent.transcriptPath ? finalAgentMessage(this.deps.readTranscript(agent.transcriptPath)) : ''
  }

  /** Say a reply. Returns whether a speech monitor now owns the phase. */
  private async speak(attempt: Attempt, body: string, reply: Reply): Promise<boolean> {
    const agents = this.deps.agents()
    const byHandle = new Map(agents.map(agent => [handleFor(agent.nodeId), agent]))
    const mentioned: NodeId[] = []
    const resolve = (handle: string): { name: string; voice: string } | undefined => {
      const agent = byHandle.get(handle)
      if (!agent) return undefined
      const named = this.deps.names.get(agent.nodeId) ?? this.deps.names.assign(agent.nodeId)
      if (!named) return undefined
      if (!mentioned.includes(agent.nodeId)) mentioned.push(agent.nodeId)
      return { name: named.name, voice: named.voice }
    }
    const spoken = renderSpeech(reply.say, resolve, RECEPTIONIST_VOICE)
    for (const nodeId of mentioned) this.deps.names.touch(nodeId)
    const froms = reply.say.map(part => part.from)
    // Committed together, and only now: a turn superseded before this point
    // leaves the history exactly as it found it.
    this.history = bounded([
      ...this.history, { role: 'user', content: body }, { role: 'assistant', content: storedReply(froms, spoken) },
    ])
    this.lastAnswer = { historyIndex: this.history.length - 1, froms, spoken }
    this.deps.history.save(this.history)
    this.deps.log({ event: 'turn', body, say: reply.say, spoken, tools: reply.tools })
    // The camera follows the conversation: the agent quoted first, else the
    // agent mentioned first.
    const quoted = froms.find(from => byHandle.has(from))
    const focus = quoted ? byHandle.get(quoted)?.nodeId : mentioned[0]
    if (focus) this.deps.focus(focus)
    if (!spoken.length) return false
    return this.channel.deliver(attempt, spoken.map(({ text, voice }) => ({ text, voice })))
  }

  /** Cut the last answer in the history down to what the listener heard, if they interrupted it. */
  private async redactInterrupted(): Promise<void> {
    const heard = await this.channel.heardPrefix()
    const last = this.lastAnswer
    this.lastAnswer = undefined
    if (heard === undefined || !last || this.history[last.historyIndex]?.role !== 'assistant') return
    const kept = redactSpoken(last.spoken, heard)
    this.history[last.historyIndex] = { role: 'assistant', content: storedReply(last.froms, kept) }
    this.deps.history.save(this.history)
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

/** The states an agent stops in: anything that is not working. */
function isSettled(state: ClaudeState): boolean {
  return state !== 'working' && state !== 'working_background'
}

/** A reply as the model sees it later: what was actually spoken, without the introductions it never wrote. */
function storedReply(froms: readonly string[], spoken: readonly RenderedPart[]): string {
  const say: SayPart[] = spoken.map((part, i) => ({ from: froms[i], text: part.text.slice(part.introLength) }))
  return JSON.stringify({ say })
}

function bounded(messages: HistoryMessage[]): HistoryMessage[] {
  let kept = messages.slice(-MAX_HISTORY_MESSAGES)
  while (kept.length > 1 && kept.reduce((sum, message) => sum + message.content.length, 0) > MAX_HISTORY_CHARS) {
    kept = kept.slice(1)
  }
  // A history must open with the user's side, or the model reads its own
  // answer as the question.
  while (kept.length && kept[0].role !== 'user') kept = kept.slice(1)
  return kept
}

