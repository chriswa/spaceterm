import { createHash, randomUUID } from 'crypto'
import type { NodeId } from '../../shared/ids'
import type { ClaudeState } from '../../shared/state'
import { serverLog } from '../server-log'
import { INTERRUPTED_MARKER, lastAgentProse, type TranscriptMessage } from '../summary-chat'
import { joinSpeechParts, speechPartStarts, type SpeechBackend } from '../voice-operator'
import { SpeechChannel, speechFailureMessage, type Attempt, type SpeechPhase } from '../speech-channel'
import { ConsumptionLedger, type ConsumedHow, type Via } from './consumption'
import type { NamedVoice, VoiceGender } from './name-voice-table'
import { RECEPTIONIST_NAME, RECEPTIONIST_VOICE } from './name-voice-table'
import type { NameProblem } from './name-registry'
import { DIRECTORY_PREFIX, editDistance, Handles, NODE_PREFIX } from './handles'
import { AGENT_TOKEN, agentToken, parseAgentRef, stripBraces } from './agent-token'
import { whereWords, type NearbyNode } from './nearby'
import type { CameraBounds, ControlTrace, ControlTraceKind, ControlTranscriptEntry } from '../../shared/protocol'
import type { SideQuestionResult, SideQuestionUsage } from '../side-questions'
import {
  FORMAT_REMINDER, HANDOVER_CHARS, HANDOVER_HEADING, HANDOVER_PROMPT, RECEPTIONIST_SYSTEM_PROMPT, renderEvent, renderTurnBody, type ReceptionistEvent, type ReturnNews,
} from './prompt'
import {
  CONVERSATION_WORDS, decideInterruption, HANG_ON, lastWords, splitAtOffset, type InterruptionContext, type InterruptionVerdict,
} from './self-interruption'
import {
  actionHeadline, CONTROL, heardLengths, isAction, playedLengths, isBlocking, isBookkeeping, isLookup, parseReply, redactSpoken, renderSpeech, showToolCall, silencedIfQuiet,
  type RenderedPart, type Reply, type SayPart, type SpokenPart, type ToolCall,
} from './reply'
import { ageWords, cacheNote, pickNext, type Backlog, type BacklogContext, type BacklogItem } from './backlog'
import { decidePause, PAUSE_MS, type PauseJudgement, type PauseVerdict } from './backlog-pause'
import type { Watches, WatchKind } from './watches'
import { RESTARTED_MID_REPLY, type CarryOver } from './carry-over'
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
  /**
   * The system prompt, sent with every message, not just the first, so the
   * daemon can refuse it if it is not the one the session started with.
   * Claude Code stores a session's instructions with its transcript and keeps
   * them for good: a process resumed on the session ignores any new ones. New
   * instructions therefore mean a new session — see `Receptionist.handOver`.
   * Left out only for the old session's handover, which runs on its own.
   */
  systemPrompt?: string
  /**
   * The session's last message: its handover to the session replacing it.
   * Nothing keeps it alive or compacts it afterwards.
   */
  retiring?: true
  /** Names this message, so that it can be aborted: see `ReceptionistDeps.askModel`. */
  turnId?: string
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
  /**
   * The message was aborted before its answer was finished, and `text` is
   * empty. An abort is not a rewind: `promptInSession` says whether the
   * session got the message, and keeps it with its answer marked
   * interrupted, or never saw it.
   */
  aborted?: { promptInSession: boolean }
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

/**
 * A message as it goes into the record. A reply also keeps, beside what the
 * model sees of it, how it reached the user — `delivery: 'text'` when written
 * to a muted device — and each part's voice and spoken introduction, so that
 * it can be replayed as it was said.
 */
export type RecordedMessage = RecordMessage & { delivery?: 'text'; voices?: string[]; intros?: string[] }


export interface ReceptionistDeps {
  /**
   * Jev's probability that Control should cut its own reply short for news
   * that arrived while it was speaking: see self-interruption.ts.
   */
  judgeInterruption(ctx: InterruptionContext): Promise<number>
  /** Things Control set aside to bring up with the user later: see backlog.ts. */
  backlog: Pick<Backlog, 'size' | 'all' | 'add' | 'take' | 'restore'>
  /** The agents being watched for their next stop, kept across server restarts: see watches.ts. */
  watches: Watches
  /** Control's notes, and whether it was mid-reply, across server restarts: see carry-over.ts. */
  carryOver: Pick<CarryOver, 'take' | 'speaking' | 'leave'>
  /** Jev's probability for each backlog item, in order: that it should come next, or that it is about `ctx.about`. See backlog.ts. */
  judgeBacklog(ctx: BacklogContext): Promise<number[]>
  /** Jev's probabilities that the user could switch topics now, and after a pause: see backlog-pause.ts. */
  judgePause(conversation: string): Promise<PauseJudgement>
  /**
   * One message to Control's Claude Code session. Rejects on failure, or when
   * `signal` (the time limit) fires. When `abort` fires, the daemon stops the
   * turn where it is, and the answer comes back at once with `aborted` set.
   */
  askModel(turn: SessionTurn, signal: AbortSignal, abort?: AbortSignal): Promise<SessionAnswer>
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
    /** Returns where each message starts in the record: its id, for `amendHeard`. */
    append(messages: readonly RecordedMessage[]): number[]
    /**
     * The reply at `replyAt` was cut off, or the user marked where they
     * stopped taking it in: `heard[i]` is how many characters of its part `i`
     * were taken in. For the transcript view, which strikes out the rest — or,
     * `unread`, shows it as still waiting to be read; never shown to the
     * model, which is told with a note instead.
     */
    amendHeard(replyAt: number, heard: number[], unread?: boolean): void
    /** Part `part` of the reply at `of` taken in since, `from` to `to`: see `ConsumptionLedger`. Transcript-only, as `amendHeard`. */
    consumed(of: number, part: number, from: number, to: number, how: ConsumedHow): void
    /** The record's last few dozen entries, oldest first, as the transcript view reads them: to restore the ledger. */
    tail(): ControlTranscriptEntry[]
    /** Part `part` of the reply at `of` as it was said, for a replay; undefined if there is none. See `spokenPart`. */
    spokenPart(of: number, part: number): { intro: string; text: string; voice: string } | undefined
    /**
     * Actions that never ran, because the words they waited on were never
     * heard: each as its line would read had it run. For the transcript view,
     * which strikes them out; never shown to the model, told with a note instead.
     */
    notDone(actions: string[]): void
    /**
     * Why Control did or did not speak — news arriving, the backlog, watches,
     * a reply never spoken — for the transcript view, which shows it when
     * asked to. Never shown to the model.
     */
    trace(trace: ControlTrace): void
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
    /** Why `name` can't be given to the node (or to one about to be spawned, when undefined). See `NameRegistry`. */
    nameProblem(nodeId: NodeId | undefined, name: string): NameProblem | undefined
    /** Give the node a name of Control's choosing, with a voice of its gender. See `NameRegistry`. */
    setName(nodeId: NodeId, name: string, gender: VoiceGender):
      { ok: true; named: NamedVoice; voiceChanged: boolean } | { ok: false; problem: NameProblem }
  }
  /**
   * Ask an agent a side question: answered inside the agent from its own
   * cached context, without interrupting it or entering its transcript. See
   * `side-questions.ts`. Always resolves.
   */
  askAgent(nodeId: NodeId, prompt: string): Promise<SideQuestionResult>
  /**
   * Move the camera to a node, on the device holding Control. Only ever because the user
   * asked to be taken there: see the force_user_camera tool.
   */
  focus(nodeId: NodeId): void
  /** Every node on the canvas, for the handles force_user_camera takes. */
  nodeIds(): NodeId[]
  /** Archive a node and everything under it, as the user's own archive does. Returns how many nodes went. */
  archive(nodeId: NodeId): number
  /**
   * Bring an archived agent back, as the user's own unarchive does: its surface
   * returns and its session resumes. Resolves once the session is up and
   * takes input (`ready`), so a send straight after it is not lost; or, if it
   * has not said so in time, with it back but perhaps not yet listening
   * (`not-ready`). `failed` when it could not be resumed, or its session ended
   * before it was up.
   */
  unarchive(nodeId: NodeId): Promise<'ready' | 'not-ready' | 'not-archived' | 'failed'>
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
   * Let go of Control, exactly as the Control button does when it lets go:
   * no device holds it, every button shows it, and nobody hears it. See go_quiet.
   */
  letGo(): void
  /**
   * What the user is looking at: the screen of the device holding Control
   * (or, failing that, the one that last moved), and the nodes nearest
   * its middle. Undefined when no screen has reported where it is.
   */
  userView(): { view: CameraBounds; nodes: NearbyNode[] } | undefined
  /** Directory nodes, where a new agent can be started. */
  directories(): RosterDirectory[]
  /** Start a new Claude surface under a directory node. Returns its node. */
  spawn(directoryNodeId: NodeId, title: string, prompt: string): NodeId
  /** Change an agent surface's title, as the user's own rename does. */
  retitle(nodeId: NodeId, title: string): void
  /** Append-only record of every turn. Best-effort. */
  log(entry: Record<string, unknown>): void
  sleep(ms: number): Promise<void>
  /**
   * Resolves when it is time to look again where the voice is in a reply, for
   * the transcript's lit word: `VOICE_FOLLOW_MS` from now. Apart from `sleep`
   * so that a test, whose sleeps are instant, follows the voice only if it asks to.
   */
  voiceTick(): Promise<void>
  /** Whether Voice Operator is publishing a port: see SpeechChannel's deps. */
  voiceOperatorDiscovered(): boolean
}

/** Backlog items taken off for one turn, and how the model is told of them. */
interface TakenItems {
  items: BacklogItem[]
  described: string
}

/** An agent that is no longer live, as it was last seen, with the handle it had then. */
interface EndedAgent {
  agent: RosterAgent
  handle: string
}

/**
 * Who hears Control: a device's speech, and an id telling one device from
 * another. `reading` when that device has muted Control: it is there, but
 * Control's words are written to it rather than spoken.
 */
export interface Listener {
  id: string
  speech: SpeechBackend
  reading?: boolean
}

export interface ReceptionistOptions {
  /** Who hears Control to begin with, or nobody: see `setListener`. */
  listener: Listener | undefined
  onPhase(phase: SpeechPhase): void
  onError(message: string): void
  /** Who is being heard as speech plays: "Control", or the agent it quotes; undefined once nothing is. */
  onSpeaker?(speaker: string | undefined): void
  /** Replies with words waiting for the user: see `ConsumptionLedger.unread`. */
  onUnread?(unread: { count: number; first?: number }): void
  /**
   * How far the voice has got through the reply at `of` in the record, each
   * part's characters as stored; undefined once nothing is being spoken.
   */
  onSpeaking?(speaking: { of: number; parts: number[] } | undefined): void
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
/** Ended agents kept for `read` and `unarchive_agent`, newest first: see `Receptionist.ended`. */
const MAX_ENDED = 100
/** The tools that take an agent that is no longer live. */
const ENDED_TOOLS: ReadonlySet<ToolCall['tool']> = new Set(['read', 'unarchive_agent'])
/** Said with an ended agent's transcript, in place of its cache. */
const ENDED_READ = 'This agent has ended, so it cannot be asked: answer from its transcript.'
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
  'nothing-to-fork': "that agent's Claude Code has not sent the model anything since it started — it was just restarted or resumed, or it is still on its very first reply — and a side question replays its last request, so there is nothing to ask until its next turn. Its conversation is all in its transcript: answer from that with read instead",
  timeout: 'no answer came in time',
  'api-error': 'the model request failed',
  'empty-reply': 'the agent gave no answer',
  aborted: 'the question was cut off',
  'invalid-reply': 'the answer came back garbled',
}

/** The same failures, as a toast on the user's screen says them. */
const SIDE_QUESTION_TOASTS: Record<Exclude<SideQuestionResult, { ok: true }>['reason'], string> = {
  'not-listening': 'it was started before side questions existed, and takes them after a restart',
  'nothing-to-fork': 'it has not taken a turn since it was started or resumed',
  timeout: 'no answer in time',
  'api-error': 'the model request failed',
  'empty-reply': 'it gave no answer',
  aborted: 'the question was cut off',
  'invalid-reply': 'the answer came back garbled',
}

/**
 * Speech for when nobody is listening. Never reached — nothing is delivered
 * without a listener — but the channel needs a backend, and one that refuses
 * is the safe thing to leave there.
 */
export const NO_LISTENER: SpeechBackend = {
  speak: async () => ({ status: 410, body: { error: 'no_listener' } }),
  status: async () => ({ status: 404, body: { error: 'unknown_job' } }),
  drop: async () => ({ status: 404, body: { error: 'unknown_job' } }),
}

/** Identifies a version of the instructions; a session started on another one is replaced. */
export const PROMPT_HASH = createHash('sha256').update(RECEPTIONIST_SYSTEM_PROMPT).digest('hex').slice(0, 16)
/**
 * How long a send waits after an interrupt in the same reply, so Claude Code
 * has left the turn it was in before the next prompt is typed.
 */
const INTERRUPT_SETTLE_MS = 800
/**
 * How long a watched agent must stay stopped before its stop is reported. A
 * message sent to an agent at work waits in Claude Code's queue, and the turn
 * it was sent during ends in a stop that the queued message follows within
 * milliseconds. Reported, that stop was taken for the answer: the watch was
 * used up, and the real answer went untold.
 */
export const STOP_HOLD_MS = 2_000
/**
 * How often the voice is asked where it is while a reply plays. Its change
 * feed moves a sentence at a time; only asking outright says which word.
 */
export const VOICE_FOLLOW_MS = 150
const TURN_FAILED_SPEECH = 'Sorry, I lost my train of thought. Could you say that again?'
/** Said to a model that talked when told the user is away: see `renderTurnBody`'s `away`. */
const AWAY_REFUSAL = 'NOTHING WAS DONE: the user is away, so "say" must be empty. Reply again with the same tools and an empty "say".'
/**
 * Typed into a cold agent before a side question to it: see `warmUp`. Just
 * this: the agent keeps it in its context, so anything more — an explanation,
 * a reply to coax — is tokens it carries, and words it may act on, from then on.
 */
export const WARM_UP_MESSAGE = 'stand by'
/** How long a side question waits for a cold agent to answer its wake-up. Rebuilding a big cache takes a while. */
export const WARM_UP_TIMEOUT_MS = 90_000

/** A cold agent answering its wake-up: `worked` once it started the turn, `answered` once it stopped again. */
interface Waking { worked: boolean; done(): void; answered: Promise<void> }

/** Told with the next message after the user mutes Control: see `setReading`. */
const MUTED_NOTE = 'The user has muted you: from now on your replies are shown to them as text instead of being spoken, ' +
  'and they may not read them at once. Write them as before.'
/** Told with the next message after they unmute it. */
const UNMUTED_NOTE = 'The user has unmuted you: your replies are spoken again.'
/** The user's words for a catch-up, as the transcript shows them: see `catchUp`. */
const CATCH_UP_REQUEST = "Catch me up on what I haven't read."

/** The note for a reply the user cut off and then said nothing to Control: see `resumeIfStopped`. */
const EMPTY_INTERRUPTION = "The user cut you off, but nothing they said was caught. Say in a few words that you hadn't finished, then carry on from where you were cut off."
/** The note for a turn stopped before it spoke, when the user then said nothing to Control: see `resumeIfStopped`. */
const STOPPED_FOR_NOTHING = 'The user started talking while you were working on your reply, so you stopped; nothing they said was for you. Carry on from where you stopped.'
/** Told with the next message when an answer was aborted part-way, its message kept in the session. */
const ABORTED_MID_ANSWER = 'You were stopped part-way through your last answer, because the user started talking: none of it was said, and none of its actions were done.'

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
  /** What the session before this one wrote for it, on new instructions: see `handOver`. Sent once, with the first message. */
  private handover: string | undefined
  /** The last reply spoken, so an interruption can say how much of it was heard. */
  private lastSpoken?: RenderedPart[]
  /** Where `lastSpoken` is in the record, so an interruption can mark it there too. */
  private lastSpokenAt?: number
  private events: ReceptionistEvent[] = []
  /** A self-interruption check is under way; see `maybeInterruptSelf`. */
  private judging = false
  /** The reply last judged, and how many events it was judged against: each piece of news is weighed once per reply. */
  private judgedFor: { spoken: RenderedPart[]; events: number } | undefined
  /** Control cut its own reply short for news: the next turn opens with "Hang on." and tells the model so. */
  private selfInterrupted = false
  /** Agents being watched for their next stop: `deps.watches`, which outlives the server. See `WatchKind`. */
  private readonly monitors: Watches
  /** Watched agents whose stop is being held before it is reported, each with its own hold: see `holdStop`. */
  private readonly holding = new Map<NodeId, object>()
  /**
   * Agents no longer live — their session ended, or Control archived them —
   * as they were last seen, newest last. Their transcripts outlive them, so
   * `read` and `unarchive_agent` still take them; nothing else does.
   */
  private readonly ended = new Map<NodeId, EndedAgent>()
  /** The stop each agent was last reported at (its `stateSince`), so the same stop is never reported twice. */
  private readonly reportedStops = new Map<NodeId, number | undefined>()
  /** Cold agents being woken before a side question reaches them: see `warmUp`. */
  private readonly warming = new Map<NodeId, Waking>()
  private readonly channel: SpeechChannel
  /**
   * Whether anyone can hear Control: the device holding it is connected. While
   * nobody can, turns still run — "when Alice is done, tell Bob" has to work
   * with the phone in a pocket — but must say nothing. See `setListener`.
   */
  private listening: boolean
  /** Which listener Control's words go to: see `setListener`. */
  private listenerId: string | undefined
  /** The listener muted Control: its replies are written, not spoken. See `Listener.reading`. */
  private reading = false
  /** Muting stopped a reply mid-word: the rest of it went on as text. Consumed by `noteInterruption`. */
  private mutedMidReply = false
  /** What the user has taken in of each reply, against what the model believes: see consumption.ts. */
  private readonly ledger = new ConsumptionLedger()
  /** A replay is playing: Control holds its tongue, as while the user dictates. See `replay`. */
  private replaying = false
  /** Where replays play, apart from Control's own speech, so that neither cuts the other off. Made on the first replay. */
  private replayChannel: SpeechChannel | undefined
  private readonly onSpeaker: (speaker: string | undefined) => void
  private readonly onUnread: (unread: { count: number; first?: number }) => void
  private readonly onSpeaking: (speaking: { of: number; parts: number[] } | undefined) => void
  /**
   * What the user has missed since nobody could hear: the events Control acted
   * on silently, how its last words were cut off, whether a reply went unheard.
   * Started when the listener goes, handed to `returnNews` when it comes back.
   */
  private missed: ReturnNews | undefined
  /** What the user missed, for the first turn they can hear — see `missed`. */
  private returnNews: ReturnNews | undefined
  /**
   * The user is dictating, or their words have yet to arrive: nothing may be
   * said, no action taken, and no event may start a turn. See `userSpeaking`.
   */
  private held = false
  /** The user is dictating: one of the two things `held` waits on, a replay being the other. */
  private dictating = false
  private readonly heldWaiters = new Set<() => void>()
  /**
   * What the user's talking stopped, until their words for Control arrive:
   * a reply being spoken, or a turn still working towards one. Resumed if
   * none do: see `resumeIfStopped`.
   */
  private stoppedForUser: 'speaking' | 'thinking' | undefined
  /** The user's words from a turn stopped before its message reached the session: said with the next turn. */
  private carriedWords: string | undefined
  /** Counts each time the user starts talking, so an answer can tell it was asked before they last spoke. */
  private onsets = 0
  /** Each interruption noted after the one before: see `noteInterruption`. */
  private interruptions: Promise<unknown> = Promise.resolve()
  /** The words the turn under way said while it looked things up, and how far the listener got: see `noteInterimCut`. */
  private interim: { attempt: Attempt; text: string; heard: number; ended: boolean } | undefined
  /**
   * Control went quiet with go_quiet and has not yet been told it is heard
   * again. Told with the first turn the user can hear, whatever starts it: a
   * reconnection with nothing missed starts none.
   */
  private quieted = false
  /** What backlog_next gave the latest turn, until its reply is said; see `putBack`. */
  private taken: { attempt: Attempt; items: BacklogItem[] } | undefined
  /**
   * Bumped whenever the quiet after a reply is broken: a turn starts, the user
   * starts talking, or nobody is listening any more. A pause that waited for a
   * backlog item comes to nothing if this has moved on. See `maybePull`.
   */
  private pauses = 0
  /** The pause last put to Jev, so that each is judged once. */
  private pauseJudged = -1

  private readonly onError: (message: string) => void
  /** The server is shutting down: nothing new starts. See `shutdown`. */
  private closing = false

  constructor(private readonly deps: ReceptionistDeps, opts: ReceptionistOptions) {
    this.onError = opts.onError
    this.onSpeaker = opts.onSpeaker ?? (() => undefined)
    this.onUnread = opts.onUnread ?? (() => undefined)
    this.onSpeaking = opts.onSpeaking ?? (() => undefined)
    this.ledger.restore(deps.record.tail())
    this.monitors = deps.watches
    // What the last server never got to tell the model goes with the first message.
    this.notes.push(...deps.carryOver.take())
    const saved = deps.session.load()
    // Instructions are fixed when a session starts, so a session begun on an
    // older prompt would quietly keep following it. It hands over to a new
    // one instead, first in the queue.
    this.session = saved?.promptHash === PROMPT_HASH ? saved : undefined
    if (saved && !this.session) this.queue = this.handOver(saved)
    this.listening = opts.listener !== undefined
    this.listenerId = opts.listener?.id
    this.reading = opts.listener?.reading === true
    if (!this.listening) this.missed = emptyNews()
    this.channel = new SpeechChannel({
      speech: opts.listener?.speech ?? NO_LISTENER,
      label: 'receptionist',
      onPhase: (phase) => {
        opts.onPhase(phase)
        if (phase !== 'speaking') this.onSpeaker(undefined)
        if (phase === 'ready' || phase === 'thinking') this.onSpeaking(undefined)
        if (phase !== 'ready') return
        this.deps.carryOver.speaking(false)
        if (this.closing) return
        // Background results that arrived while the receptionist was busy wait
        // for it to go quiet, then get their turn.
        this.maybeSpeakUp()
        // Nothing else wants a turn: perhaps the backlog's next item does.
        void this.maybePull()
      },
      onFailure: (failure) => opts.onError(speechFailureMessage(failure, 'the answer')),
      deps: {
        sleep: (ms) => this.deps.sleep(ms),
        voiceOperatorDiscovered: () => this.deps.voiceOperatorDiscovered(),
      },
    })
  }

  get phase(): SpeechPhase { return this.channel.phase }

  /**
   * The user said something to the receptionist, typed in the transcript or
   * spoken (`via`), which settles what they took in of everything before it:
   * see `ConsumptionLedger.settle`. The caller makes the device they said it
   * on the listener first: speaking to Control is holding it.
   */
  async hear(text: string, via: Via): Promise<void> {
    // Words for Control: what they say replaces whatever their talking stopped.
    this.stoppedForUser = undefined
    await this.runTurn({ text, via })
  }

  /**
   * The user's dictation ended with nothing for Control. `cutOff`: the device
   * cut Control's reply short itself before the dictation began, so it counts
   * as stopped by the user even though nothing was playing when they started.
   */
  heardNothing(cutOff: boolean): void {
    if (cutOff) this.stoppedForUser ??= 'speaking'
    if (!this.held) this.resumeIfStopped()
  }

  /**
   * Whether the user is talking, on any device: from the moment a dictation
   * starts until its words have been handed on, or are known to be none
   * (see dictation-presence.ts). The moment they start, whatever Control is
   * doing stops — the model mid-answer, a reply mid-sentence, actions not yet
   * taken — since what they say may change it. Until they finish nothing is
   * said, no action is taken, and no event starts a turn. Words for Control
   * then start a turn of their own; with none, what was stopped carries on.
   */
  userSpeaking(speaking: boolean): void {
    this.dictating = speaking
    if (!speaking) {
      // A replay still playing keeps Control quiet until it ends: see `setReplaying`.
      if (!this.replaying) this.release()
      return
    }
    this.onsets++
    this.pauses++
    this.held = true
    this.stopForUser()
  }

  /** The user started talking: stop whatever Control is doing, and remember what it was. */
  private stopForUser(): void {
    if (!this.channel.isProducing()) return
    const stopped = this.lastSpoken ? 'speaking' : 'thinking'
    this.stoppedForUser ??= stopped
    serverLog(`[receptionist] the user started talking: stopping a turn that was ${stopped}`)
    this.deps.log({ event: 'stopped-for-user', stopped })
    this.trace('stopped', stopped === 'speaking' ? 'Stopped mid-reply: you started talking' : 'Stopped before replying: you started talking')
    this.noteInterimCut()
    // Marked as soon as it stops, so the transcript strikes out the rest while they are still talking.
    void this.noteInterruption('user', this.channel.cancel())
  }

  private release(): void {
    if (!this.held) return
    this.held = false
    for (const resume of this.heldWaiters) resume()
    this.heldWaiters.clear()
    if (!this.resumeIfStopped()) this.maybeSpeakUp()
  }

  /**
   * The user's talking stopped Control, and then nothing they said was for
   * it — a dictation into an agent, or one that caught no words: what was
   * stopped gets a turn to carry on. Returns whether it did.
   */
  private resumeIfStopped(): boolean {
    const stopped = this.stoppedForUser
    this.stoppedForUser = undefined
    if (!stopped || this.closing) return false
    this.notes.push(stopped === 'speaking' ? EMPTY_INTERRUPTION : STOPPED_FOR_NOTHING)
    this.trace('resumed', 'Carried on: nothing you said was for Control')
    void this.runTurn(undefined)
    return true
  }

  /**
   * The user started talking over what a turn said while it looked things
   * up. The model wrote those words, so it is told how much was heard; the
   * reply's own cut-off is `noteInterruption`'s.
   */
  private noteInterimCut(): void {
    const interim = this.interim
    this.interim = undefined
    if (!interim?.attempt.isCurrent || (interim.ended && interim.heard >= interim.text.length)) return
    const heard = interim.text.slice(0, interim.heard).trim()
    this.notes.push(heard
      ? `The user cut off what you said while looking things up. They heard only: "${heard}".`
      : 'The user started talking before hearing any of what you said while looking things up.')
  }

  /**
   * Whether a turn may act: once the user is not talking, and only if the
   * turn was not stopped meanwhile. The one gate every action passes.
   */
  private async mayAct(attempt: Attempt): Promise<boolean> {
    await this.untilUserDone()
    return attempt.isCurrent
  }

  /** Resolves once the user is no longer dictating. */
  private untilUserDone(): Promise<void> {
    if (!this.held) return Promise.resolve()
    return new Promise((resolve) => this.heldWaiters.add(resolve))
  }

  /** Stop whatever the receptionist is saying or about to say. Its actions have already run. */
  cancel(): Promise<boolean> {
    return this.channel.cancel()
  }

  /**
   * The server is going. A reply being spoken is cut off where the user got
   * to and marked so in the record, as any interruption is, and what the model
   * has yet to be told is left for the next server: see carry-over.ts. Nothing
   * new starts after this, or it would take those notes with it.
   */
  async shutdown(): Promise<void> {
    this.closing = true
    await this.channel.cancel()
    // Said just ahead of how much was heard, which the note `noteInterruption` adds last says.
    if (await this.noteInterruption('lost')) this.notes.splice(-1, 0, RESTARTED_MID_REPLY)
    const consumption = this.ledger.note(true)
    if (consumption) this.notes.push(consumption)
    this.deps.carryOver.leave(this.notes)
  }

  /**
   * Where Control's words go, or undefined when nobody can hear them: no
   * device holds Control, or the one that does has gone away. `id` names the
   * listener, so that the same one handed over again is not a move.
   *
   * Going away cuts off whatever is playing, the same as being talked over,
   * but leaves a turn in progress to finish: its tools still run, and only its
   * words go unheard. Coming back gives Control one turn to tell the user what
   * they missed, if they missed anything. Moving to another device is both at
   * once: the old one is cut off, and Control picks up on the new one from
   * where it was cut.
   *
   * A listener that is `reading` has muted Control (see `setReading`).
   */
  setListener(listener: Listener | undefined): void {
    if (listener) this.setReading(listener.reading === true)
    if (!listener) {
      if (!this.listening) return
      this.listening = false
      this.pauses++
      this.listenerId = undefined
      this.channel.speech = NO_LISTENER
      this.missed = emptyNews()
      // What was heard of the reply they left in the middle of, if they did:
      // news for when they are back.
      void this.noteInterruption('lost', this.channel.silence())
      return
    }
    const from = this.listenerId
    this.listenerId = listener.id
    this.channel.speech = listener.speech
    if (this.listening) {
      if (from === listener.id) return
      // Moved. The job being cut off keeps the backend it started on, so
      // silencing reaches the old device; anything said next goes to the new.
      this.missed = { ...emptyNews(), moved: true }
      void this.noteInterruption('lost', this.channel.silence()).then(() => this.arrive())
      return
    }
    this.listening = true
    this.arrive(true)
  }

  /**
   * Muted, Control's replies are written to the listener rather than spoken:
   * the user is there, reading. A reply being spoken stops where the voice
   * got to, and the rest of it goes on as text, unread rather than lost. The
   * model is told either way, with its next message.
   */
  private setReading(reading: boolean): void {
    if (reading === this.reading) return
    this.reading = reading
    if (reading) {
      this.notes.push(MUTED_NOTE)
      if (this.channel.phase === 'speaking' || this.channel.phase === 'synthesizing') {
        this.mutedMidReply = true
        void this.noteInterruption('lost', this.channel.silence())
      }
    } else {
      this.notes.push(UNMUTED_NOTE)
    }
  }

  /** Replies with words waiting for the user. */
  unread(): { count: number; first?: number } {
    return this.ledger.unread()
  }

  /**
   * The user marked, in the transcript, that they took in what Control has
   * said since their last message up to `char` characters into part `part` of
   * the reply at `of`, and nothing after: see `ConsumptionLedger.mark`. Not
   * while Control speaks, when the voice decides; and nothing before their
   * last message, which locked it.
   */
  mark(of: number, part: number, char: number): void {
    if (this.channel.phase === 'speaking' || this.channel.phase === 'synthesizing') return
    this.changingUnread(() => {
      for (const { at, lengths } of this.ledger.mark(of, part, char) ?? []) this.deps.record.amendHeard(at, lengths)
    })
  }

  /** The user marked everything waiting for them as read. */
  readAll(): void {
    this.changingUnread(() => {
      for (const { at, part, from, to } of this.ledger.readAll()) this.deps.record.consumed(at, part, from, to, 'read')
    })
  }

  /** `told` when the model already knows, so the ledger's next note leaves it out. */
  private consume(of: number, part: number, from: number, to: number, how: ConsumedHow, told = false): void {
    this.changingUnread(() => {
      const range = this.ledger.consume(of, part, from, to, told)
      if (range) this.deps.record.consumed(of, part, range.from, range.to, how)
    })
  }

  /** The user's message at `at` in the record locks what Control said before it: see `ConsumptionLedger.settle`. */
  private settle(via: Via, at: number): void {
    this.changingUnread(() => {
      const { read, lost } = this.ledger.settle(via, at)
      for (const { at: of, part, from, to } of read) this.deps.record.consumed(of, part, from, to, 'read')
      for (const { at: of, lengths } of lost) this.deps.record.amendHeard(of, lengths)
    })
  }

  /** Runs `change` to the ledger, and says what waits for the user if that moved. */
  private changingUnread(change: () => void): void {
    const before = this.ledger.unread()
    change()
    const after = this.ledger.unread()
    if (after.count !== before.count || after.first !== before.first) this.onUnread(after)
  }

  /**
   * The user asked to be caught up on what they have not read: Control sums
   * it up, spoken, as their turn, and it all counts as taken in — they will
   * have heard what of it matters from the summary.
   */
  async catchUp(): Promise<void> {
    const parts = this.ledger.unreadParts()
    if (!parts.length) return
    this.notes.push(`The user asks to be caught up on what you wrote while they had you muted, which they have not read: ${parts.map(part => `"${part.text.replace(/\s+/g, ' ').trim()}"`).join('; ')}. ` +
      'Sum it up in a few spoken sentences: what matters, and anything waiting on them.')
    // Told: the note above is all the model needs to hear of them.
    for (const part of parts) this.consume(part.at, part.part, part.from, part.to, 'summary', true)
    await this.hear(CATCH_UP_REQUEST, 'spoken')
  }

  /**
   * Play part `part` of the reply at `of` again, as it was said, through
   * `speech` — the device that asked. Its own channel, not Control's: a
   * replay is no turn, and talking over it only stops it. While it plays,
   * Control holds anything it would say, as while the user dictates; and
   * what the user hears of it counts as taken in. `onPlaying` hears it start
   * and stop. Refused while Control is speaking, or for a reply with no
   * voices on record.
   */
  async replay(of: number, part: number, speech: SpeechBackend, onPlaying: (playing: boolean) => void): Promise<string | undefined> {
    if (this.channel.isProducing()) return 'Control is talking'
    const said = this.deps.record.spokenPart(of, part)
    if (!said) return 'That reply was recorded before replies kept their voices'
    const spoken = `${said.intro}${said.text}`
    const intro = said.intro.length
    const channel = this.replayChannel ??= new SpeechChannel({
      speech, label: '[receptionist replay]',
      onPhase: () => undefined,
      onFailure: (failure) => this.onError(speechFailureMessage(failure, 'the replay')),
      deps: { sleep: (ms) => this.deps.sleep(ms), voiceOperatorDiscovered: () => this.deps.voiceOperatorDiscovered() },
    })
    channel.speech = speech
    const attempt = channel.begin('synthesizing')
    this.setReplaying(true)
    onPlaying(true)
    let heard = 0
    const done = (): void => {
      if (heard > intro) this.consume(of, part, 0, heard - intro, 'replayed')
      this.setReplaying(false)
      onPlaying(false)
    }
    const followed = await channel.deliver(attempt, [{ text: spoken, voice: said.voice }], undefined, (progress) => {
      if (progress.kind === 'playing') heard = Math.max(heard, progress.heard)
      else {
        heard = progress.state === 'completed' ? spoken.length : Math.max(heard, progress.heard ?? 0)
        done()
      }
    })
    if (!followed) {
      channel.settle(attempt)
      done()
    }
    return undefined
  }

  /** Stop a replay, if one is playing. What was heard of it counts, as it does when it ends. */
  stopReplay(): void {
    void this.replayChannel?.silence()
  }

  private setReplaying(replaying: boolean): void {
    this.replaying = replaying
    if (replaying) {
      this.held = true
      this.pauses++
      return
    }
    if (!this.dictating) this.release()
  }

  /**
   * The listener is here: if they missed something — events, a reply cut off
   * or never spoken — that gets a turn, framed on a return as their asking
   * what they missed (see `BACK_REQUEST`). Nothing missed, nothing is said:
   * Control has nothing new to say, and having gone quiet is told with
   * whatever next gives it a turn (see `quieted`).
   *
   * The turn waits a moment: coming back by talking to Control, the user's
   * words are on their way in the same breath, and what they missed goes with
   * those words rather than in a turn ahead of them that they would cut off.
   */
  private arrive(back = false): void {
    const missed = this.missed
    this.missed = undefined
    if (missed && hasNews(missed)) {
      const news = mergeNews(this.returnNews, missed)!
      // Back is back, whatever devices they moved between before going.
      if (back) delete news.moved
      this.returnNews = news
    }
    queueMicrotask(() => this.maybeSpeakUp())
  }

  /** An agent's Claude state changed. Fires a monitor if one is waiting on it. */
  agentStateChanged(nodeId: NodeId, state: ClaudeState): void {
    const waking = this.warming.get(nodeId)
    if (waking) {
      if (!isSettled(state)) waking.worked = true
      else if (waking.worked) waking.done()
      // The reply to the wake-up is not news: a monitor waits for a real stop.
      return
    }
    const waiting = this.monitors.get(nodeId)
    if (!waiting) return
    if (!isSettled(state)) {
      // Back at work while its stop was held: that was no stop. See `STOP_HOLD_MS`.
      this.holding.delete(nodeId)
      if (waiting.kind === 'after-work') this.monitors.set(nodeId, { ...waiting, kind: 'next-stop' })
      return
    }
    if (waiting.kind === 'after-work') return
    void this.holdStop(nodeId)
  }

  /** Report a watched agent's stop once it has held for `STOP_HOLD_MS`, if it is still watched and still stopped. */
  private async holdStop(nodeId: NodeId): Promise<void> {
    const hold = {}
    this.holding.set(nodeId, hold)
    await this.deps.sleep(STOP_HOLD_MS)
    if (this.holding.get(nodeId) !== hold) return
    this.holding.delete(nodeId)
    const agent = this.deps.agents().find(candidate => candidate.nodeId === nodeId)
    if (this.monitors.get(nodeId)?.kind !== 'next-stop' || !agent || !isSettled(agent.state)) return
    this.fireMonitor(nodeId, agent.state)
  }

  /**
   * The user typed into an agent themselves, or shipped it something: they
   * have it in hand, and hear from it directly, so Control stops watching it.
   * Without this, a watch kept through silence (see `keepWatchingUntold`)
   * would wake Control at every stop of a session the user is working in.
   */
  userTookOver(nodeId: NodeId): void {
    this.holding.delete(nodeId)
    if (!this.monitors.delete(nodeId)) return
    const agents = this.deps.agents()
    if (agents.some(agent => agent.nodeId === nodeId)) {
      this.notes.push(`The user typed into ${this.token(nodeId, this.handles(agents))} themselves, so you are no longer watching it.`)
    }
    this.trace('unwatch', `Stopped watching ${this.traceToken(nodeId)}: you typed into it yourself`)
    this.deps.log({ event: 'taken-over', nodeId })
  }

  /**
   * An agent's session has exited — it ended itself, or was ended — and its
   * surface has left the live roster: into the archive, or, when it failed to
   * launch, as a dead remnant on the canvas. `agent` is how it was just before.
   *
   * A watched agent's end is news, like a stop: its state never settles on the
   * way out, so no monitor would ever fire for it. Watched or not, it is kept
   * among the ended agents, whose transcripts `read` can still reach.
   */
  agentEnded(agent: RosterAgent, archived: boolean): void {
    const nodeId = agent.nodeId
    const monitored = this.monitors.delete(nodeId)
    this.holding.delete(nodeId)
    this.reportedStops.delete(nodeId)
    const handle = this.handles([...this.deps.agents().filter(live => live.nodeId !== nodeId), agent]).of(nodeId)!
    this.remember(agent, handle)
    // A stop not yet told is the same news with less in it: the end replaces it.
    const isItsStop = (event: ReceptionistEvent) => event.kind === 'agent-stopped' && parseAgentRef(event.agent).key === handle
    const stopUntold = this.events.some(isItsStop)
    this.events = this.events.filter(event => !isItsStop(event))
    if (!monitored && !stopUntold) return
    const token = agentToken(handle, this.deps.names.get(nodeId)?.name)
    const lastSaid = agent.transcriptPath ? lastAgentProse(this.deps.readTranscript(agent.transcriptPath)) : ''
    if (monitored) this.trace('fired', `Watch fired: ${token} ended`, lastSaid)
    this.events.push({ kind: 'agent-ended', agent: token, archived, lastSaid: lastSaid.slice(-LAST_SAID_EVENT_CHARS) })
    this.maybeSpeakUp()
  }

  /** Keep an agent that is no longer live among the ended ones; see `ended`. */
  private remember(agent: RosterAgent, handle: string): void {
    this.ended.delete(agent.nodeId)
    this.ended.set(agent.nodeId, { agent, handle })
    for (const nodeId of this.ended.keys()) {
      if (this.ended.size <= MAX_ENDED) break
      this.ended.delete(nodeId)
    }
  }

  /** Watch an agent until its next stop; see `monitors`. `why` is for the transcript's reasoning. */
  private watch(nodeId: NodeId, kind: WatchKind, why: string): void {
    const agent = this.deps.agents().find(candidate => candidate.nodeId === nodeId)
    // Already at work on it: its next stop is the one.
    const atWork = agent !== undefined && !isSettled(agent.state)
    this.monitors.set(nodeId, { kind: atWork ? 'next-stop' : kind, ...(agent?.stateSince !== undefined && { since: agent.stateSince }) })
    this.trace('watch', `Watching ${this.traceToken(nodeId)} for its next stop: ${why}`)
  }

  /**
   * Pick up the watches the last server left, once this one knows which agents
   * are live and how they stand. An agent that stopped while no server was
   * looking — or in the hold before the last one went — is reported now: its
   * state will not change again, so nothing else would ever report it. One
   * that ended meanwhile is dropped; there is nothing left of it to watch.
   */
  resumeWatches(): void {
    const agents = this.deps.agents()
    for (const [nodeId, watch] of this.monitors.entries()) {
      const agent = agents.find(candidate => candidate.nodeId === nodeId)
      if (!agent) {
        this.monitors.delete(nodeId)
        this.deps.log({ event: 'watch-dropped', nodeId })
        this.trace('unwatch', `Stopped watching ${this.traceToken(nodeId)}: it was gone when the server came back`)
        continue
      }
      const settled = isSettled(agent.state)
      const stoppedSince = settled && agent.stateSince !== watch.since
      this.deps.log({ event: 'watch-resumed', nodeId, kind: watch.kind, stoppedSince })
      // At work, its next stop is the one, as `watch` has it; stopped since, that stop was it.
      if (!settled || stoppedSince) this.monitors.set(nodeId, { ...watch, kind: 'next-stop' })
      if (stoppedSince) void this.holdStop(nodeId)
    }
  }

  /**
   * Watch an agent for its next stop, from now. One already stopped at a stop
   * not yet reported — it may have answered a moment before — is reported at
   * once, not at a stop that may never come; the stop last reported is not
   * reported again.
   */
  private watchFromNow(agent: RosterAgent, why: string): 'reported' | 'watching' {
    const reported = this.reportedStops.has(agent.nodeId) && this.reportedStops.get(agent.nodeId) === agent.stateSince
    if (isSettled(agent.state) && !reported) {
      this.fireMonitor(agent.nodeId, agent.state)
      return 'reported'
    }
    this.watch(agent.nodeId, 'next-stop', why)
    return 'watching'
  }

  /**
   * A watch is used up only by telling the user. A stop this turn said nothing
   * about, in its words or on its backlog, is news the user has not had, so its
   * agent is watched again, as though the stop had not come. Left to the model,
   * it was not: Control stayed silent on a stop, the agent's real answer came
   * later, and nobody was watching for it. A watch kept this way ends when the
   * user takes the agent over (`userTookOver`), as any other does.
   */
  private keepWatchingUntold(events: readonly ReceptionistEvent[], reply: Reply): void {
    const stops = events.filter(event => event.kind === 'agent-stopped')
    if (!stops.length) return
    const agents = this.deps.agents()
    const handles = this.handles(agents)
    const tokensIn = (text: string) => [...text.matchAll(AGENT_TOKEN)].map(([, ref]) => ref)
    const refs = [
      ...reply.say.flatMap(part => [...(part.from === CONTROL ? [] : [part.from]), ...tokensIn(part.text)]),
      ...reply.tools.flatMap(call => call.tool === 'backlog_add' ? tokensIn(call.item) : []),
    ]
    const told = new Set(refs.flatMap(ref => this.resolve(ref, handles, agents) ?? []))
    for (const { nodeId } of stops) {
      const agent = agents.find(candidate => candidate.nodeId === nodeId)
      // Gone, or watched again already: by a send, or by monitor.
      if (!agent || told.has(nodeId) || this.monitors.has(nodeId)) continue
      this.deps.log({ event: 'kept-watching', nodeId, outcome: this.watchFromNow(agent, 'its stop was neither told nor set aside, so it is watched again') })
    }
  }

  /** The agent has stopped: tell the model what it last said. */
  private fireMonitor(nodeId: NodeId, state: ClaudeState): void {
    const agents = this.deps.agents()
    const agent = agents.find(candidate => candidate.nodeId === nodeId)
    this.monitors.delete(nodeId)
    this.holding.delete(nodeId)
    if (!agent) return
    this.reportedStops.set(nodeId, agent.stateSince)
    const lastSaid = agent.transcriptPath ? lastAgentProse(this.deps.readTranscript(agent.transcriptPath)) : ''
    const token = this.token(nodeId, this.handles(agents))
    this.trace('fired', `Watch fired: ${token} is now ${STATE_WORDS[state]}`)
    this.events.push({
      kind: 'agent-stopped', agent: token, nodeId, state: STATE_WORDS[state],
      lastSaid: lastSaid.slice(-LAST_SAID_EVENT_CHARS),
    })
    this.maybeSpeakUp()
  }

  private maybeSpeakUp(): void {
    if (this.held || this.closing) return
    if (this.channel.isProducing()) {
      void this.maybeInterruptSelf()
      return
    }
    if (!this.events.length && !(this.listening && this.returnNews)) return
    void this.runTurn(undefined)
  }

  /**
   * News arrived while Control is speaking a reply: ask whether it should cut
   * itself off for it (self-interruption.ts), and if so, stop the speech. The
   * channel then settles as after any cut, and the events get their turn,
   * which opens with "Hang on.". Every verdict is logged, for tuning.
   */
  private async maybeInterruptSelf(): Promise<void> {
    const spoken = this.lastSpoken
    const pending = this.events.length
    if (this.judging || !pending || !spoken || !this.listening || this.channel.phase !== 'speaking') return
    if (this.judgedFor?.spoken === spoken && this.judgedFor.events >= pending) return
    this.judging = true
    this.judgedFor = { spoken, events: pending }
    try {
      const offset = await this.channel.liveOffset()
      if (offset === undefined || this.lastSpoken !== spoken) return
      const news = [...this.events]
      const ctx: InterruptionContext = {
        speech: splitAtOffset(joinSpeechParts(spoken.map(({ text, voice }) => ({ text, voice }))), offset),
        conversation: this.recentConversation(),
        events: news.map(renderEvent),
      }
      const verdict = await decideInterruption(ctx, (c) => this.deps.judgeInterruption(c))
      serverLog(`[receptionist] self-interruption: ${verdict.reason}${'probability' in verdict ? ` ${verdict.probability.toFixed(2)}` : ''}, ${verdict.wordsLeft} words left → ${verdict.interrupt ? 'cut in' : 'carry on'}`)
      this.deps.log({
        event: 'self-interruption', ...verdict, offset,
        currentWord: ctx.speech.currentWord, remaining: ctx.speech.remaining, news: ctx.events,
      })
      // Still the same reply playing, with the news still waiting, and the user still listening and not talking.
      if (!verdict.interrupt || this.lastSpoken !== spoken || !this.events.length || !this.listening || this.held) return
      if (this.channel.phase !== 'speaking') return
      this.traceCutIn(verdict, ctx, news)
      this.selfInterrupted = true
      await this.channel.silence()
    } finally {
      this.judging = false
    }
  }

  /**
   * One turn: the user's words (or, with none, pending events), as many model
   * steps as its `read` calls need, and then speech.
   */
  private async runTurn(message: { text: string; via: Via } | undefined, pulled?: TakenItems): Promise<void> {
    this.pauses++
    const attempt = this.channel.begin('thinking')
    this.interim = undefined
    const heard = message?.text
    // Words a stopped turn never got to the session are said again, ahead of these.
    const carried = this.carriedWords
    this.carriedWords = undefined
    const words = carried === undefined ? heard : heard === undefined ? carried : `${carried} ${heard}`
    // The reply this turn supersedes will never be heard: what backlog_next
    // gave it goes back now, in time to be counted in this turn's message.
    if (this.taken && !this.taken.attempt.isCurrent) this.putBack(this.taken.items)
    // Cut short for news: say so at once, while the turn that brings it is written.
    const selfInterrupted = this.selfInterrupted
    this.selfInterrupted = false
    if (selfInterrupted && this.listening && !this.reading) await this.channel.deliverInterim(attempt, [{ text: HANG_ON, voice: RECEPTIONIST_VOICE }])
    await this.noteInterruption(selfInterrupted ? 'self' : 'user')
    // Read after that await: the listener may have come or gone during it.
    const away = !this.listening
    const events = this.events.splice(0)
    const news = away ? undefined : this.returnNews
    if (!away) this.returnNews = undefined
    const unquieted = !away && this.quieted
    if (unquieted) this.quieted = false
    const render = (said: string | undefined) => renderTurnBody(events, said, away ? 'away' : news, unquieted, this.deps.backlog.size, this.watching(), pulled?.described)
    const body = render(words)
    // With the user's words, the events are in the transcript already, as what came with them.
    if (words === undefined && (events.length || news)) {
      this.trace('events', `${events.length ? `News: ${events.map(eventHeadline).join('; ')}` : 'You were back'}${away ? ', with nobody listening' : ''}`,
        [...news ? ['What you missed while away.'] : [], ...events.map(renderEvent)].join('\n\n'))
    }
    // Backlog items this turn brings up, pulled for it or by backlog_next: put back if its reply is never heard.
    const taken: BacklogItem[] = [...pulled?.items ?? []]
    this.taken = { attempt, items: taken }
    // Taken before this message joins the record, for a session that has forgotten what led up to it.
    const earlier = this.deps.record.recent(RECAP_MESSAGES)
    // Carried words are in the record already, from the turn that first heard them.
    if (message) {
      const at = this.deps.record.append([{ role: 'user', content: carried === undefined ? body : render(message.text) }])[0]
      if (at !== undefined) this.settle(message.via, at)
    }
    let monitoring = false
    try {
      const reply = await this.converse(attempt, body, earlier, away, taken)
      if (!attempt.isCurrent) {
        this.requeue(events, news, unquieted)
        this.putBack(taken)
        return
      }
      if (!reply) return
      // Acted on where the user could not hear: theirs to be told of when they are back.
      if (away) this.missed?.events.push(...events)
      monitoring = await this.speak(attempt, body, heard === undefined ? reply : acknowledgeSends(reply), taken, events)
    } catch (err) {
      this.putBack(taken)
      // Stopped before the session got the user's words: the next turn says them.
      if (err instanceof Unsent && err.first && words !== undefined) this.carriedWords = words
      if (!attempt.isCurrent) { this.requeue(events, news, unquieted); return }
      if (err instanceof LostSession) this.forgetSession()
      const message = err instanceof Error ? err.message : String(err)
      serverLog(`[receptionist] turn failed: ${message}`)
      this.deps.log({ event: 'turn-failed', heard: heard ?? null, error: message })
      this.onError(`The receptionist could not answer: ${message}`)
      // Muted, the toast says it.
      const apologise = this.listening && !this.reading
      // Into the transcript as well as the toast: the toast is gone in seconds, and a
      // failure that repeats needs its error where it can be read afterwards.
      const [headline, ...rest] = message.split('\n')
      this.trace('failed', `${apologise ? `"${TURN_FAILED_SPEECH}" — ` : ''}could not answer: ${headline}`, rest.join('\n').trim() || undefined)
      if (apologise) monitoring = await this.channel.deliver(attempt, [{ text: TURN_FAILED_SPEECH, voice: RECEPTIONIST_VOICE }])
    } finally {
      if (!monitoring) this.channel.settle(attempt)
    }
  }

  /**
   * Give a superseded turn's events back. They were never heard, and the turn
   * that superseded this one may already be over by now — so this has to
   * offer them a turn of their own, not just wait for the next phase change.
   */
  private requeue(events: readonly ReceptionistEvent[], news: ReturnNews | undefined, unquieted: boolean): void {
    if (unquieted) this.quieted = true
    if (news) this.returnNews = mergeNews(news, this.returnNews)
    if (!events.length && !news) return
    if (events.length) {
      this.trace('requeued', `Turn dropped before a word of it was said; its news waits for the next: ${events.map(eventHeadline).join('; ')}`)
    }
    this.events.unshift(...events)
    this.maybeSpeakUp()
  }

  /**
   * The model steps of one turn. `read` results go back to the model within
   * the turn; everything else runs as soon as it is asked for. Returns the
   * final reply, or undefined if the attempt lost ownership.
   */
  private async converse(
    attempt: Attempt, body: string, earlier: readonly RecordMessage[], away: boolean, taken: BacklogItem[],
  ): Promise<Reply | undefined> {
    let message = body
    for (let step = 1; step <= MAX_STEPS; step++) {
      const answer = await this.ask(attempt, `${message}\n\n${FORMAT_REMINDER}`, step === 1 ? earlier : [], step === 1)
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
      // Asked to go quiet: nothing more is said, not even a confirmation.
      const quiet = silencedIfQuiet(reply)
      if (quiet !== reply && reply.say.length) this.deps.log({ event: 'go-quiet-dropped-words', step, say: reply.say })
      reply = quiet
      const agents = this.deps.agents()
      const handles = this.handles(agents)
      // A handle the model miscopied would send to nobody, or to the wrong
      // agent, or be spoken as "an agent". Check every one before anything
      // runs or is said, and have the model correct it.
      const problems = [...this.checkHandles(reply, handles, agents), ...this.checkNames(reply, handles, agents)]
      // Told the user is away, and talking anyway: refused like a bad handle,
      // so the model learns it rather than being quietly ignored. Out of
      // steps, its tools run and its words go unheard as any others would.
      if (away && reply.say.length) problems.unshift(AWAY_REFUSAL)
      if (problems.length && step < MAX_STEPS) {
        this.deps.log({ event: 'bad-handles', step, problems })
        message = `NOTHING WAS DONE AND NOTHING YOU SAID WAS SPOKEN. ${problems.join(' ')} Reply again with these put right.`
        continue
      }
      // Bookkeeping waits on nothing, so it is done the moment a reply is accepted.
      await this.runTools(reply.tools.filter(isBookkeeping), agents, handles)
      // An out-of-date name in front of a handle is no reason to refuse a
      // reply: the handle decides, the real name is spoken, and the model is
      // told with its next message.
      const stale = this.staleNames(reply, handles)
      if (stale.length) {
        this.deps.log({ event: 'stale-names', step, stale })
        this.notes.push(`The handle decided, so the agent's real name was used: ${stale.join('; ')}.`)
      }
      // The last step's actions, and its words, are `speak`'s.
      if (!reply.tools.some(isBlocking) || step === MAX_STEPS) return reply
      if (!await this.mayAct(attempt)) {
        this.noteUnspoken(reply)
        return undefined
      }
      // Words that came with a blocking tool are spoken now, while it runs:
      // the listener hears "let me check" instead of silence. As in any
      // reply, its actions run first, and the words report them.
      const done: string[] = []
      const actions = await this.nameTheNameless(reply.tools, lines => done.push(...lines))
      // Muted, "let me check" is not worth writing down: the answer will be.
      const spoken: SpokenPart[] = reply.say.length && this.listening && !this.reading
        ? this.render(reply.say, agents).spoken.map(({ text, voice }) => ({ text, voice }))
        : []
      await this.runActions(actions, lines => done.push(...lines))
      // Taken, the actions are the model's to hear of even if the user talks
      // over this turn before their results go back: noted at once, for
      // whichever message leaves next, and taken back if it is this turn's.
      const note = this.noteDone(done)
      if (spoken.length && !await this.speakInterim(attempt, spoken) && !attempt.isCurrent) return undefined
      const { results } = await this.runTools(reply.tools.filter(isLookup), agents, handles, undefined, taken)
      if (!attempt.isCurrent) return undefined
      if (note !== undefined && this.notes.includes(note)) this.notes.splice(this.notes.indexOf(note), 1)
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
  private ask(attempt: Attempt, prompt: string, earlier: readonly RecordMessage[], first: boolean): Promise<SessionAnswer> {
    const run = async (): Promise<SessionAnswer> => {
      // Superseded while queued: never sent, so there is nothing to answer.
      if (!attempt.isCurrent) throw new Unsent(first)
      // The time limit kills the call; the attempt's own signal aborts the
      // turn in the daemon, which answers at once, so the queue moves on and
      // the session is never left busy.
      const signal = AbortSignal.timeout(MODEL_TIMEOUT_MS)
      const session = this.session
      const sessionId = session?.sessionId
      // Notes go on whatever message leaves next, read only now: the message
      // ahead of this one in the queue may have just produced one.
      const notes = this.notes.splice(0)
      const consumption = this.ledger.note()
      if (consumption) notes.push(consumption)
      const recap = forgets(session) ? renderRecap(earlier) : undefined
      // The old session's notes go to the first message of the new one.
      const handover = sessionId ? undefined : this.handover
      const message = [
        handover !== undefined ? `${HANDOVER_HEADING}\n${handover}` : undefined,
        recap, notes.length ? `NOTE: ${notes.join(' ')}` : undefined, prompt,
      ].filter(Boolean).join('\n\n')
      try {
        const answer = await this.askWhenFree(
          { prompt: message, systemPrompt: RECEPTIONIST_SYSTEM_PROMPT, turnId: randomUUID(), ...(sessionId ? { sessionId } : {}) }, signal, attempt.signal,
        )
        if (answer.aborted && !answer.aborted.promptInSession) {
          // The session never saw this message: what it carried goes with the next.
          this.notes.unshift(...notes)
          throw new Unsent(first)
        }
        if (handover !== undefined) this.handover = undefined
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
        if (answer.aborted) {
          // Not a rewind: the session keeps the message, its answer cut short.
          this.notes.push(ABORTED_MID_ANSWER)
          this.deps.log({ event: 'model-aborted', sessionId: answer.sessionId })
        } else if (!attempt.isCurrent) {
          // Its tools never ran either: the turn is gone, so nothing will run them.
          this.noteUnspoken(replyOf(answer.text))
        }
        return answer
      } catch (err) {
        if (sessionId && !signal.aborted && !(err instanceof SessionBusy) && !(err instanceof Unsent)) throw new LostSession(err)
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
  private async askWhenFree(turn: SessionTurn, signal: AbortSignal, abort?: AbortSignal): Promise<SessionAnswer> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.deps.askModel(turn, signal, abort)
      } catch (err) {
        if (!(err instanceof SessionBusy) || signal.aborted || attempt >= BUSY_RETRIES) throw err
        await this.deps.sleep(BUSY_RETRY_MS)
        if (abort?.aborted) return { text: '', sessionId: turn.sessionId ?? '', aborted: { promptInSession: false } }
      }
    }
  }

  /**
   * New instructions mean a new session, since Claude Code keeps a session's
   * own for good. Before the old one goes, it is asked to write down what the
   * new one needs to carry on, which goes with the new one's first message
   * along with the last exchanges word for word. Without it, all the new one
   * had was those exchanges.
   *
   * Logged loudly: each one is a new session, which starts cold, so instructions
   * that changed on every start would be a cost worth noticing.
   */
  private async handOver(old: SavedSession): Promise<void> {
    serverLog(`[receptionist] NEW SESSION: Control's instructions changed (${old.promptHash} -> ${PROMPT_HASH}), so session ${old.sessionId} hands over to a new one`)
    this.deps.log({ event: 'instructions-changed', from: old.promptHash, to: PROMPT_HASH, sessionId: old.sessionId })
    try {
      const answer = await this.askWhenFree({ prompt: HANDOVER_PROMPT, sessionId: old.sessionId, retiring: true }, AbortSignal.timeout(MODEL_TIMEOUT_MS))
      this.handover = answer.text.length <= HANDOVER_CHARS ? answer.text : `${answer.text.slice(0, HANDOVER_CHARS - 1)}…`
      serverLog(`[receptionist] session ${old.sessionId} handed over ${answer.text.length} characters`)
      this.deps.log({ event: 'handover', sessionId: old.sessionId, text: answer.text, costUsd: answer.costUsd ?? null })
    } catch (err) {
      // The new session still gets the last exchanges, and recall.
      const message = err instanceof Error ? err.message : String(err)
      serverLog(`[receptionist] session ${old.sessionId} could not hand over: ${message}`)
      this.deps.log({ event: 'handover-failed', sessionId: old.sessionId, error: message })
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
    interrupted = new Set<NodeId>(), taken: BacklogItem[] = [],
  ): Promise<{ results: string[]; done: string[] }> {
    const results: string[] = []
    const done: string[] = []
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
          done.push(`force_user_camera ${call.target}: that is gone, so the camera did not move`)
          continue
        }
        this.deps.focus(nodeId)
        this.deps.log({ event: 'camera', target: call.target, nodeId })
        const agent = agents.find(candidate => candidate.nodeId === nodeId)
        done.push(`force_user_camera took the user to ${agent ? this.describe(agent, handles) : `[${parseAgentRef(call.target).key}]`}`)
        continue
      }
      if (call.tool === 'find_agent') {
        results.push(await this.findAgent(call.query, agents, handles))
        continue
      }
      if (call.tool === 'backlog_next') {
        results.push(await this.backlogNext(taken, call.about))
        continue
      }
      if (call.tool === 'backlog_add') {
        this.backlogAdd(call.item)
        continue
      }
      if (call.tool === 'go_quiet') {
        serverLog('[receptionist] go_quiet: letting go of Control')
        this.quieted = true
        this.deps.letGo()
        done.push('go_quiet disconnected you at once, saying nothing: no device holds Control, so nobody hears you')
        continue
      }
      const nodeId = this.resolve(call.agent, handles, agents)
      const ended = nodeId ? undefined : this.resolveEnded(call.agent)
      if (ended && call.tool === 'read') {
        results.push(this.read(ended.agent, agentToken(ended.handle, this.deps.names.get(ended.agent.nodeId)?.name), call.search, true))
        continue
      }
      if (ended && call.tool === 'unarchive_agent') {
        done.push(await this.unarchive(ended))
        continue
      }
      const agent = agents.find(candidate => candidate.nodeId === nodeId)
      // checkHandles already refused unknown handles; this only guards an agent
      // that vanished between the check and now.
      if (!agent) {
        results.push(`${call.tool} {${call.agent}}: that agent is gone.`)
        continue
      }
      // An agent acted on is about to be spoken of, so it is named now: the
      // confirmation should carry the name the user will hear.
      // Not one being archived: its name goes back to the pool with it. Nor one
      // being given a name: it is about to have the one Control chose.
      const naming = call.tool === 'rename_agent' && call.name !== undefined
      if (call.tool !== 'read' && call.tool !== 'archive_agent' && !naming) this.named(agent.nodeId, handles)
      const who = this.describe(agent, handles)
      switch (call.tool) {
        case 'read':
          results.push(this.read(agent, this.token(agent.nodeId, handles), call.search, false))
          break
        case 'monitor':
          done.push(this.watchFromNow(agent, 'Control called monitor') === 'reported'
            ? `monitor found ${who} already stopped; what it last said comes as an event`
            : `monitor is watching ${who}`)
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
          void this.send(agent.nodeId, call.message, interrupted.has(agent.nodeId), handles)
          done.push(`send delivered to ${who}, which is now watched for its reply`)
          break
        case 'unarchive_agent':
          done.push(`unarchive_agent: ${who} is live, not archived, so nothing changed`)
          break
        case 'rename_agent':
          done.push(this.rename(agent, call, handles))
          break
        case 'archive_agent': {
          if (this.monitors.delete(agent.nodeId)) this.trace('unwatch', `Stopped watching ${who}: archived`)
          const count = this.deps.archive(agent.nodeId)
          this.remember(agent, handles.of(agent.nodeId) ?? agent.nodeId)
          // Into the full record, so `recall` can answer "what happened to Kevin?".
          this.deps.record.append([{ role: 'assistant', content: `ARCHIVED ${who}` }])
          done.push(`archive_agent archived ${who}${count > 1 ? `, with the ${count - 1} node${count === 2 ? '' : 's'} under it` : ''}`)
          break
        }
      }
      this.deps.log({ event: 'tool', ...call, nodeId: agent.nodeId })
    }
    return { results, done }
  }

  /**
   * The read tool: an agent's transcript, recent or searched. An ended agent's
   * is read the same way, but without a cache to weigh: it cannot be asked.
   */
  /**
   * The backlog_next tool: the backlog item that matters most now, or every
   * item about what `about` describes. `taken` collects them, so that a reply
   * nobody hears puts them back.
   */
  private async backlogNext(taken: BacklogItem[], about: string | undefined): Promise<string> {
    const took = await this.takeFromBacklog(about)
    taken.push(...took.items)
    return `backlog_next: ${took.described}`
  }

  /**
   * The backlog item that matters most now, or every item about what `about`
   * describes, as Jev judges it, taken off the backlog and described for the
   * model. Every pick is logged, for checking Jev's judgement.
   */
  private async takeFromBacklog(about: string | undefined): Promise<TakenItems> {
    const items = this.deps.backlog.all()
    if (!items.length) return { items: [], described: 'the backlog is empty.' }
    const now = Date.now()
    const agents = this.deps.agents()
    const handles = this.handles(agents)
    // What waiting costs: each agent the item is about whose cache is still warm.
    const cache = (item: BacklogItem): string | undefined => (item.agents ?? []).flatMap((nodeId) => {
      const until = agents.find(agent => agent.nodeId === nodeId)?.cacheWarmUntil
      const note = until === undefined ? undefined : cacheNote(this.token(nodeId, handles), until, now)
      return note ? [note] : []
    }).join('; ') || undefined
    const ctx: BacklogContext = {
      conversation: this.recentConversation(),
      items: items.map(item => {
        const note = cache(item)
        return { text: item.text, age: ageWords(now - item.addedAt), ...(note && { cache: note }) }
      }),
      ...(about !== undefined && { about }),
    }
    const pick = await pickNext(ctx, (c) => this.deps.judgeBacklog(c))
    serverLog(`[receptionist] backlog_next${about !== undefined ? ' about' : ''}: ${pick.reason}, ` +
      `took ${pick.indices.length ? pick.indices.map(i => i + 1).join(', ') : 'none'} of ${items.length}`)
    this.deps.log({ event: 'backlog-next', ...pick, about: about ?? null, items: ctx.items })
    const waiting = (count: number): string => `${count} ${count === 1 ? 'item is' : 'items are'} still waiting`
    if (!pick.indices.length) {
      this.trace('backlog-take', pick.reason === 'judge-failed'
        ? 'Nothing taken off the backlog: it could not be searched just now'
        : `Nothing on the backlog is about ${about}`)
      const why = pick.reason === 'judge-failed' ? 'the backlog could not be searched just now' : `nothing on the backlog is about ${about}`
      return { items: [], described: `${why}, so nothing was taken off it; ${waiting(items.length)}.` }
    }
    const took = this.deps.backlog.take(pick.indices)
    if (!took.length) return { items: [], described: 'the backlog is empty.' }
    const left = this.deps.backlog.size
    this.trace('backlog-take', `Off the backlog${about !== undefined ? `, about ${about}` : ''}: ${took.map(item => item.text).join(' / ')}`,
      `${took.length} taken, ${left} left.`)
    const described = pick.indices.map(i => `${ctx.items[i].text} (set aside ${ctx.items[i].age})`)
    const them = took.length === 1 ? 'it' : 'any of them'
    return {
      items: took,
      described: `${took.length === 1 ? `${described[0]}.` : `${took.length} items:\n${described.map(text => `- ${text}`).join('\n')}\n`} ` +
        `${took.length === 1 ? 'It is' : 'They are'} off the backlog now; ${left ? waiting(left) : 'nothing else is waiting'}. ` +
        `If the user does not want ${them} now, add ${them === 'it' ? 'it' : 'those'} back with backlog_add.`,
    }
  }

  /** Whether the quiet after a reply is unbroken, so that a backlog item could come up: see `maybePull`. */
  private quietSince(pause: number): boolean {
    return pause === this.pauses && this.listening && !this.held && !this.channel.isProducing() && !this.events.length && !this.returnNews
  }

  /**
   * A reply has finished and Control is idle with something on its backlog:
   * ask Jev whether the user is ready for it (backlog-pause.ts), and bring it
   * up at once, after `PAUSE_MS` of quiet, or not this pause. Anything that
   * breaks the quiet meanwhile — the user talking, an event, any other turn —
   * moves `pauses` on, and the item stays put. Every verdict is logged, for tuning.
   */
  private async maybePull(): Promise<void> {
    const pause = this.pauses
    if (!this.deps.backlog.size || !this.quietSince(pause) || this.pauseJudged === pause) return
    this.pauseJudged = pause
    const verdict = await decidePause(this.recentConversation(), (c) => this.deps.judgePause(c))
    serverLog(`[receptionist] backlog pause: ${verdict.reason}` +
      `${verdict.reason === 'judged' ? ` now ${verdict.probabilities.now.toFixed(2)}, after pause ${verdict.probabilities.afterPause.toFixed(2)}` : ''} → ${verdict.when}`)
    this.deps.log({ event: 'backlog-pause', ...verdict })
    this.tracePause(verdict)
    if (verdict.when === 'not-yet') return
    if (verdict.when === 'after-pause') await this.deps.sleep(PAUSE_MS)
    if (!this.quietSince(pause)) return
    const pulled = await this.takeFromBacklog(undefined)
    if (!pulled.items.length) return
    // Choosing the item took a moment too.
    if (!this.quietSince(pause)) {
      this.putBack(pulled.items, 'the quiet was broken while it was being chosen')
      return
    }
    await this.runTurn(undefined, pulled)
  }

  /** Set an item aside, with the surfaces of the live agents its tokens name, so that their caches can be weighed later. */
  private backlogAdd(text: string): void {
    const live = this.deps.agents()
    const handles = this.handles(live)
    const agents = [...new Set([...text.matchAll(AGENT_TOKEN)].flatMap(([, ref]) => this.resolve(ref, handles, live) ?? []))]
    const dropped = this.deps.backlog.add(text, Date.now(), agents)
    this.deps.log({ event: 'backlog-add', item: text, agents, size: this.deps.backlog.size, dropped })
    this.trace('backlog-add', `Set aside for later: ${text}`, `${this.deps.backlog.size} on the backlog now.`)
    if (dropped.length) {
      this.trace('backlog-dropped', `Backlog full, so the oldest went: ${dropped.map(item => item.text).join(' / ')}`)
      this.notes.push(`Your backlog was full, so its oldest item was dropped: ${dropped.map(item => item.text).join('; ')}.`)
    }
  }

  /** Put back what backlog_next gave a reply nobody will hear. Empties `items`, so putting back twice is harmless. */
  private putBack(items: BacklogItem[], why = 'the reply that brought it up was never heard'): void {
    const back = items.splice(0)
    if (!back.length) return
    this.deps.backlog.restore(back)
    this.trace('backlog-back', `Back on the backlog, since ${why}: ${back.map(item => item.text).join(' / ')}`)
  }

  /** Why a pause did or did not bring up the backlog, for the transcript's reasoning. `now` brings it up, which `backlog-take` shows. */
  private tracePause(verdict: PauseVerdict): void {
    if (verdict.when === 'now') return
    if (verdict.reason === 'judge-failed') {
      this.trace('backlog-wait', 'Backlog held: could not judge whether you were ready for something new', verdict.error)
      return
    }
    const odds = `Ready now ${percent(verdict.probabilities.now)}, after ${PAUSE_MS / 1000} seconds of quiet ${percent(verdict.probabilities.afterPause)}.`
    this.trace('backlog-wait', verdict.when === 'after-pause'
      ? `Backlog waits for ${PAUSE_MS / 1000} seconds of quiet before bringing anything up`
      : 'Backlog held: you seem to be in the middle of a topic', odds)
  }

  /** The last few exchanges with the user, as Jev is shown them. */
  private recentConversation(): string {
    const conversation = this.deps.record.recent(RECAP_MESSAGES)
      .map(({ role, content }) => `${role === 'user' ? '' : 'YOU: '}${content}`).join('\n')
    return lastWords(conversation, CONVERSATION_WORDS)
  }

  private read(agent: RosterAgent, token: string, search: string | undefined, ended: boolean): string {
    // A search covers the whole session; a plain read is the recent part.
    const read = search ? this.deps.readWholeTranscript : this.deps.readTranscript
    const messages = agent.transcriptPath ? read(agent.transcriptPath) : []
    // The cache comes with the transcript: it decides whether ask_agent is worth it.
    const cache = ended
      ? `\n${ENDED_READ}`
      : (agent.cacheWarmUntil !== undefined ? `\ncache: ${cacheWords(agent, Date.now())}` : '')
        + (agent.takesSideQuestions === false ? `\n${NO_SIDE_QUESTIONS}` : '')
    return `read ${token}${search ? ` for "${search}"` : ''}:${cache}\n${readAgent(messages, search)}`
  }

  /** The unarchive_agent tool, for an agent that has ended or that Control archived. */
  private async unarchive(ended: EndedAgent): Promise<string> {
    const { agent, handle } = ended
    const was = `${agentToken(handle, this.deps.names.get(agent.nodeId)?.name)} ("${agent.title}")`
    const outcome = await this.deps.unarchive(agent.nodeId)
    this.deps.log({ event: 'tool', tool: 'unarchive_agent', nodeId: agent.nodeId, outcome })
    if (outcome === 'not-archived') {
      this.ended.delete(agent.nodeId)
      return `unarchive_agent: ${was} is not in the archive any more; the user may have restored or deleted it. Use list_agents to see whether it is live`
    }
    if (outcome === 'failed') return `unarchive_agent could not resume ${was}'s session`
    this.ended.delete(agent.nodeId)
    const live = this.deps.agents()
    const token = live.some(candidate => candidate.nodeId === agent.nodeId) ? this.token(agent.nodeId, this.handles(live)) : agentToken(handle)
    this.deps.record.append([{ role: 'assistant', content: `UNARCHIVED ${token}` }])
    return outcome === 'ready'
      ? `unarchive_agent brought back ${token} ("${agent.title}"): it is live again and ready, idle until it is sent something`
      : `unarchive_agent brought back ${token} ("${agent.title}"), but its session has not said it is ready yet, so a message sent now may be lost. Check list_agents before sending to it`
  }

  /**
   * The ended agent a reference means, newest first: by handle, or by the name
   * it still holds. Only when no live agent answers to it — see `ended`.
   */
  private resolveEnded(ref: string): EndedAgent | undefined {
    const { key, name } = parseAgentRef(ref)
    const wanted = key.toLowerCase()
    for (const ended of [...this.ended.values()].reverse()) {
      if (ended.handle === wanted) return ended
      if (name === undefined && this.deps.names.get(ended.agent.nodeId)?.name.toLowerCase() === wanted) return ended
    }
    return undefined
  }

  /** Start a new agent, and watch for its first answer as for a send. */
  private spawn(call: Extract<ToolCall, { tool: 'spawn' }>, agents: readonly RosterAgent[]): string {
    const directories = this.deps.directories()
    const directoryId = this.directoryHandles(directories).find(call.directory)
    const directory = directories.find(candidate => candidate.nodeId === directoryId)
    if (!directory) return `spawn [${call.directory}]: that directory is gone.`
    try {
      const nodeId = this.deps.spawn(directory.nodeId, call.title, call.prompt)
      // Named now, not lazily as other agents are: the result carries the
      // name, so the confirmation that follows it can introduce the agent.
      // checkNames has passed a chosen name; only one taken since then fails
      // here, and the system names the agent instead.
      const chosen = call.name && this.deps.names.setName(nodeId, call.name.name, call.name.gender)
      const named = chosen && chosen.ok ? chosen.named : this.deps.names.assign(nodeId)
      const handle = this.handles([...agents.map(agent => agent.nodeId), nodeId].map(id => ({ nodeId: id }))).of(nodeId)
      const token = agentToken(handle ?? nodeId, named?.name)
      this.deps.log({ event: 'spawned', nodeId, directory: directory.cwd, title: call.title, prompt: call.prompt, name: named?.name ?? null, chosen: call.name ?? null })
      this.deps.record.append([{ role: 'assistant', content: `STARTED ${token} in ${directory.cwd}: ${call.prompt}` }])
      // After its name: the reasoning line names it as the STARTED line does.
      this.watch(nodeId, 'after-work', 'Control started it')
      const refused = chosen && !chosen.ok ? `, not ${call.name!.name}: ${this.nameProblemWords(chosen.problem)}` : ''
      const name = named ? `. It is called ${named.name}${refused}` : ''
      return `spawn started ${token} "${call.title}" in ${directory.cwd}${name}. It is now watched for its next stop`
    } catch (err) {
      return `spawn in ${directory.cwd} failed: ${err instanceof Error ? err.message : String(err)}`
    }
  }

  /**
   * The rename_agent tool: a new title, a new name, or both. A new name of the
   * other gender comes with a new voice, which `setName` decides.
   */
  private rename(agent: RosterAgent, call: Extract<ToolCall, { tool: 'rename_agent' }>, handles: Handles): string {
    const was = this.describe(agent, handles)
    const changes: string[] = []
    if (call.name) {
      const result = this.deps.names.setName(agent.nodeId, call.name.name, call.name.gender)
      if (!result.ok) return `rename_agent did not rename ${was}: ${this.nameProblemWords(result.problem)}`
      changes.push(`named it ${result.named.name}${result.voiceChanged ? `, in a new ${result.named.gender} voice to match` : ''}`)
    }
    if (call.title) {
      this.deps.retitle(agent.nodeId, call.title)
      changes.push(`titled it "${call.title}"`)
    }
    const now = this.token(agent.nodeId, handles)
    this.deps.record.append([{ role: 'assistant', content: `RENAMED ${was}: now ${now}${call.title ? ` ("${call.title}")` : ''}` }])
    return `rename_agent ${changes.join(' and ')}: ${was} is now ${now}`
  }

  /** Why a name could not be given, as the model is told it. */
  private nameProblemWords(problem: NameProblem): string {
    switch (problem.kind) {
      case 'not-a-name':
        return 'a name is a single word of letters, such as Kevin'
      case 'reserved':
        return `${RECEPTIONIST_NAME} is your own name`
      case 'taken': {
        const live = this.deps.agents()
        const holder = live.some(agent => agent.nodeId === problem.by) ? this.token(problem.by, this.handles(live)) : problem.name
        return `that is, or sounds like, the name of ${holder}, and no two agents may sound alike`
      }
    }
  }

  /**
   * Every name a reply gives, in spawn or rename_agent, that cannot be given.
   * One sentence per problem. Checked with the handles, before anything runs
   * or is said, since the confirmation would otherwise announce a name the
   * agent never gets.
   */
  private checkNames(reply: Reply, handles: Handles, agents: readonly RosterAgent[]): string[] {
    const problems: string[] = []
    for (const call of reply.tools) {
      if ((call.tool !== 'spawn' && call.tool !== 'rename_agent') || !call.name) continue
      const nodeId = call.tool === 'rename_agent' ? this.resolve(call.agent, handles, agents) : undefined
      const problem = this.deps.names.nameProblem(nodeId, call.name.name)
      if (problem) problems.push(`"${call.name.name}" (in ${call.tool}) cannot be given: ${this.nameProblemWords(problem)}. Choose another name, or ask the user for one.`)
    }
    return problems
  }

  /**
   * Ship a message to a real agent, and watch for its answer: whoever sends
   * an agent something wants to hear back.
   */
  private async send(nodeId: NodeId, message: string, afterInterrupt: boolean, handles: Handles): Promise<void> {
    if (afterInterrupt) await this.deps.sleep(INTERRUPT_SETTLE_MS)
    this.deps.send(nodeId, message)
    this.watch(nodeId, 'after-work', 'Control sent it a message')
    // Named now if it has none: "Sent to Kevin" is about to be said anyway.
    const name = this.named(nodeId, handles)?.name ?? 'an agent'
    this.deps.log({ event: 'sent', nodeId, name, message })
    // Into the full record, so `recall` can answer "what did I tell Kevin?".
    this.deps.record.append([{ role: 'assistant', content: `SENT TO ${name}: ${message}` }])
  }

  /**
   * Ask an agent a side question, in the background: the answer comes back
   * as an event, with a toast saying what it used.
   */
  private async askAgent(agent: RosterAgent, question: string, handles: Handles): Promise<void> {
    // Named now if it has no name yet: its answer will be quoted in its voice,
    // and the toast should already call it what the listener will hear.
    const named = this.named(agent.nodeId, handles)
    const name = named?.name ?? agent.title
    const token = this.token(agent.nodeId, handles)
    const onsets = this.onsets
    await this.warmUp(agent)
    const result = await this.deps.askAgent(agent.nodeId, sideQuestionPrompt(question))
    this.deps.log({ event: 'side-question', nodeId: agent.nodeId, question, result })
    // The user has spoken since: what they said may have made the question moot.
    const stale = this.onsets !== onsets ? { beforeUserSpoke: true as const } : {}
    if (result.ok) {
      this.deps.notify(`Control asked ${name}: ${usageWords(result.usage)}`)
      this.events.push({ kind: 'agent-answer', agent: token, question, answer: result.text, ...stale })
    } else {
      serverLog(`[receptionist] side question to ${token} failed: ${result.reason}${result.detail ? ` ${result.detail}` : ''}`)
      this.deps.notify(`Control's question to ${name} failed: ${SIDE_QUESTION_TOASTS[result.reason]}`)
      this.events.push({ kind: 'agent-answer-failed', agent: token, question, reason: SIDE_QUESTION_FAILURES[result.reason], ...stale })
    }
    this.maybeSpeakUp()
  }

  /**
   * Have a stopped agent whose prompt cache has gone cold take one real turn
   * before a side question reaches it.
   *
   * A side question replays the agent's last request with the question after
   * it, through Claude Code's `$.model.fork`. Against a cold cache it pays to
   * write the whole conversation — and the entry it writes is one the agent's
   * own next request never reads: measured on two agents, each paid for its
   * conversation twice, the second time 11 seconds after the first. The fork takes no cache
   * options, so that is out of spaceterm's reach. The other way round works:
   * a fork reads what the agent's own turn cached, which is what side
   * questions were built on. So the agent caches its conversation once, and
   * the question and whatever it is sent next both read it.
   *
   * A working agent is warm, and one waiting on a prompt must not have it
   * answered by the wake-up. Gives up waiting after WARM_UP_TIMEOUT_MS and
   * asks anyway: an answer at the old price beats none.
   */
  private async warmUp(agent: RosterAgent): Promise<void> {
    const { nodeId } = agent
    const already = this.warming.get(nodeId)
    if (already) return already.answered
    if (agent.state !== 'stopped' || agent.cacheWarmUntil === undefined || agent.cacheWarmUntil > Date.now()) return
    let done!: () => void
    const answered = new Promise<void>((resolve) => { done = resolve })
    this.warming.set(nodeId, { worked: false, done, answered })
    this.deps.log({ event: 'warm-up', nodeId })
    this.deps.send(nodeId, WARM_UP_MESSAGE)
    await Promise.race([answered, this.deps.sleep(WARM_UP_TIMEOUT_MS)])
    this.warming.delete(nodeId)
    done()
  }

  /**
   * The agent's name, giving it one if it has none. Every name Control does
   * not choose itself is given here, lazily, as the agent is first spoken of
   * or acted on: by then the model has written the reply, and its last
   * list_agents still says "no name yet". So it is told, or it goes on
   * thinking the agent nameless while the user hears and sees the name, and
   * denies knowing an agent the user asks about by it.
   */
  private named(nodeId: NodeId, handles: Handles): NamedVoice | undefined {
    const existing = this.deps.names.get(nodeId)
    if (existing) return existing
    const named = this.deps.names.assign(nodeId)
    if (named) {
      const handle = handles.of(nodeId) ?? nodeId
      this.notes.push(`{${handle}}, which had no name, has been given one: it is now ${agentToken(handle, named.name)}, and the user hears and sees it as ${named.name}.`)
    }
    return named
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

  /** Whatever force_user_camera can take the user to: an agent by its token, a directory, or any node. */
  private resolveTarget(ref: string, handles: Handles, agents: readonly RosterAgent[]): NodeId | undefined {
    const { key } = parseAgentRef(ref)
    return this.resolve(ref, handles, agents)
      ?? this.directoryHandles(this.deps.directories()).find(key)
      ?? this.nodeHandles().find(key)
  }

  /**
   * The live agent a reference means. In a full token, `Kevin:amber-otter`,
   * the handle alone decides: the name is what the model last knew it as (see
   * `staleNames`). Otherwise it is a handle, or — once the agent has one — its
   * name, in any case.
   */
  private resolve(ref: string, handles: Handles, agents: readonly RosterAgent[]): NodeId | undefined {
    const { key, name } = parseAgentRef(ref)
    const byHandle = handles.find(key)
    if (byHandle || name !== undefined) return byHandle
    const byName = this.deps.names.byName(key)
    return byName && agents.some(agent => agent.nodeId === byName) ? byName : undefined
  }

  /** An agent's token, as everything the model is shown writes it: see `agent-token.ts`. */
  private token(nodeId: NodeId, handles: Handles): string {
    return agentToken(handles.of(nodeId) ?? nodeId, this.deps.names.get(nodeId)?.name)
  }

  /** An agent as a confirmation names it: its token and title, so a wrong pick shows. */
  private describe(agent: RosterAgent, handles: Handles): string {
    return `${this.token(agent.nodeId, handles)} ("${agent.title}")`
  }

  /**
   * Every agent a reply refers to, as written, and where: the tool calls that
   * take an agent (or, for the camera, anything it can go to), who each part
   * is from, and the tokens in what it says.
   */
  private agentRefs(reply: Reply): Array<{ ref: string; where: string; camera?: true; tool?: ToolCall['tool'] }> {
    const refs: Array<{ ref: string; where: string; camera?: true; tool?: ToolCall['tool'] }> = []
    for (const call of reply.tools) {
      if (call.tool === 'force_user_camera') refs.push({ ref: call.target, where: 'in force_user_camera', camera: true })
      else if ('agent' in call) refs.push({ ref: call.agent, where: `in ${call.tool}`, tool: call.tool })
    }
    for (const part of reply.say) {
      if (part.from !== CONTROL) refs.push({ ref: part.from, where: 'as who a spoken part is from' })
      for (const [, ref] of part.text.matchAll(AGENT_TOKEN)) refs.push({ ref, where: 'in what you said' })
    }
    return refs
  }

  /**
   * Tokens whose name is not the agent's — out of date, misspelled, or a name
   * it has not been given. Not a mistake worth refusing a reply over: the
   * handle picks the agent and its real name is spoken. One phrase each, with
   * the token to use instead.
   */
  private staleNames(reply: Reply, handles: Handles): string[] {
    const stale = new Set<string>()
    for (const { ref } of this.agentRefs(reply)) {
      const { key, name } = parseAgentRef(ref)
      const nodeId = name === undefined ? undefined : handles.find(key)
      if (!nodeId) continue
      const real = this.deps.names.get(nodeId)?.name
      if (real?.toLowerCase() === name!.toLowerCase()) continue
      stale.add(real
        ? `you wrote {${ref}}, but ${key} is ${this.token(nodeId, handles)}`
        : `you wrote {${ref}}, but ${key} had no name yet, so that name was not used: it is called by the name the system gives it`)
    }
    return [...stale]
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
      const { key, name: written } = parseAgentRef(ref)
      const wanted = [key, written].flatMap(word => word ? [word.toLowerCase()] : [])
      const nearNames = [...nameOf.keys()].filter(name => wanted.some(word => editDistance(word, name) <= Math.max(1, Math.floor(name.length / 3))))
      const near = [...new Set([...nearNames.map(name => nameOf.get(name)!), ...handles.nearest(key).map(h => handles.find(h)!)])]
        .slice(0, 2)
        .flatMap(nodeId => {
          const agent = byId.get(nodeId)
          return agent ? [this.describe(agent, handles)] : []
        })
      return near.length ? ` Did you mean ${near.join(' or ')}?` : ' Use list_agents or find_agent to look it up.'
    }
    for (const call of reply.tools) {
      if (call.tool !== 'spawn') continue
      const directories = this.directoryHandles(this.deps.directories())
      if (!directories.find(call.directory)) {
        const near = directories.nearest(call.directory)
        problems.push(`"${call.directory}" (in spawn) is not a directory's handle.${near.length ? ` Did you mean ${near.join(' or ')}?` : ' Use list_agents to see the directories.'}`)
      }
    }
    for (const { ref, where, camera, tool } of this.agentRefs(reply)) {
      if (camera) {
        if (!this.resolveTarget(ref, handles, agents)) {
          problems.push(`"${ref}" (${where}) is not a live agent, a directory, or a node from nearby.${suggest(ref)}`)
        }
      } else if (this.resolve(ref, handles, agents)) {
        continue
      } else if (this.resolveEnded(ref)) {
        if (!(tool && ENDED_TOOLS.has(tool))) {
          problems.push(`"${ref}" (${where}) is no longer live: only read and unarchive_agent take it. Speak of it in plain words, by its name.`)
        }
      } else {
        problems.push(`"${ref}" (${where}) is not a live agent's token, name or handle.${suggest(ref)}`)
      }
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
      return name ? [`${this.token(agent.nodeId, handles)}: ${agent.title}`] : []
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
        return [`${Math.round(hit.probability * 100)}% ${this.token(agent.nodeId, handles)}: ${agent.title} (${STATE_WORDS[agent.state]})`]
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
    spoken: RenderedPart[]; mentioned: NodeId[]; speakers: string[]
  } {
    const handles = this.handles(agents)
    const byId = new Map(agents.map(agent => [agent.nodeId, agent]))
    const mentioned: NodeId[] = []
    const resolve = (ref: string): { name: string; voice: string } | undefined => {
      const nodeId = this.resolve(ref, handles, agents)
      const agent = nodeId ? byId.get(nodeId) : undefined
      if (!agent) return undefined
      const named = this.named(agent.nodeId, handles)
      if (!named) return undefined
      if (!mentioned.includes(agent.nodeId)) mentioned.push(agent.nodeId)
      return { name: named.name, voice: named.voice }
    }
    const spoken = renderSpeech(say, resolve, RECEPTIONIST_VOICE)
    // Who each part is heard as, for the speaking indicator: as `renderSpeech` decides, Control unless it is an agent's own.
    const speakers = say.map(part => (part.from === CONTROL ? undefined : resolve(part.from)?.name) ?? RECEPTIONIST_NAME)
    for (const nodeId of mentioned) this.deps.names.touch(nodeId)
    return { spoken, mentioned, speakers }
  }

  /** The tokens of the agents being watched, for the turn's WATCHING line. */
  private watching(): string[] {
    const agents = this.deps.agents()
    const handles = this.handles(agents)
    return agents.filter(agent => this.monitors.has(agent.nodeId)).map(agent => this.token(agent.nodeId, handles))
  }

  private async speak(attempt: Attempt, body: string, reply: Reply, taken: BacklogItem[], events: readonly ReceptionistEvent[]): Promise<boolean> {
    // Never over the user. Talked over while it waited, the reply is never said.
    if (!await this.mayAct(attempt)) {
      this.noteUnspoken(reply)
      this.putBack(taken)
      return false
    }
    if (!this.listening) {
      // Gone while the reply was being written: its actions still run, and
      // its words are dropped, with the model told, as when it is talked over.
      await this.runActions(reply.tools)
      this.putBack(taken, 'nobody was listening for the reply that brought it up')
      if (reply.say.length) {
        this.notes.push('Your previous reply was never spoken: the user was away, so they heard none of it.')
        if (this.missed) this.missed.unheard = true
        this.traceUnspoken(reply.say, 'nobody was listening')
      }
      this.deps.log({ event: 'turn', body, say: reply.say, spoken: [], tools: reply.tools, away: true })
      return false
    }
    const agents = this.deps.agents()
    const actions = await this.nameTheNameless(reply.tools)
    // The camera stays where the user put it: an agent being spoken of is no
    // reason to move it. Only force_user_camera does, when they ask. Rendered
    // before the other actions run, since the words name agents as the model
    // saw them: "{Kevin} is now Ruth." says Kevin.
    const { spoken, speakers } = this.render(reply.say, agents)
    const froms = reply.say.map(part => part.from)
    // Being said: what backlog_next gave it is the user's now. Cut off, the note says to set it aside again.
    taken.splice(0)
    // Done before a word is said, and reported by the words: the user never
    // waits through "Sent to Kevin" for the send. Talking over the words
    // undoes nothing, which is why Control asks first when it is unsure.
    await this.runActions(actions)
    // Read after the actions' awaits: muting while they ran writes this reply.
    const reading = this.reading
    const at = this.deps.record.append([{
      role: 'assistant', content: storedReply(froms, spoken),
      voices: spoken.map(part => part.voice ?? RECEPTIONIST_VOICE), intros: spoken.map(part => part.text.slice(0, part.introLength)),
      ...(reading ? { delivery: 'text' as const } : {}),
    }])[0]
    if (at !== undefined && spoken.length) {
      this.ledger.delivered(at, spoken.map(part => part.text.slice(part.introLength)), reading ? 'text' : 'spoken')
      if (reading) this.onUnread(this.ledger.unread())
    }
    // After the reply, so the transcript's reasoning reads as it happened: silence, then the watch kept.
    this.keepWatchingUntold(events, reply)
    this.deps.log({ event: 'turn', body, say: reply.say, spoken, tools: reply.tools, ...(reading ? { muted: true } : {}) })
    // Muted, it is written, and that is all: there is nothing to cut off.
    if (reading) return false
    this.lastSpoken = spoken
    this.lastSpokenAt = at
    const parts = spoken.map(({ text, voice }) => ({ text, voice }))
    if (!parts.length) return false
    this.deps.carryOver.speaking(true)
    const starts = speechPartStarts(parts)
    let speaker: string | undefined
    // How far the voice has got, for the transcript: never back, as the
    // feed's sentence-level offsets would take it behind the word asked for.
    let furthest = -1
    const reached = (heard: number): void => {
      if (at === undefined || heard <= furthest || this.lastSpoken !== spoken) return
      furthest = heard
      this.onSpeaking({ of: at, parts: playedLengths(spoken, heard) })
    }
    const monitoring = await this.channel.deliver(attempt, parts, undefined, (progress) => {
      if (progress.kind !== 'playing') return
      const index = starts.filter(start => start <= progress.heard).length - 1
      const now = speakers[Math.max(0, index)]
      if (now !== speaker) this.onSpeaker(speaker = now)
      reached(progress.heard)
    })
    if (monitoring) void this.followVoice(spoken, reached)
    return monitoring
  }

  /**
   * Ask the voice where it is in `spoken` every `VOICE_FOLLOW_MS` while it
   * says it, for the transcript's lit word: the job's change feed moves only
   * a sentence at a time.
   */
  private async followVoice(spoken: RenderedPart[], reached: (heard: number) => void): Promise<void> {
    while (this.lastSpoken === spoken && this.channel.isProducing()) {
      await this.deps.voiceTick()
      const offset = await this.channel.liveOffset()
      if (offset !== undefined) reached(offset)
    }
  }

  /**
   * Run a reply's actions, in the order written, before any of its words are
   * said. `done` takes what they reached; by default the model is told with
   * its next message, enough to notice a wrong agent and retract.
   */
  private async runActions(
    calls: readonly ToolCall[],
    done: (lines: string[]) => void = (lines) => { this.noteDone(lines) },
  ): Promise<void> {
    const actions = calls.filter(isAction)
    if (!actions.length) return
    // Looked up now, not when the reply was checked: the user may have talked on for seconds since.
    const agents = this.deps.agents()
    try {
      const { done: lines } = await this.runTools(actions, agents, this.handles(agents))
      if (lines.length) done(lines)
    } catch (err) {
      serverLog(`[receptionist] actions failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /**
   * Runs the renames in `calls` that give a nameless agent its first name, and
   * returns the calls left to run. They run before the reply is rendered,
   * because rendering names every agent it speaks of: otherwise the agent
   * would first be given a name of the system's choosing, and the reply would
   * be heard in that name and its voice. An agent that has a name keeps it
   * until the reply is rendered, so "{Kevin} is now Ruth." still says Kevin.
   */
  private async nameTheNameless(
    calls: readonly ToolCall[], done?: (lines: string[]) => void,
  ): Promise<readonly ToolCall[]> {
    const agents = this.deps.agents()
    const handles = this.handles(agents)
    const naming = calls.filter(call => {
      if (call.tool !== 'rename_agent' || !call.name) return false
      const nodeId = this.resolve(call.agent, handles, agents)
      return nodeId !== undefined && !this.deps.names.get(nodeId)
    })
    if (!naming.length) return calls
    await this.runActions(naming, done)
    return calls.filter(call => !naming.includes(call))
  }

  /**
   * Say what a turn says while it looks things up, following how far the
   * listener gets, so that talking over it can say how much they heard.
   */
  private speakInterim(attempt: Attempt, spoken: SpokenPart[]): Promise<boolean> {
    const interim = { attempt, text: joinSpeechParts(spoken), heard: 0, ended: false }
    this.interim = interim
    return this.channel.deliverInterim(attempt, spoken, (progress) => {
      if (progress.kind === 'playing') interim.heard = progress.heard
      else {
        interim.ended = true
        interim.heard = progress.state === 'completed' ? interim.text.length : progress.heard ?? interim.heard
      }
    })
  }

  /** Actions taken whose results the model has not seen, for its next message. Returns the note, if any. */
  private noteDone(lines: readonly string[]): string | undefined {
    if (!lines.length) return undefined
    const note = `Your last actions: ${lines.join('; ')}.`
    this.notes.push(note)
    return note
  }

  /**
   * A reply superseded before any of it was said: the model is told none of
   * it was heard or done, and the transcript shows each action struck out.
   */
  private noteUnspoken(reply: Reply | undefined): void {
    const calls = reply?.tools ?? []
    this.notes.push(unspokenNote(calls))
    if (reply?.say.length) this.traceUnspoken(reply.say, 'you spoke over it before a word of it was said')
    const actions = calls.filter(isAction)
    if (actions.length) this.deps.record.notDone(actions.map(actionHeadline))
  }

  /**
   * Control cut its own reply short for news, for the transcript's reasoning:
   * the news, Jev's odds, and the words it dropped. What the user heard of the
   * reply is struck out on the reply itself, as for any cut.
   */
  private traceCutIn(verdict: InterruptionVerdict, ctx: InterruptionContext, news: readonly ReceptionistEvent[]): void {
    const odds = 'probability' in verdict ? `Judged ${percent(verdict.probability)} worth cutting in for` : 'Cut in'
    this.trace('cut-in', `Cut its own reply short, saying "${HANG_ON}", for news: ${news.map(eventHeadline).join('; ')}`, [
      `${odds}, with ${verdict.wordsLeft} words of the reply still to say.`,
      // The word being said when it stopped counts as heard, as `noteInterruption` has it.
      `Never said: "${ctx.speech.remaining}"`,
      ...ctx.events,
    ].join('\n\n'))
  }

  /** A reply that was written and never said, word for word, for the transcript's reasoning. */
  private traceUnspoken(say: readonly SayPart[], why: string): void {
    this.trace('unspoken', `Never spoken: ${why}`, say.map(part => `${part.from === CONTROL ? 'Control' : `{${stripBraces(part.from)}}`}: ${part.text}`).join('\n\n'))
  }

  /** Why Control did or did not speak, into the transcript: see `ReceptionistDeps.record.trace`. */
  private trace(what: ControlTraceKind, text: string, detail?: string): void {
    this.deps.record.trace({ what, text, ...(detail ? { detail } : {}) })
  }

  /** An agent's token for the reasoning, whether it is live, just started, or has ended. */
  private traceToken(nodeId: NodeId): string {
    const ended = this.ended.get(nodeId)
    const handle = ended?.handle ?? this.handles([...this.deps.agents().filter(agent => agent.nodeId !== nodeId), { nodeId }]).of(nodeId)
    return agentToken(handle ?? nodeId, this.deps.names.get(nodeId)?.name)
  }

  /**
   * If the last reply was cut off, tell the model how much of it the user
   * heard: the session keeps the whole reply, and the next answer must not
   * build on words nobody heard. `cause`: the user talked over it, Control cut
   * in on itself, or it was `lost` — the user left, moved, or muted it, or the
   * server went down — so what they missed waits for them rather than being
   * struck out: see `ConsumptionLedger.settle`.
   */
  private noteInterruption(cause: 'user' | 'self' | 'lost', stopping?: Promise<unknown>): Promise<boolean> {
    // One at a time, each after what stopped the speech: noted while a stop is
    // still dropping the job, the cut would be lost along with the reply.
    const noted = this.interruptions.then(async () => {
      await stopping
      return this.takeInterruption(cause)
    })
    this.interruptions = noted.catch(() => undefined)
    return noted
  }

  private async takeInterruption(cause: 'user' | 'self' | 'lost'): Promise<boolean> {
    const heard = await this.channel.heardPrefix()
    const spoken = this.lastSpoken
    const spokenAt = this.lastSpokenAt
    this.lastSpoken = undefined
    this.lastSpokenAt = undefined
    const muted = this.mutedMidReply
    this.mutedMidReply = false
    if (heard === undefined || !spoken) return false
    if (spokenAt !== undefined) {
      const lengths = heardLengths(spoken, heard)
      const waiting = cause === 'lost' || muted
      this.deps.record.amendHeard(spokenAt, lengths, waiting)
      this.ledger.heard(spokenAt, lengths, waiting)
      if (waiting) this.onUnread(this.ledger.unread())
    }
    const kept = redactSpoken(spoken, heard)
    const audible = kept.map(part => part.text).join(' ')
    if (muted) {
      this.notes.push(`The user muted you partway through your last reply. They heard only: "${audible}". The rest is shown to them as text, which they may not have read yet; do not assume they know it.`)
      return true
    }
    if (cause === 'self') {
      this.notes.push(`You stopped your own last reply to bring the news below, and have just said "${HANG_ON}". The user heard only: "${audible}". Give the news first; say again only what of the rest still stands and matters.`)
      return true
    }
    // Talked over, held back while they dictated, or lost with the phone's page: either way, only this much was heard.
    this.notes.push(cutOffNote(audible === INTERRUPTED_MARKER ? undefined : audible))
    // Cut off by leaving, or by moving: said again when they are back, since
    // the note above may go with a turn they cannot hear.
    if (this.missed) this.missed.cutOff = audible
    return true
  }
}

function emptyNews(): ReturnNews {
  return { events: [], unheard: false }
}

/** Whether there is anything to tell: a move with nothing cut off is not news. */
function hasNews(news: ReturnNews): boolean {
  return news.events.length > 0 || news.cutOff !== undefined || news.unheard
}

/** Two absences' news as one, `earlier` first. */
function mergeNews(earlier: ReturnNews | undefined, later: ReturnNews | undefined): ReturnNews | undefined {
  if (!earlier || !later) return earlier ?? later
  const cutOff = earlier.cutOff ?? later.cutOff
  return {
    events: [...earlier.events, ...later.events],
    unheard: earlier.unheard || later.unheard,
    ...(cutOff !== undefined ? { cutOff } : {}),
    ...(earlier.moved || later.moved ? { moved: true } : {}),
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

/**
 * Actions that never ran, told plainly enough for the model to take them
 * again if it still should: each exactly as it wrote it.
 */
function notDoneNote(calls: readonly ToolCall[], why: string): string {
  return `NOT DONE: ${why}, so ${calls.length === 1 ? 'this action was' : 'these actions were'} not carried out: ` +
    `${calls.map(showToolCall).join('; ')}. Take ${calls.length === 1 ? 'it' : 'any of them'} again only if the user still wants it.`
}

/** A raw reply, or undefined if it cannot be read. */
function replyOf(raw: string): Reply | undefined {
  try {
    return parseReply(raw)
  } catch {
    return undefined
  }
}

/** One event as a line of the transcript's reasoning: who, and what became of them. */
function eventHeadline(event: ReceptionistEvent): string {
  switch (event.kind) {
    case 'agent-stopped': return `${event.agent} is now ${event.state}`
    case 'agent-ended': return `${event.agent} ended`
    case 'agent-answer': return `${event.agent} answered "${event.question}"`
    case 'agent-answer-failed': return `asking ${event.agent} failed`
  }
}

function percent(probability: number): string {
  return `${Math.round(probability * 100)}%`
}

/**
 * A reply the user did not hear to the end. Their words may have been said
 * before the part they missed was played — Voice Operator holds a reply back
 * while they dictate — so nothing they say answers a question in that part.
 */
function cutOffNote(audible: string | undefined): string {
  const heard = audible
    ? `Your last reply was cut off before the user heard all of it. They heard only: "${audible}". They did not hear the rest.`
    : 'Your last reply was never heard: the user started talking before any of it was played.'
  return `${heard} What they say next does not answer anything in what they did not hear: a question there is still unasked. ` +
    'Respond to what they said first; then, if what they missed still matters, tell them, or add it to your backlog if it would pull them off the topic. ' +
    'If you act on what they did not hear, say so when you report it.'
}

/** A reply the user spoke over before any of it was said: unheard, and none of its actions done. */
function unspokenNote(calls: readonly ToolCall[]): string {
  const actions = calls.filter(isAction)
  return 'Your previous reply was never spoken: the user spoke over it, so they heard none of it.' +
    (actions.length ? ` ${notDoneNote(actions, 'none of it was said')}` : '')
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

/**
 * A message that never reached the session: its turn was stopped while it
 * waited, or aborted before the daemon sent it. `first` when it was the
 * turn's first, which carries the user's words.
 */
class Unsent extends Error {
  constructor(readonly first: boolean) {
    super('stopped before it was sent')
  }
}

/** A session that failed to answer, as against a turn that was cancelled. */
class LostSession extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause))
  }
}
