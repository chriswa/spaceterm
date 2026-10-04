import { createHash } from 'crypto'
import type { NodeId } from '../../shared/ids'
import type { ClaudeState } from '../../shared/state'
import { serverLog } from '../server-log'
import { finalAgentMessage, type TranscriptMessage } from '../summary-chat'
import type { SpeechBackend } from '../voice-operator'
import { SpeechChannel, speechFailureMessage, type Attempt, type SpeechPhase } from '../speech-channel'
import type { NamedVoice } from './name-voice-table'
import { RECEPTIONIST_VOICE } from './name-voice-table'
import { DIRECTORY_PREFIX, editDistance, Handles, NODE_PREFIX } from './handles'
import { whereWords, type NearbyNode } from './nearby'
import type { CameraBounds } from '../../shared/protocol'
import type { SideQuestionResult, SideQuestionUsage } from '../side-questions'
import {
  FORMAT_REMINDER, RECEPTIONIST_SYSTEM_PROMPT, renderTurnBody, type ReceptionistEvent,
} from './prompt'
import {
  CONTROL, isBlocking, parseReply, redactSpoken, renderSpeech, type RenderedPart, type Reply, type SayPart, type ToolCall,
} from './reply'
import {
  cacheWords, NO_SIDE_QUESTIONS, readAgent, renderDirectories, renderRoster, STATE_WORDS, type RosterAgent, type RosterDirectory,
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
  /**
   * When the daemon compacts the session next (epoch ms): a moment ago, for a
   * compaction this turn started; an hour on, for the one it scheduled.
   */
  compactsAt?: number
}

/**
 * The session is still answering an earlier message. Not a lost session: the
 * daemon finishes a turn it started even after its caller has gone, so the
 * next message waits for it.
 */
export class SessionBusy extends Error {}

/** Which session Control is in, and which instructions it was started with. */
export interface SavedSession {
  sessionId: string
  /** A new prompt means a new session: an old one keeps the instructions it began with. */
  promptHash: string
  /** When the daemon compacts it, as its last answer said (epoch ms). */
  compactsAt?: number
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
    /** The last `count` messages, oldest first. */
    recent(count: number): RecordMessage[]
  }
  names: {
    get(nodeId: NodeId): NamedVoice | undefined
    assign(nodeId: NodeId): NamedVoice | undefined
    touch(nodeId: NodeId): void
    /** The node holding a name, live or not. */
    byName(name: string): NodeId | undefined
  }
  /**
   * Ask an agent a side question: answered inside the agent from its own
   * cached context, without interrupting it or entering its transcript. See
   * `side-questions.ts`. Always resolves.
   */
  askAgent(nodeId: NodeId, prompt: string): Promise<SideQuestionResult>
  /**
   * Move the camera to a node, on every client. Only ever because the user
   * asked to be taken there: see the force_user_camera tool.
   */
  focus(nodeId: NodeId): void
  /** Every node on the canvas, for the handles force_user_camera takes. */
  nodeIds(): NodeId[]
  /** Archive a node and everything under it, as the user's own archive does. Returns how many nodes went. */
  archive(nodeId: NodeId): number
  /**
   * A toast on every client. Side questions are what the receptionist pays
   * the agents' model for, so each one is announced with what it used.
   */
  notify(text: string): void
  /** Type `text` into an agent's prompt and submit it — Ship it. */
  send(nodeId: NodeId, text: string): void
  /** Press Escape in an agent's terminal. */
  interrupt(nodeId: NodeId): void
  /**
   * What the user is looking at: the screen they last talked to the
   * receptionist from (or, failing that, last moved), and the nodes nearest
   * its middle. Undefined when no screen has reported where it is.
   */
  userView(): { view: CameraBounds; nodes: NearbyNode[] } | undefined
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
/** How long a message waits before trying a busy session again, and how many times. */
const BUSY_RETRY_MS = 1_000
const BUSY_RETRIES = 30
/**
 * The exchanges repeated word for word to a session that has just forgotten
 * them, and the most of each that is kept.
 */
const RECAP_MESSAGES = 10
const RECAP_MESSAGE_CHARS = 1_500
const LAST_SAID_EVENT_CHARS = 1_500
/** Agents `find_agent` reports, best first. */
const FIND_AGENT_RESULTS = 10

/** What each kind of node is, said plainly. */
const NODE_WORDS: Record<NearbyNode['type'], string> = {
  terminal: 'a terminal',
  markdown: 'a note',
  title: 'a title',
  directory: 'a directory',
  file: 'a file',
  'meta-group': 'a group',
  'meta-doc': 'a document',
}

/** What each failure means for what to do next, as the model is told it. */
const SIDE_QUESTION_FAILURES: Record<Exclude<SideQuestionResult, { ok: true }>['reason'], string> = {
  'not-listening': "that agent's Claude Code was started before side questions were added to Spaceterm, so it is not listening for them, and it will not be until it restarts. This is not because it is busy: an up-to-date agent answers side questions while it works. Answer from its transcript with read instead, or send it the question if the user wants the agent itself to answer; offer the user to restart it if they want it to take side questions",
  'nothing-to-fork': 'that agent has not finished its first reply yet, so there is nothing to ask',
  timeout: 'no answer came in time',
  'api-error': 'the model request failed',
  'empty-reply': 'the agent gave no answer',
  aborted: 'the question was cut off',
  'invalid-reply': 'the answer came back garbled',
}

/** The same failures, as a toast on the user's screen says them. */
const SIDE_QUESTION_TOASTS: Record<Exclude<SideQuestionResult, { ok: true }>['reason'], string> = {
  'not-listening': 'it was started before side questions existed, and takes them after a restart',
  'nothing-to-fork': 'it has not answered anything yet',
  timeout: 'no answer in time',
  'api-error': 'the model request failed',
  'empty-reply': 'it gave no answer',
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
 * How long after a dictation ends the receptionist stays held, for its words
 * to arrive as a turn of their own: held, events wait for that turn rather
 * than starting one that it would only supersede.
 */
const QUIET_GRACE_MS = 3_000

/**
 * The question an agent is actually given. Unframed, an agent answering a bare
 * question out of nowhere is suspicious and long-winded — and writes for a
 * screen, which the receptionist then retells in its own words rather than
 * quoting, when the point is to hear the agent.
 */
export function sideQuestionPrompt(question: string): string {
  return "A quick side question from the user's receptionist, answered from what you already know; you cannot use tools for this. " +
    'Your answer is read aloud to the user by text-to-speech, word for word and in your voice, as part of a spoken conversation. ' +
    'So keep it concise and conversational: only what matters to the user, in a few plain spoken sentences, in the first person, ' +
    'with no markdown, lists, code, file names or paths. An answer that is longer than that, or not fit to be heard, ' +
    'gets summarized by the receptionist in its own words instead of yours.' +
    `\n\nQuestion: ${question}`
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
  /**
   * Agents being watched for their next stop. `after-work` is a send's or a
   * spawn's: only a stop after the agent has started working on the message
   * counts. A stop on the way in — the Escape that declines a pending
   * question, before the message is even pasted — used to fire it at once,
   * with nothing said, and the real answer then went unreported.
   */
  private readonly monitors = new Map<NodeId, 'next-stop' | 'after-work'>()
  /** The stop each agent was last reported at (its `stateSince`), so the same stop is never reported twice. */
  private readonly reportedStops = new Map<NodeId, number | undefined>()
  private readonly channel: SpeechChannel
  private talkToMe = true
  /**
   * The user is dictating, or has only just stopped: nothing may be said and
   * no event may start a turn. See `userSpeaking`.
   */
  private held = false
  /** Whether the last report was of dictation under way; bumped with every report, so a stale grace period does nothing. */
  private dictating = false
  private holdChanges = 0
  private readonly heldWaiters = new Set<() => void>()
  /** The turn under way that no one asked for, if any: dropped when the user starts talking. */
  private unprompted: Attempt | undefined

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
    // Their words are here, so they have finished: no need to wait out the grace period.
    if (!this.dictating) this.release()
    await this.runTurn(text)
  }

  /**
   * Whether the user is dictating, on any device. While they are, and for a
   * moment after, the receptionist never talks over them, as Voice Operator
   * holds its queue while the user speaks — and goes a step further: it does
   * not even ask the model, since anything it came up with would be stale by
   * the time it could be said. Events wait in the queue; an unprompted turn
   * already under way is dropped, its events back in the queue; a reply the
   * user asked for waits to be spoken.
   */
  userSpeaking(speaking: boolean): void {
    const change = ++this.holdChanges
    this.dictating = speaking
    if (speaking) {
      this.held = true
      if (this.unprompted?.isCurrent) {
        serverLog('[receptionist] the user started talking: dropping an unprompted turn until they finish')
        void this.channel.cancel()
      }
      return
    }
    void this.deps.sleep(QUIET_GRACE_MS).then(() => {
      if (change === this.holdChanges) this.release()
    })
  }

  private release(): void {
    this.holdChanges++
    if (!this.held) return
    this.held = false
    for (const resume of this.heldWaiters) resume()
    this.heldWaiters.clear()
    this.maybeSpeakUp()
  }

  /** Resolves once the user is no longer dictating. */
  private untilUserDone(): Promise<void> {
    if (!this.held) return Promise.resolve()
    return new Promise((resolve) => this.heldWaiters.add(resolve))
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
    const waiting = this.monitors.get(nodeId)
    if (!waiting) return
    if (!isSettled(state)) {
      if (waiting === 'after-work') this.monitors.set(nodeId, 'next-stop')
      return
    }
    if (waiting === 'after-work') return
    this.fireMonitor(nodeId, state)
  }

  /** Watch an agent until its next stop; see `monitors`. */
  private watch(nodeId: NodeId, kind: 'next-stop' | 'after-work'): void {
    // Already at work on it: its next stop is the one.
    const state = this.deps.agents().find(candidate => candidate.nodeId === nodeId)?.state
    this.monitors.set(nodeId, kind === 'after-work' && state && !isSettled(state) ? 'next-stop' : kind)
  }

  /** The agent has stopped: tell the model what it last said. */
  private fireMonitor(nodeId: NodeId, state: ClaudeState): void {
    const agent = this.deps.agents().find(candidate => candidate.nodeId === nodeId)
    this.monitors.delete(nodeId)
    if (!agent) return
    this.reportedStops.set(nodeId, agent.stateSince)
    const lastSaid = agent.transcriptPath ? finalAgentMessage(this.deps.readTranscript(agent.transcriptPath)) : ''
    this.events.push({
      kind: 'agent-stopped', handle: this.handles([agent]).of(nodeId) ?? nodeId, state: STATE_WORDS[state],
      lastSaid: lastSaid.slice(-LAST_SAID_EVENT_CHARS),
    })
    this.maybeSpeakUp()
  }

  private maybeSpeakUp(): void {
    if (!this.talkToMe || this.held || !this.events.length || this.channel.isProducing()) return
    void this.runTurn(undefined)
  }

  /**
   * One turn: the user's words (or, with none, pending events), as many model
   * steps as its `read` calls need, and then speech.
   */
  private async runTurn(heard: string | undefined): Promise<void> {
    const attempt = this.channel.begin('thinking')
    this.unprompted = heard === undefined ? attempt : undefined
    if (heard !== undefined) await this.noteInterruption()
    const events = this.events.splice(0)
    const body = renderTurnBody(events, heard)
    // Taken before this message joins the record, for a session that has forgotten what led up to it.
    const earlier = this.deps.record.recent(RECAP_MESSAGES)
    if (heard !== undefined) this.deps.record.append([{ role: 'user', content: body }])
    let monitoring = false
    try {
      const reply = await this.converse(attempt, body, earlier)
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
  private async converse(attempt: Attempt, body: string, earlier: readonly RecordMessage[]): Promise<Reply | undefined> {
    let message = body
    for (let step = 1; step <= MAX_STEPS; step++) {
      const answer = await this.ask(attempt, `${message}\n\n${FORMAT_REMINDER}`, step === 1 ? earlier : [])
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
        await this.untilUserDone()
        if (!attempt.isCurrent) return undefined
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
   *
   * `earlier` is the conversation leading up to this message, repeated to a
   * session that has forgotten it — a new one, or one compacted to a summary —
   * so it never loses the thread of what was just said.
   */
  private ask(attempt: Attempt, prompt: string, earlier: readonly RecordMessage[]): Promise<SessionAnswer> {
    const run = async (): Promise<SessionAnswer> => {
      // Superseded while queued: never sent, so there is nothing to answer.
      if (!attempt.isCurrent) throw new Error('superseded before it was sent')
      // Not the attempt's signal. Being talked over must not cut the call
      // short: the daemon would go on answering, the queue would move on, and
      // the next message would find the session busy. The reply is let in and
      // dropped below instead.
      const signal = AbortSignal.timeout(MODEL_TIMEOUT_MS)
      const session = this.session
      const sessionId = session?.sessionId
      // Notes go on whatever message leaves next, read only now: the message
      // ahead of this one in the queue may have just produced one.
      const notes = this.notes.splice(0)
      const recap = forgets(session) ? renderRecap(earlier) : undefined
      const message = [recap, notes.length ? `NOTE: ${notes.join(' ')}` : undefined, prompt].filter(Boolean).join('\n\n')
      try {
        const answer = await this.askWhenFree(
          sessionId ? { prompt: message, sessionId } : { prompt: message, systemPrompt: RECEPTIONIST_SYSTEM_PROMPT }, signal,
        )
        if (answer.sessionId !== sessionId || answer.compactsAt !== session?.compactsAt) {
          this.session = {
            sessionId: answer.sessionId, promptHash: PROMPT_HASH,
            ...(answer.compactsAt !== undefined ? { compactsAt: answer.compactsAt } : {}),
          }
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
        if (sessionId && !signal.aborted && !(err instanceof SessionBusy)) throw new LostSession(err)
        throw err
      }
    }
    const next = this.queue.then(run, run)
    this.queue = next.catch(() => undefined)
    return next
  }

  /**
   * A busy session is still answering a message this server gave up on (it
   * timed out, or a restart came in between), so it is waited for, never
   * abandoned: abandoning it is what forgets the conversation.
   */
  private async askWhenFree(turn: SessionTurn, signal: AbortSignal): Promise<SessionAnswer> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.deps.askModel(turn, signal)
      } catch (err) {
        if (!(err instanceof SessionBusy) || signal.aborted || attempt >= BUSY_RETRIES) throw err
        await this.deps.sleep(BUSY_RETRY_MS)
      }
    }
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
      if (call.tool === 'nearby') {
        results.push(this.nearby(agents, handles))
        continue
      }
      if (call.tool === 'force_user_camera') {
        const nodeId = this.resolveTarget(call.target, handles, agents)
        if (!nodeId) {
          done.push(`force_user_camera [${call.target}]: that is gone, so the camera did not move`)
          continue
        }
        this.deps.focus(nodeId)
        this.deps.log({ event: 'camera', target: call.target, nodeId })
        const agent = agents.find(candidate => candidate.nodeId === nodeId)
        done.push(`force_user_camera took the user to ${agent ? this.describe(agent, handles) : `[${call.target}]`}`)
        continue
      }
      if (call.tool === 'find_agent') {
        results.push(await this.findAgent(call.query, agents, handles))
        continue
      }
      const nodeId = this.resolve(call.agent, handles, agents)
      const agent = agents.find(candidate => candidate.nodeId === nodeId)
      // checkHandles already refused unknown handles; this only guards an agent
      // that vanished between the check and now.
      if (!agent) {
        results.push(`${call.tool} {${call.agent}}: that agent is gone.`)
        continue
      }
      // An agent acted on is about to be spoken of, so it is named now: the
      // confirmation should carry the name the user will hear.
      // Not one being archived: its name goes back to the pool with it.
      if (call.tool !== 'read' && call.tool !== 'archive_agent') this.deps.names.get(agent.nodeId) ?? this.deps.names.assign(agent.nodeId)
      const who = this.describe(agent, handles)
      switch (call.tool) {
        case 'read': {
          // A search covers the whole session; a plain read is the recent part.
          const read = call.search ? this.deps.readWholeTranscript : this.deps.readTranscript
          const messages = agent.transcriptPath ? read(agent.transcriptPath) : []
          // The cache comes with the transcript: it decides whether ask_agent is worth it.
          const cache = (agent.cacheWarmUntil !== undefined ? `\ncache: ${cacheWords(agent, Date.now())}` : '')
            + (agent.takesSideQuestions === false ? `\n${NO_SIDE_QUESTIONS}` : '')
          results.push(`read {${call.agent}}${call.search ? ` for "${call.search}"` : ''}:${cache}\n${readAgent(messages, call.search)}`)
          break
        }
        case 'monitor':
          // Already stopped at a stop not yet reported — it may have answered
          // a moment before the monitor was set — so it is reported now, not
          // at a stop that may never come.
          // Unless it is the very stop just reported: watching again for a
          // later one is what monitor means then.
          if (isSettled(agent.state) && !(this.reportedStops.has(agent.nodeId) && this.reportedStops.get(agent.nodeId) === agent.stateSince)) {
            this.monitors.set(agent.nodeId, 'next-stop')
            this.fireMonitor(agent.nodeId, agent.state)
            done.push(`monitor found ${who} already stopped; what it last said comes as an event`)
          } else {
            this.watch(agent.nodeId, 'next-stop')
            done.push(`monitor is watching ${who}`)
          }
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
        case 'archive_agent': {
          this.monitors.delete(agent.nodeId)
          const count = this.deps.archive(agent.nodeId)
          // Into the full record, so `recall` can answer "what happened to Kevin?".
          this.deps.record.append([{ role: 'assistant', content: `ARCHIVED ${who}` }])
          done.push(`archive_agent archived ${who}${count > 1 ? `, with the ${count - 1} node${count === 2 ? '' : 's'} under it` : ''}; it is in the archive, where the user can restore it`)
          break
        }
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
      this.watch(nodeId, 'after-work')
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
    this.watch(nodeId, 'after-work')
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
      this.deps.notify(`Control's question to ${name} failed: ${SIDE_QUESTION_TOASTS[result.reason]}`)
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

  /** Handles for any node on the canvas, as nearby gives them for what is not an agent. */
  private nodeHandles(): Handles {
    return new Handles(this.deps.nodeIds(), NODE_PREFIX)
  }

  /** Whatever force_user_camera can take the user to: an agent by handle or name, a directory, or any node. */
  private resolveTarget(ref: string, handles: Handles, agents: readonly RosterAgent[]): NodeId | undefined {
    return this.resolve(ref, handles, agents)
      ?? this.directoryHandles(this.deps.directories()).find(ref)
      ?? this.nodeHandles().find(ref)
  }

  /**
   * The live agent a reference means: its handle, or — once it has one — its
   * name, in any case. The user says names, so the model writes them; making
   * the name a valid reference is what stops it writing both.
   */
  private resolve(ref: string, handles: Handles, agents: readonly RosterAgent[]): NodeId | undefined {
    const byHandle = handles.find(ref)
    if (byHandle) return byHandle
    const byName = this.deps.names.byName(ref.trim())
    return byName && agents.some(agent => agent.nodeId === byName) ? byName : undefined
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
    // Names as well as handles: a misheard or misspelled name is the likelier slip.
    const nameOf = new Map<string, NodeId>()
    for (const agent of agents) {
      const name = this.deps.names.get(agent.nodeId)?.name
      if (name) nameOf.set(name.toLowerCase(), agent.nodeId)
    }
    const suggest = (ref: string): string => {
      const wanted = ref.trim().toLowerCase()
      const nearNames = [...nameOf.keys()].filter(name => editDistance(wanted, name) <= Math.max(1, Math.floor(name.length / 3)))
      const near = [...new Set([...nearNames.map(name => nameOf.get(name)!), ...handles.nearest(ref).map(h => handles.find(h)!)])]
        .slice(0, 2)
        .flatMap(nodeId => {
          const agent = byId.get(nodeId)
          return agent ? [this.describe(agent, handles)] : []
        })
      return near.length ? ` Did you mean ${near.join(' or ')}?` : ' Use list_agents or find_agent to look it up.'
    }
    const unknownAgent = (ref: string, where: string): void => {
      if (!this.resolve(ref, handles, agents)) problems.push(`"${ref}" (${where}) is not a live agent's name or handle.${suggest(ref)}`)
    }
    for (const call of reply.tools) {
      if (call.tool === 'spawn') {
        const directories = this.directoryHandles(this.deps.directories())
        if (!directories.find(call.directory)) {
          const near = directories.nearest(call.directory)
          problems.push(`"${call.directory}" (in spawn) is not a directory's handle.${near.length ? ` Did you mean ${near.join(' or ')}?` : ' Use list_agents to see the directories.'}`)
        }
      } else if (call.tool === 'force_user_camera') {
        if (!this.resolveTarget(call.target, handles, agents)) {
          problems.push(`"${call.target}" (in force_user_camera) is not a live agent, a directory, or a node from nearby.${suggest(call.target)}`)
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

  /**
   * The nearby tool: what the user is looking at, nearest the middle of their
   * screen first. Agents come with their name or handle so they can be acted
   * on; anything else is described for what it is.
   */
  private nearby(agents: readonly RosterAgent[], handles: Handles): string {
    const seen = this.deps.userView()
    if (!seen) return 'nearby: no screen has said where it is looking, so where the user is looking is unknown.'
    const byId = new Map(agents.map(agent => [agent.nodeId, agent]))
    const nodeHandles = this.nodeHandles()
    const lines = seen.nodes.map(node => {
      const agent = byId.get(node.nodeId)
      const what = agent
        ? `${this.describe(agent, handles)}, an agent, ${STATE_WORDS[agent.state]}`
        : `[${nodeHandles.of(node.nodeId) ?? node.nodeId}] ${NODE_WORDS[node.type]}${node.label ? ` "${node.label}"` : ''}${node.type === 'terminal' ? ', not an agent you can act on' : ''}`
      return `${whereWords(node, seen.view)}: ${what}`
    })
    return `nearby:\n${lines.length ? lines.join('\n') : 'nothing is on the canvas.'}`
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
    spoken: RenderedPart[]; mentioned: NodeId[]
  } {
    const handles = this.handles(agents)
    const byId = new Map(agents.map(agent => [agent.nodeId, agent]))
    const mentioned: NodeId[] = []
    const resolve = (ref: string): { name: string; voice: string } | undefined => {
      const nodeId = this.resolve(ref, handles, agents)
      const agent = nodeId ? byId.get(nodeId) : undefined
      if (!agent) return undefined
      const named = this.deps.names.get(agent.nodeId) ?? this.deps.names.assign(agent.nodeId)
      if (!named) return undefined
      if (!mentioned.includes(agent.nodeId)) mentioned.push(agent.nodeId)
      return { name: named.name, voice: named.voice }
    }
    const spoken = renderSpeech(say, resolve, RECEPTIONIST_VOICE)
    for (const nodeId of mentioned) this.deps.names.touch(nodeId)
    return { spoken, mentioned }
  }

  private async speak(attempt: Attempt, body: string, reply: Reply): Promise<boolean> {
    // Never over the user. Talked over while it waited, the reply is never said.
    await this.untilUserDone()
    if (!attempt.isCurrent) {
      this.notes.push('Your previous reply was never spoken: the user spoke over it, so they heard none of it.')
      return false
    }
    const agents = this.deps.agents()
    const handles = this.handles(agents)
    // The camera stays where the user put it: an agent being spoken of is no
    // reason to move it. Only force_user_camera does, when they ask.
    const { spoken } = this.render(reply.say, agents)
    const froms = reply.say.map(part => part.from)
    this.lastSpoken = spoken
    this.deps.record.append([{ role: 'assistant', content: storedReply(froms, spoken) }])
    this.deps.log({ event: 'turn', body, say: reply.say, spoken, tools: reply.tools })
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
    // Talked over, or lost with the phone's page: either way, only this much was heard.
    this.notes.push(`Your last reply was cut off before the user heard all of it. They heard only: "${audible}". They did not hear the rest; if it still matters, say it again.`)
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

/**
 * Whether the session has lost the conversation word for word: there is none
 * yet, or the daemon has compacted it to a summary since its last answer. A
 * compaction comes due on the daemon's clock; a message sent after that waits
 * for it, so it reaches the compacted session.
 */
function forgets(session: SavedSession | undefined): boolean {
  return !session || (session.compactsAt !== undefined && Date.now() >= session.compactsAt)
}

/** The conversation leading up to a message, for a session that has forgotten it. */
function renderRecap(earlier: readonly RecordMessage[]): string | undefined {
  if (!earlier.length) return undefined
  const lines = earlier.map(({ role, content }) => {
    const text = content.length <= RECAP_MESSAGE_CHARS ? content : `${content.slice(0, RECAP_MESSAGE_CHARS - 1)}…`
    // A user message is a turn's body, already headed THE USER SAYS.
    return role === 'user' ? text : `YOU: ${text}`
  })
  return `EARLIER CONVERSATION, word for word, oldest first:\n${lines.join('\n\n')}`
}

/** A session that failed to answer, as against a turn that was cancelled. */
class LostSession extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause))
  }
}
