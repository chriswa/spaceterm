import { createHash, randomUUID } from 'crypto'
import { ROOT_NODE_ID, type NodeId } from '../../shared/ids'
import type { ClaudeState, NodeData } from '../../shared/state'
import { serverLog } from '../server-log'
import { finalAgentMessage, lastAgentProse, type TranscriptMessage } from '../agent-transcript'
import { INTERRUPTED_MARKER } from '../unheard'
import { joinSpeechParts, speechPartStarts, type SpeechBackend } from '../voice-operator'
import { SpeechChannel, speechFailureMessage, type Attempt, type SpeechPhase } from '../speech-channel'
import { ConsumptionLedger, type ConsumedHow, type Via } from './consumption'
import type { DeferredRead, DeferredReads } from './deferred-reads'
import type { NamedVoice, VoiceGender } from './name-voice-table'
import { RECEPTIONIST_NAME, RECEPTIONIST_VOICE } from './name-voice-table'
import type { NameProblem } from './name-registry'
import { editDistance, Handles, NODE_PREFIX } from './handles'
import { describeNode, isGenerated, pathWords, renderNodeList, type NodeListContext, type NodeListShow } from './node-list'
import { AGENT_TOKEN, agentToken, parseAgentRef, stripBraces } from './agent-token'
import { whereWords, type NearbyNode } from './nearby'
import { NOTHING_PENDING, sameStatus, statusOf, statusToTell, type SpacetermStatus, type StatusSample } from './spaceterm-status'
import type { CameraBounds, ControlImage, ControlTrace, ControlTraceKind, ControlTranscriptEntry } from '../../shared/protocol'
import type { SideQuestionResult, SideQuestionUsage } from '../side-questions'
import type { EndedAnswer } from '../ended-side-question'
import {
  FORMAT_REMINDER, HANDOVER_CHARS, IMAGE_CAPTION_CHARS, IMAGE_CAPTIONS_TOLD, HANDOVER_HEADING, HANDOVER_PROMPT, mergeNews, RECEPTIONIST_SYSTEM_PROMPT, renderEvent, renderTurnBody, type ReceptionistEvent, type ReturnNews,
} from './prompt'
import {
  CONVERSATION_WORDS, decideInterruption, HANG_ON, lastWords, splitAtOffset, type InterruptionContext, type InterruptionVerdict,
} from './self-interruption'
import {
  actionHeadline, CONTROL, heardLengths, isAction, playedLengths, isBlocking, isBookkeeping, isLookup, parseReply, redactSpoken, renderSpeech, showToolCall, letsGo,
  type LetGoTool, type Reply, type SayPart, type SpokenPart, type ToolCall,
} from './reply'
import { ageWords, cacheNote, pickNext, type Backlog, type BacklogContext, type BacklogItem } from './backlog'
import { decidePause, INTERRUPTION_QUIET_MS, PAUSE_WAIT_MS, pauseDialogue, type PauseJudgement, type PauseVerdict } from './backlog-pause'
import type { Watches, WatchKind } from './watches'
import { FORGOTTEN_MS, type BackBurner } from './back-burner'
import type { EndedAgent, EndedAgents } from './ended-agents'
import type { Asking, PendingNews } from './pending-news'
import { RESTARTED_MID_REPLY, type CarryOver } from './carry-over'
import { compactionTrace, type Compaction } from './compaction'
import {
  cacheWords, capMessage, endedAskable, endedCacheWords, NO_SIDE_QUESTIONS, readAgent, renderAgentDetails, renderRoster, STATE_WORDS, type RosterAgent,
} from './roster'

/**
 * Control: one voice conversation about every live agent.
 *
 * A conversation about every surface at once, which is what lets "what's
 * Kevin up to?" mean anything.
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
  /** The model's context window, when the daemon said. */
  contextWindow?: number
  source?: string
  wallMs?: number
  costUsd?: number
  /**
   * When the daemon compacts the session next (epoch ms): a moment ago, for a
   * compaction this turn started; an hour on, for the one it scheduled.
   */
  compactsAt?: number
  /** A compaction that finished, or failed, since the session's last answer: the daemon tells only the message after it. */
  compaction?: Compaction
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
  /** The Spaceterm status the session was last told; absent, it was told none. See spaceterm-status.ts. */
  toldStatus?: SpacetermStatus
}

/** Jev's ranking of the agents against a description. */
export interface AgentRanking {
  hits: Array<{ nodeId: NodeId; probability: number }>
  noneProbability: number
}

type RecordMessage = { role: 'user' | 'assistant'; content: string }

/**
 * A message as it goes into the record. A reply also keeps how it reached the
 * user — `delivery: 'text'` when written to a muted device — and each part's
 * voice, so that it can be replayed as it was said.
 */
export type RecordedMessage = RecordMessage & { delivery?: 'text'; voices?: string[] }


export interface ReceptionistDeps {
  /**
   * Jev's probability that Control should cut its own reply short for news
   * that arrived while it was speaking: see self-interruption.ts.
   */
  judgeInterruption(ctx: InterruptionContext): Promise<number>
  /** Things Control set aside to bring up with the user later: see backlog.ts. */
  backlog: Pick<Backlog, 'size' | 'ready' | 'all' | 'add' | 'heard' | 'take' | 'restore' | 'settle' | 'held' | 'hold'>
  /** The agents being watched for their next stop, kept across server restarts: see watches.ts. */
  watches: Watches
  /** Agents mark_read asked for, waiting on the user's answer, kept across server restarts: see deferred-reads.ts. */
  deferredReads: DeferredReads
  /** Agents the user took out of Control's hands to work with directly: see back-burner.ts. */
  backBurner: BackBurner
  /** The agents known to have ended, kept across server restarts: see ended-agents.ts. */
  ended: EndedAgents
  /** News not yet told to Control, kept across server restarts: see pending-news.ts. */
  news: PendingNews
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
  /** The transcript's recent window (`readTranscript` in agent-transcript.ts). */
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
    spokenPart(of: number, part: number): { intro: string; text: string; voice: string; from: string } | undefined
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
    /**
     * Pictures an agent showed the user: for the transcript view alone, which
     * draws them. Never shown to the model, which is told of them with an
     * `agent-images` event instead. `from` is the agent's token.
     */
    images(from: string, images: ControlImage[], summary?: string): void
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
   * Ask an agent that has ended a side question, from its prompt cache, without
   * bringing it back: see `ended-side-question.ts`. Only worth it while that
   * cache is warm. Always resolves.
   */
  askEnded(agent: RosterAgent, prompt: string): Promise<EndedAnswer>
  /**
   * Move the camera to a node, on the device holding Control. Only ever because the user
   * asked to be taken there: see the force_user_camera tool.
   */
  focus(nodeId: NodeId): void
  /** Every live node on the canvas: for list_nodes, for the handles nodes go by, and for where an agent sits. */
  nodes(): NodeData[]
  /** The root's default working directory, which a node with no directory above it hands on. */
  rootCwd(): string | undefined
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
  /** Mark an agent read, as the user's own click on its unread badge does: see deferred-reads.ts. */
  markRead(nodeId: NodeId): void
  /**
   * Let go of Control, exactly as the Control button does when it lets go:
   * no device holds it, every button shows it, and nobody hears it. See restart_server and refresh_clients.
   */
  letGo(): void
  /** Restart the server gracefully, as the ↻ button does. Returns why it cannot, if it cannot. */
  restartServer(): string | undefined
  /** Have every connected client reload its page, as the toolbar's reload does. */
  reloadPages(): void
  /**
   * What the user is looking at: the screen of the device holding Control
   * (or, failing that, the one that last moved), and the nodes nearest
   * its middle. Undefined when no screen has reported where it is.
   */
  userView(): { view: CameraBounds; nodes: NearbyNode[] } | undefined
  /**
   * Start a new Claude surface under a directory or title node, in the working
   * directory it inherits. Returns its node and that directory.
   */
  spawn(parentNodeId: NodeId, title: string, prompt: string): { nodeId: NodeId; cwd?: string }
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
  /** What Spaceterm is waiting on the user to do, sampled as each message leaves: see spaceterm-status.ts. */
  spacetermStatus(): StatusSample
}

/** Backlog items taken off for one turn, and how the model is told of them. */
interface TakenItems {
  items: BacklogItem[]
  described: string
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
/** The tools that take an agent that is no longer live. */
const ENDED_TOOLS: ReadonlySet<ToolCall['tool']> = new Set(['read', 'ask_agent', 'unarchive_agent'])
/** Agents `find_agent` reports, best first. */
const FIND_AGENT_RESULTS = 10

/** What each kind of node is, said plainly. */
const NODE_WORDS: Record<NearbyNode['type'], string> = {
  terminal: 'a terminal',
  markdown: 'a note',
  title: 'a title',
  directory: 'a directory',
  file: 'a file',
  automation: 'an automation',
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
  'resume-failed': "its ended session could not be resumed to ask it. Answer from its transcript with read instead",
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
  'resume-failed': 'its ended session could not be resumed',
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

const isRestart = (call: ToolCall): boolean => call.tool === 'restart_server'

/**
 * `calls` with restart_server moved to the end, whatever order the model
 * wrote them in: the restart takes this process down, and with it any tool
 * of the turn that has not run yet.
 */
function restartLast(calls: readonly ToolCall[]): ToolCall[] {
  return [...calls.filter(call => !isRestart(call)), ...calls.filter(isRestart)]
}
/**
 * How long a watched agent must stay stopped before its stop is reported. A
 * message sent to an agent at work waits in Claude Code's queue, and the turn
 * it was sent during ends in a stop that the queued message follows within
 * milliseconds. Reported, that stop was taken for the answer: the watch was
 * used up, and the real answer went untold.
 */
export const STOP_HOLD_MS = 2_000
/**
 * How long a watched agent must sit in a tentative stop before it is reported:
 * see `holdTentativeStop`. Longer than `STOP_HOLD_MS`, because a background
 * shell's completion or a monitor's ping often wakes the agent within seconds.
 */
export const TENTATIVE_STOP_HOLD_MS = 5_000
/** What a tentative stop is told as: the agent "is now …". */
export const TENTATIVE_STOP_WORDS = 'possibly done: it ended its turn with a final message, but shells or monitors it started in the background ' +
  'are still running and may wake it again. Judge from its last words whether it is finished or waiting on that work'
/** Characters of what a forgotten agent last said that its backlog item keeps: see `forgetLater`. */
const FORGOTTEN_LAST_SAID_CHARS = 300
/** Told when the user takes an agent over: see `userTookOver`. */
const BACK_BURNER_NOTE = 'They are working with it directly: say nothing more of it unless they ask. ' +
  'If it then sits stopped without them for a while, it comes onto your backlog, to bring up once they are back with you.'
/**
 * How often the voice is asked where it is while a reply plays. Its change
 * feed moves a sentence at a time; only asking outright says which word.
 */
export const VOICE_FOLLOW_MS = 150
/** How long a cut waits for the voice to say where interim words stopped, before going by the last it heard. */
export const INTERIM_CUT_WAIT_MS = 1500
const TURN_FAILED_SPEECH = 'Sorry, I lost my train of thought. Could you say that again?'
/** How many servers may ask one side question before it is given up on: see `resumeQuestions`. */
export const MAX_QUESTION_TRIES = 3
/**
 * How many times what a failed turn carried — the user's words, its news — is
 * tried again before it is given up on: see `retryLater`. An API error is
 * usually gone within a minute or two; one that is not is about the message.
 */
export const MAX_TURN_RETRIES = 3
/** The wait before the first retry; each one after waits twice as long as the last. */
export const TURN_RETRY_MS = 15_000
/** Told to Control with the user's words when the turn that first had them failed. */
export const RETRYING_AFTER_ERROR = 'Your last turn failed with an error before you could answer, so what the user said is given to you again below. ' +
  'If it is already in the conversation above, answer it once.'
/** Told to Control with the user's words when the last server stopped before it answered them. */
export const RESTARTED_BEFORE_ANSWER = 'The server restarted before you answered what the user last said, so it is given to you again below. ' +
  'If you already answered it, do not repeat yourself: carry on from your answer.'
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

/** The note for a reply the user cut off and then said nothing to Control: see `resumeIfStopped`. */
const EMPTY_INTERRUPTION = "The user cut you off, but nothing they said was caught. Say in a few words that you hadn't finished, then carry on from where you were cut off."
/** The note for a turn stopped before it spoke, when the user then said nothing to Control: see `resumeIfStopped`. */
const STOPPED_FOR_NOTHING = 'The user started talking while you were working on your reply, so you stopped; nothing they said was for you. Carry on from where you stopped.'
/** The note for a turn stopped before it spoke so that what waited unread could be read aloud: see `readAloud`. */
const READ_TO_MID_TURN = 'The user had their unread replies read aloud to them while you were working on your reply, so you stopped. Carry on from where you stopped.'
/** Told with the next message after "let me turn this off" or "Control, shutdown": see `sentAway`. */
const SENT_AWAY = 'The user said a fixed phrase that sends you away ("let me turn this off" or "Control, shutdown"), handled without you: someone near them needs their attention, ' +
  'so they sent you away, as choosing Off does, until they next say "Control". It was not a request for you to act on.'
/** Told instead when the phrase stopped a turn: see `resumeIfStopped`. */
const SENT_AWAY_MID_TURN = `${SENT_AWAY} It stopped you; carry on from where you stopped, away.`
/** What a turn stopped for the user is told as it carries on, by what stopped: see `resumeIfStopped`. */
const RESUME_NOTES = { 'speaking': EMPTY_INTERRUPTION, 'thinking': STOPPED_FOR_NOTHING, 'sent-away': SENT_AWAY_MID_TURN, 'read-to': READ_TO_MID_TURN } as const
/** What the transcript's activity log says of it. */
const RESUME_TRACES = {
  'speaking': 'Carried on: nothing you said was for Control',
  'thinking': 'Carried on: nothing you said was for Control',
  'sent-away': 'Carried on, away: you sent Control away',
  'read-to': 'Carried on: the reading aloud is over',
} as const
/** Told with the next message when an answer was aborted part-way, its message kept in the session. */
const ABORTED_MID_ANSWER = 'You were stopped part-way through answering the message just before this one, because the user started talking: none of that answer was said, and none of its actions were done. ' +
  'What you said before that message is not affected.'

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

/** A reply, or some of it, as read out again: see `Receptionist.readOut`. */
interface Reading {
  /** Where the reply is in the record. */
  at: number
  /** The reply's parts' lengths. */
  lengths: number[]
  /** The part the first piece is of; each piece after is of the part after. */
  first: number
  /** Where in its part each piece starts. */
  starts: number[]
  /** How long the introduction ahead of each piece is. */
  intros: number[]
  pieces: SpokenPart[]
  /** Who says each piece, by name. */
  speakers: string[]
}

export class Receptionist {
  private session: SavedSession | undefined
  /** Model calls go one at a time: a session takes one message after another. */
  private queue: Promise<unknown> = Promise.resolve()
  /** Told to the model with the next message: what became of its last reply. */
  private notes: string[] = []
  /** What the session before this one wrote for it, on new instructions: see `handOver`. Sent once, with the first message. */
  private handover: string | undefined
  /** The compaction last shown in the transcript (its `compactsAt`), so a message sent again does not show it twice. */
  private compactionShown?: number
  /** The last reply spoken, so an interruption can say how much of it was heard. */
  private lastSpoken?: SpokenPart[]
  /** Where `lastSpoken` is in the record, so an interruption can mark it there too. */
  private lastSpokenAt?: number
  /** News waiting for a turn: `deps.news`, which outlives the server. */
  private readonly events: PendingNews
  /** A self-interruption check is under way; see `maybeInterruptSelf`. */
  private judging = false
  /** The reply last judged, and how many events it was judged against: each piece of news is weighed once per reply. */
  private judgedFor: { spoken: SpokenPart[]; events: number } | undefined
  /** Control cut its own reply short for news: the next turn opens with "Hang on." and tells the model so. */
  private selfInterrupted = false
  /** Agents being watched for their next stop: `deps.watches`, which outlives the server. See `WatchKind`. */
  private readonly monitors: Watches
  /** Watched agents whose stop is being held before it is reported, each with its own hold: see `holdStop`. */
  private readonly holding = new Map<NodeId, object>()
  /** Agents the user is working with directly: `deps.backBurner`, which outlives the server. See `userTookOver`. */
  private readonly burner: BackBurner
  /** Settled agents on the back burner, each with its own wait to be counted forgotten: see `forgetLater`. */
  private readonly forgetting = new Map<NodeId, object>()
  /**
   * Agents no longer live — their session ended, or Control archived them —
   * as they were last seen, newest last. Their transcripts outlive them, so
   * `read`, `ask_agent` and `unarchive_agent` still take them; nothing else
   * does. `deps.ended`, which outlives the server.
   */
  private readonly ended: EndedAgents
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
  /** Agents told of, marked read once the user answers having heard it all: see deferred-reads.ts. */
  private readonly reads: DeferredReads
  /** What mark_read asked for this turn, until its reply is written: see `stageReads`. */
  private staged: { attempt: Attempt; reads: DeferredRead[] } | undefined
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
   * none do: see `resumeIfStopped`. `sent-away`: either, and then the user
   * sent Control away (see `sentAway`). `read-to`: a turn working towards a
   * reply, stopped for what waited unread to be read aloud (see
   * `readAloud`), and resumed once the reading ends.
   */
  private stoppedForUser: 'speaking' | 'thinking' | 'sent-away' | 'read-to' | undefined
  /**
   * The user's words from a turn stopped before its message reached the
   * session, or that failed, or that the last server left: said with the
   * next turn's first message, whenever that leaves. See `ask`.
   */
  private carried: Carried | undefined
  /** Turns failed in a row, which sets how long the next retry waits: see `retryLater`. */
  private failedTurns = 0
  /** Bumped by each retry scheduled; while one is pending, news waits for it rather than starting a turn. */
  private retries = 0
  private backingOff = false
  /** Counts each time the user starts talking, so an answer can tell it was asked before they last spoke. */
  private onsets = 0
  /** Each interruption noted after the one before: see `noteInterruption`. */
  private interruptions: Promise<unknown> = Promise.resolve()
  /** The words the turn under way said while it looked things up, and how far the listener got: see `noteInterimCut`. */
  private interim: {
    attempt: Attempt; spoken: SpokenPart[]; at?: number; text: string; heard: number; ended: boolean
    /** Resolves once the voice says where these words ended — at the end, or where a cut stopped them. */
    over: Promise<void>
  } | undefined
  /**
   * Control was let go of by restart_server or refresh_clients and has not yet been told it is heard
   * again. Told with the first turn the user can hear, whatever starts it: a
   * reconnection with nothing missed starts none.
   */
  private letGoUntold = false
  /**
   * Control has been told the user is away — a turn's `AWAY`, or `sentAway` —
   * and not yet told otherwise. The first turn the user can hear opens with
   * `LISTENING_AGAIN`, unless news of their return says so already: coming
   * back with nothing missed starts no turn of its own, and the model, left
   * with "away" as the last word, stayed silent to the next question.
   */
  private awayTold = false
  /**
   * Sends not yet handed to the agent's terminal: one after an interrupt
   * waits for the Escape to settle first. restart_server waits for them, or
   * the message would go down with the server.
   */
  private sending = new Set<Promise<void>>()
  /** What backlog_next gave the latest turn, until its reply is said; see `putBack`. */
  private taken: { attempt: Attempt; items: BacklogItem[] } | undefined
  /**
   * A reply that brought up backlog items has been said, and the user has not
   * spoken since: what Control sets aside when they next do is their answer to
   * it, and waits for them (`BacklogItem.waitsForUser`).
   */
  private broughtUp = false
  /**
   * Bumped whenever the quiet after a reply is broken: a turn starts, the user
   * starts talking, or nobody is listening any more. A pause that waited for a
   * backlog item comes to nothing if this has moved on. See `maybePull`.
   */
  private pauses = 0
  /** The pause last put to Jev, so that each is judged once. */
  private pauseJudged = -1
  /** When the user last cut Control off to talk: nothing comes up from the backlog for a while after. See `maybePull`. */
  private interruptedAt: number | undefined
  /** The user caught up on what waited unread while Control was held: the backlog may come up once it is released. See `caughtUp`. */
  private pullOnRelease = false

  private readonly onError: (message: string) => void
  /** `opts.onPhase`: Control's phase, or a reading's while Control is idle. */
  private readonly reportPhase: (phase: SpeechPhase) => void
  /** The server is shutting down: nothing new starts. See `shutdown`. */
  private closing = false

  constructor(private readonly deps: ReceptionistDeps, opts: ReceptionistOptions) {
    this.onError = opts.onError
    this.reportPhase = opts.onPhase
    this.onSpeaker = opts.onSpeaker ?? (() => undefined)
    this.onUnread = opts.onUnread ?? (() => undefined)
    this.onSpeaking = opts.onSpeaking ?? (() => undefined)
    this.ledger.restore(deps.record.tail())
    this.monitors = deps.watches
    this.reads = deps.deferredReads
    this.burner = deps.backBurner
    this.ended = deps.ended
    this.events = deps.news
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
    // What the user said that the last server never answered: the next turn says it again.
    const left = deps.news.takeLeftWords()
    if (left !== undefined) {
      this.carried = { words: left, failures: 0, unsent: [] }
      this.notes.push(RESTARTED_BEFORE_ANSWER)
    }
    // What they missed while away is still theirs to hear: waiting for them, or for the turn that tells them.
    const away = deps.news.awayNews()
    this.returnNews = away.returnNews
    if (this.listening) this.returnNews = mergeNews(this.returnNews, away.missed)
    else this.missed = away.missed ?? emptyNews()
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

  /** Control's own channel's phase, or, while that is idle, a reading's: see `replayOn`. */
  get phase(): SpeechPhase {
    return this.channel.isProducing() || !this.replayChannel ? this.channel.phase : this.replayChannel.phase
  }

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
   * The user said or sent a phrase that sends Control away — "let me turn
   * this off", "Control, shutdown" (control-shutdown.ts): the
   * caller has let go of Control, and the model is told why rather than given
   * the words. Whatever the user's talking stopped carries on, away — its
   * actions still taken, its words for when they are back — as it would after
   * a dictation with nothing for Control. `cutOff` as for `heardNothing`.
   */
  sentAway(cutOff: boolean): void {
    this.awayTold = true
    if (cutOff || this.stoppedForUser) this.stoppedForUser = 'sent-away'
    else this.notes.push(SENT_AWAY)
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
    void this.stopForUser('talking')
  }

  /**
   * The user started talking, or asked for what waits unread to be read
   * aloud: stop whatever Control is doing, and remember what it was. Its
   * caller holds Control first, so the turn resumed for it waits for the
   * user to be done. Resolves once the voice has stopped.
   */
  private stopForUser(why: 'talking' | 'reading'): Promise<boolean> {
    if (!this.channel.isProducing()) return Promise.resolve(false)
    const stopped = this.lastSpoken ? 'speaking' : 'thinking'
    this.stoppedForUser ??= why === 'reading' && stopped === 'thinking' ? 'read-to' : stopped
    this.interruptedAt = Date.now()
    const because = why === 'talking' ? 'you started talking' : 'you asked for what waited to be read aloud'
    serverLog(`[receptionist] ${why === 'talking' ? 'the user started talking' : 'reading aloud'}: stopping a turn that was ${stopped}`)
    this.deps.log({ event: 'stopped-for-user', stopped, ...(why === 'reading' ? { for: 'reading' } : {}) })
    this.trace('stopped', stopped === 'speaking' ? `Stopped mid-reply: ${because}` : `Stopped before replying: ${because}`)
    return this.cutOffByUser()
  }

  /**
   * Stop the voice where the user cut in, and mark at once what they heard of
   * it — the interim words and the reply both — so the transcript strikes out
   * the rest while they are still talking, rather than when their words
   * arrive. Every way the user stops Control comes through here: talking over
   * it, and the phone's stop ahead of a dictation (`cancel`). Returns whether
   * there was anything to stop. `heardUntil`: see `SpeechChannel.cancel`.
   */
  private cutOffByUser(heardUntil?: number): Promise<boolean> {
    void this.noteInterimCut()
    const stopping = this.channel.cancel(heardUntil)
    void this.noteInterruption('user', stopping)
    return stopping
  }

  private release(): void {
    if (!this.held) return
    this.held = false
    for (const resume of this.heldWaiters) resume()
    this.heldWaiters.clear()
    if (!this.resumeIfStopped()) this.maybeSpeakUp()
    if (this.pullOnRelease) {
      this.pullOnRelease = false
      void this.maybePull()
    }
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
    this.notes.push(RESUME_NOTES[stopped])
    this.trace('resumed', RESUME_TRACES[stopped])
    void this.runTurn(undefined)
    return true
  }

  /**
   * The user started talking over what a turn said while it looked things
   * up. The model wrote those words, so it is told how much was heard; the
   * reply's own cut-off is `noteInterruption`'s.
   */
  private async noteInterimCut(): Promise<void> {
    const interim = this.interim
    this.interim = undefined
    if (!interim?.attempt.isCurrent || (interim.ended && interim.heard >= interim.text.length)) return
    // Where the stop that follows this landed, word by word (`SpeechChannel.dropInterim`), rather than the
    // last sentence the voice was heard to start or finish. Not long: the voice is local.
    await Promise.race([interim.over, this.deps.sleep(INTERIM_CUT_WAIT_MS)])
    // Struck out in the transcript as a reply's cut-off is.
    if (interim.at !== undefined) {
      const lengths = heardLengths(interim.spoken, interim.heard)
      this.deps.record.amendHeard(interim.at, lengths)
      this.ledger.heard(interim.at, lengths)
    }
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

  /**
   * Stop whatever the receptionist is saying or about to say: the user cut it
   * off, by a tap or by talking over it hands-free, before the dictation that
   * follows. Its actions have already run. A reading shows as Control
   * speaking, so this stops one too. `heardUntil`: when the user began
   * talking over it, if before now — see `SpeechChannel.cancel`.
   */
  cancel(heardUntil?: number): Promise<boolean> {
    void this.replayChannel?.silence()
    return this.cutOffByUser(heardUntil)
  }

  /**
   * The server is going. A reply being spoken is cut off where the user got
   * to and marked so in the record, as any interruption is, and what the model
   * has yet to be told is left for the next server: see carry-over.ts. Nothing
   * new starts after this, or it would take those notes with it.
   */
  async shutdown(restarting = false): Promise<void> {
    this.closing = true
    this.trace('server', restarting ? 'Server shutting down to restart' : 'Server shutting down')
    await this.channel.cancel()
    // Said just ahead of how much was heard, which the note `noteInterruption` adds last says.
    if (await this.noteInterruption('lost')) this.notes.splice(-1, 0, RESTARTED_MID_REPLY)
    // Cut or not, how much of the last reply was heard is on record: what it told waits on the user's answer alone.
    this.reads.heardOut()
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
      this.keepAway()
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
      this.keepAway()
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
   * The transcript's Hold backlog: held, nothing comes up from the backlog on
   * its own (`maybePull`), though items still go on and the user can still
   * ask for them. Let go, the quiet Control is in counts as a pause, as it
   * would after a reply.
   */
  holdBacklog(held: boolean): void {
    if (held === this.deps.backlog.held) return
    this.deps.backlog.hold(held)
    this.deps.log({ event: 'backlog-hold', held })
    this.trace('backlog-wait', held
      ? 'Backlog held: nothing on it comes up until you let it go.'
      : 'Backlog let go: what is on it comes up at the next pause.')
    if (!held) void this.maybePull()
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

  /**
   * The user's message at `at` in the record locks what Control said before
   * it: see `ConsumptionLedger.settle`. Not caught up for the backlog: the
   * message has a turn of its own, and the pause after its reply is the one.
   */
  private settle(via: Via, at: number): void {
    this.changingUnread(() => {
      const { read, lost } = this.ledger.settle(via, at)
      for (const { at: of, part, from, to } of read) this.deps.record.consumed(of, part, from, to, 'read')
      for (const { at: of, lengths } of lost) this.deps.record.amendHeard(of, lengths)
    }, false)
    const { done, dropped } = this.reads.settle(at, (replyAt, read) => this.ledger.whole(replyAt, read.parts))
    this.markRead(done)
    this.traceDropped(dropped, false)
  }

  /**
   * mark_read's agents, taken down when a step of `attempt` is accepted, for
   * the reply that ends the turn: see `speak`. A turn superseded before it
   * says anything leaves them behind with it.
   */
  private stageReads(attempt: Attempt, calls: readonly ToolCall[], agents: readonly RosterAgent[], handles: Handles): void {
    if (this.staged?.attempt !== attempt) this.staged = { attempt, reads: [] }
    for (const call of calls) {
      if (call.tool !== 'mark_read') continue
      const agent = agents.find(candidate => candidate.nodeId === this.resolve(call.agent, handles, agents))
      if (!agent || this.staged.reads.some(read => read.nodeId === agent.nodeId)) continue
      this.staged.reads.push({ nodeId: agent.nodeId, ...(agent.stateSince !== undefined ? { stateSince: agent.stateSince } : {}) })
    }
  }

  private takeStaged(attempt: Attempt): DeferredRead[] {
    if (this.staged?.attempt !== attempt) return []
    const { reads } = this.staged
    this.staged = undefined
    return reads
  }

  /**
   * The user answered, having heard all of what told them of these agents:
   * each is marked read, unless it has moved on since — stopped again, or
   * gone back to work — and so has news they have not heard.
   */
  private markRead(reads: readonly DeferredRead[]): void {
    if (!reads.length) return
    const agents = this.deps.agents()
    const marked: DeferredRead[] = []
    const movedOn: DeferredRead[] = []
    for (const read of reads) {
      const agent = agents.find(candidate => candidate.nodeId === read.nodeId)
      if (!agent?.unread || marked.some(done => done.nodeId === read.nodeId)) continue
      if (agent.stateSince !== read.stateSince) {
        movedOn.push(read)
        continue
      }
      this.deps.markRead(read.nodeId)
      marked.push(read)
    }
    for (const [ownWords, reads] of byOwnWords(marked)) {
      this.traceReads(reads, `marked read: you answered after hearing all ${ownWords ? 'it said in its own voice' : 'of what told you of it'}`)
    }
    if (movedOn.length) this.traceReads(movedOn, 'left unread: it has news since what you heard')
  }

  /**
   * Reads left unread, as the reply that told of them was `cut` off, or the
   * user answered without taking in what the cut had left them to.
   */
  private traceDropped(reads: readonly DeferredRead[], cut: boolean): void {
    for (const [ownWords, some] of byOwnWords(reads)) {
      this.traceReads(some, `left unread: ${cut
        ? ownWords ? 'the reply was cut off before you had heard all it said in its own voice' : 'the reply that told you of it was cut off'
        : ownWords ? 'you had not taken in all it said in its own voice' : 'you had not taken in all of what told you of it'}`)
    }
  }

  /** What became of mark_read, for the transcript's activity log and the log. */
  private traceReads(reads: readonly DeferredRead[], what: string): void {
    const tokens = reads.map(read => this.traceToken(read.nodeId))
    this.trace('mark-read', `${tokens.join(', ')} ${what}`)
    this.deps.log({ event: 'mark-read', nodeIds: reads.map(read => read.nodeId), what })
  }

  /**
   * Runs `change` to the ledger, and says what waits for the user if that
   * moved. Nothing left waiting, after something was, is the user caught up
   * (`caughtUp`), unless `catchingUp` is false.
   */
  private changingUnread(change: () => void, catchingUp = true): void {
    const before = this.ledger.unread()
    change()
    const after = this.ledger.unread()
    if (after.count !== before.count || after.first !== before.first) this.onUnread(after)
    if (catchingUp && before.count && !after.count) this.caughtUp()
  }

  /**
   * The user has read, or heard, all that waited for them. Quiet while it
   * waited was not the user done with a topic, only not there yet, so the
   * backlog held (`quietSince`); the quiet that counts starts now.
   */
  private caughtUp(): void {
    this.pauses++
    if (this.held) this.pullOnRelease = true
    else void this.maybePull()
  }

  /**
   * Play part `part` of the reply at `of` again, as it was said, through
   * `speech` — the device that asked. Its own channel, not Control's: a
   * replay is no turn, though it shows as Control speaking does (`readOut`).
   * While it plays, Control holds anything it would say, as while the user
   * dictates; and what the user hears of it counts as taken in. `onPlaying`
   * hears it start and stop. Refused while Control is busy (`busy`), or for
   * a reply with no voices on record.
   */
  async replay(of: number, part: number, speech: SpeechBackend, onPlaying: (playing: boolean) => void): Promise<string | undefined> {
    const busy = this.busy()
    if (busy) return busy
    const reading = this.readingOf(of, part, 0, part)
    if (!reading) return 'That reply was recorded before replies kept their voices'
    const channel = this.replayOn(speech)
    this.setReplaying(true)
    onPlaying(true)
    try {
      const { heard } = await this.readOut(channel, reading)
      if (heard > reading.intros[0]) this.consume(of, part, 0, heard - reading.intros[0], 'replayed')
    } finally {
      this.setReplaying(false)
      onPlaying(false)
    }
    return undefined
  }

  /**
   * Read what waits unread for the user out to them, through `speech` — the
   * device that asked — in the voices it was written in: oldest reply first,
   * each from its first word waiting. Nothing goes to Control: like a replay
   * it is no turn, plays on the replay channel, holds Control while it plays,
   * and shows as Control speaking does (`readOut`). All of it counts as taken
   * in at once, so the Unread line goes as it starts; the transcript lights
   * each word as it is said instead.
   *
   * Asked for while Control thinks — as it does straight after a restart or
   * the phone's return, catching the user up — the reading wins: the turn is
   * stopped as the user's talking stops one, and carries on once the
   * reading ends. Refused while Control is saying something (`busy`).
   */
  async readAloud(speech: SpeechBackend): Promise<string | undefined> {
    const thinking = this.channel.phase === 'thinking'
    const busy = thinking ? undefined : this.busy()
    if (busy) return busy
    const firsts = new Map<number, { part: number; from: number }>()
    for (const { at, part, from } of this.ledger.unreadParts()) if (!firsts.has(at)) firsts.set(at, { part, from })
    const readings = [...firsts].flatMap(([at, first]) => this.readingOf(at, first.part, first.from) ?? [])
    if (!readings.length) return undefined
    const channel = this.replayOn(speech)
    // Held before it counts as taken in, so the backlog waits for the reading to end: see `caughtUp`.
    this.setReplaying(true)
    try {
      for (const part of this.ledger.unreadParts()) this.consume(part.at, part.part, part.from, part.to, 'aloud')
      // Held first, so the turn stopped here waits for the reading before it carries on.
      if (thinking) await this.stopForUser('reading')
      for (const reading of readings) {
        if (!(await this.readOut(channel, reading)).completed) break
      }
    } finally {
      this.setReplaying(false)
    }
    return undefined
  }

  /**
   * Why a replay or a reading cannot start now, if it cannot: Control's own
   * turn is under way. Thinking counts as much as talking, since a turn may
   * speak at any moment of it — though a reading stops a turn that is only
   * thinking instead (`readAloud`). The transcript hides Read aloud while
   * Control speaks, so for a reading this is said only when the two cross.
   */
  private busy(): string | undefined {
    if (!this.channel.isProducing()) return undefined
    return this.channel.phase === 'thinking' ? 'Control is thinking' : 'Control is talking'
  }

  /**
   * The reply at `at` as read out again, from character `from` of part
   * `first` through part `last` (by default its last): a part read from its
   * start introduced as it was when said. Undefined for a reply recorded
   * before replies kept their voices.
   */
  private readingOf(at: number, first: number, from: number, last = Infinity): Reading | undefined {
    const said: Array<NonNullable<ReturnType<ReceptionistDeps['record']['spokenPart']>>> = []
    for (let part = 0, one; (one = this.deps.record.spokenPart(at, part)); part++) said.push(one)
    if (said.length <= first) return undefined
    const read = said.slice(first, last + 1).map((part, i) => {
      const start = i === 0 ? from : 0
      const intro = start === 0 ? part.intro : ''
      return { start, intro: intro.length, piece: { text: `${intro}${part.text.slice(start)}`, voice: part.voice }, speaker: this.speakerOf(part.from) }
    })
    return {
      at, first, lengths: said.map(part => part.text.length),
      starts: read.map(r => r.start), intros: read.map(r => r.intro), pieces: read.map(r => r.piece), speakers: read.map(r => r.speaker),
    }
  }

  /** Who said a recorded part, by name, as `render` names whoever says each part. */
  private speakerOf(from: string): string {
    if (from === CONTROL) return RECEPTIONIST_NAME
    const agents = this.deps.agents()
    const nodeId = this.resolve(from, this.handles(agents), agents)
    return (nodeId && this.deps.names.get(nodeId)?.name) || parseAgentRef(from).name || RECEPTIONIST_NAME
  }

  /**
   * Say `reading` through `channel`, shown just as Control speaking is: the
   * transcript lights each word as it is said, asking the voice where it is
   * as `followVoice` does, the status names who is speaking, and the phase is
   * Control's own (`replayOn`). Resolves whether it was said to the end, so
   * the next may follow, and how far into its pieces the voice got.
   */
  private async readOut(channel: SpeechChannel, reading: Reading): Promise<{ completed: boolean; heard: number }> {
    const total = joinSpeechParts(reading.pieces).length
    const starts = speechPartStarts(reading.pieces)
    let heard = 0
    let speaker: string | undefined
    const reached = (at: number): void => {
      const played = playedLengths(reading.pieces, at)
      this.onSpeaking({
        of: reading.at,
        parts: reading.lengths.map((length, part) => {
          const i = part - reading.first
          return i < 0 || i >= reading.pieces.length ? length : reading.starts[i] + Math.max(0, played[i] - reading.intros[i])
        }),
      })
    }
    reached(0)
    const attempt = channel.begin('synthesizing')
    let ended: (completed: boolean) => void = () => {}
    const end = new Promise<boolean>((resolve) => { ended = resolve })
    const followed = await channel.deliver(attempt, reading.pieces, undefined, (progress) => {
      if (progress.kind === 'playing') {
        heard = Math.max(heard, progress.heard)
        reached(progress.heard)
        const now = reading.speakers[Math.max(0, starts.filter(start => start <= progress.heard).length - 1)]
        if (now !== speaker) this.onSpeaker(speaker = now)
        return
      }
      heard = progress.state === 'completed' ? total : Math.max(heard, progress.heard ?? 0)
      ended(progress.state === 'completed')
    })
    if (!followed) {
      channel.settle(attempt)
      return { completed: false, heard }
    }
    void (async () => {
      while (attempt.isCurrent && channel.isProducing()) {
        await this.deps.voiceTick()
        const offset = await channel.liveOffset()
        if (offset !== undefined && attempt.isCurrent) reached(offset)
      }
      // Another reading took the channel, which ends this without a word to `onProgress`.
      ended(false)
    })()
    const completed = await end
    return { completed, heard }
  }

  /**
   * The channel replays and reading aloud play on, through `speech`, the
   * device that asked. Its phase is shown as Control's — busy, speaking, who
   * speaks — so that being read to looks as being spoken to does: see `phase`.
   */
  private replayOn(speech: SpeechBackend): SpeechChannel {
    const channel = this.replayChannel ??= new SpeechChannel({
      speech, label: '[receptionist replay]',
      onPhase: (phase) => {
        // Control's own voice is shown first; a reading never starts over it.
        if (this.channel.isProducing()) return
        this.reportPhase(phase)
        if (phase !== 'speaking') this.onSpeaker(undefined)
        if (phase === 'ready') this.onSpeaking(undefined)
      },
      onFailure: (failure) => this.onError(speechFailureMessage(failure, 'the replay')),
      deps: { sleep: (ms) => this.deps.sleep(ms), voiceOperatorDiscovered: () => this.deps.voiceOperatorDiscovered() },
    })
    channel.speech = speech
    return channel
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
   * Control has nothing new to say, and being heard again is told with
   * whatever next gives it a turn (see `letGoUntold`).
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
    this.keepAway()
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
    if (this.burner.takenAt(nodeId) !== undefined) {
      if (isSettled(state)) void this.forgetLater(nodeId)
      else this.forgetting.delete(nodeId)
    }
    const waiting = this.monitors.get(nodeId)
    if (!waiting) return
    if (!isSettled(state)) {
      // Back at work while its stop was held: that was no stop. See `STOP_HOLD_MS`.
      this.holding.delete(nodeId)
      if (waiting.kind === 'after-work') this.monitors.set(nodeId, { ...waiting, kind: 'next-stop' })
      else if (state === 'working_background') void this.holdTentativeStop(nodeId)
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
   * A watched agent ended its turn with nothing but shells or monitors still
   * running: it may be done and only leaving a listener up, or waiting on that
   * work for a result. Its state stays "waiting on a background task", which
   * a watch never fires on, so Control is told of it as a possible finish once
   * it has held for `TENTATIVE_STOP_HOLD_MS`, and only if the agent's last act
   * was a final message rather than a tool call.
   *
   * Once per stretch in that state: the hold starts only on the way into it.
   * Told, the watch is used up as by any stop; passed over in silence, it is
   * kept (`keepWatchingUntold`) for the agent's real stop.
   */
  private async holdTentativeStop(nodeId: NodeId): Promise<void> {
    const hold = {}
    this.holding.set(nodeId, hold)
    await this.deps.sleep(TENTATIVE_STOP_HOLD_MS)
    if (this.holding.get(nodeId) !== hold) return
    this.holding.delete(nodeId)
    const agent = this.deps.agents().find(candidate => candidate.nodeId === nodeId)
    if (this.monitors.get(nodeId)?.kind !== 'next-stop' || agent?.state !== 'working_background' || !agent.openEndedWorkOnly) return
    if (!agent.transcriptPath || !finalAgentMessage(this.deps.readTranscript(agent.transcriptPath))) return
    this.fireMonitor(nodeId, agent.state, TENTATIVE_STOP_WORDS)
  }

  /**
   * The user typed into an agent themselves, or shipped it something: they
   * have it in hand, and hear from it directly, so Control stops watching it.
   * Without this, a watch kept through silence (see `keepWatchingUntold`)
   * would wake Control at every stop of a session the user is working in.
   *
   * One Control had in hand — watched, or watched until recently — goes on
   * the back burner rather than out of mind: it comes onto the backlog if it
   * then sits settled without the user (see `forgetLater`), so that coming
   * back to Control brings it up. Typing into it again starts that wait over.
   */
  userTookOver(nodeId: NodeId): void {
    this.holding.delete(nodeId)
    this.forgetting.delete(nodeId)
    const watched = this.monitors.delete(nodeId)
    if (!watched && this.burner.takenAt(nodeId) === undefined && !this.burner.wasRecent(nodeId)) return
    const already = this.burner.put(nodeId)
    const agents = this.deps.agents()
    const agent = agents.find(candidate => candidate.nodeId === nodeId)
    // Typed into it with nothing to start it working, it is settled already: the wait starts now.
    if (agent && isSettled(agent.state)) void this.forgetLater(nodeId)
    if (already) return
    if (agent) {
      const token = this.token(nodeId, this.handles(agents))
      this.notes.push(`${watched ? `The user typed into ${token} themselves, so you are no longer watching it.` : `The user typed into ${token} themselves.`} ${BACK_BURNER_NOTE}`)
    }
    this.trace('unwatch', watched
      ? `Stopped watching ${this.traceToken(nodeId)}: you typed into it yourself, so it is on the back burner`
      : `${this.traceToken(nodeId)} is on the back burner: you typed into it yourself`)
    this.deps.log({ event: 'taken-over', nodeId, watched })
  }

  /**
   * An agent on the back burner has settled: if it stays that way for
   * `FORGOTTEN_MS` from when it settled or the user last typed into it,
   * whichever came later, the user has likely forgotten it, and it goes on
   * the backlog — not said, since the user may be working elsewhere without
   * Control, but brought up at the next pause when they are back with it.
   * Brought up once: it is then off the back burner.
   */
  private async forgetLater(nodeId: NodeId): Promise<void> {
    const wait = {}
    this.forgetting.set(nodeId, wait)
    const takenAt = this.burner.takenAt(nodeId)
    const agent = this.deps.agents().find(candidate => candidate.nodeId === nodeId)
    if (takenAt === undefined || !agent || !isSettled(agent.state)) return
    const from = Math.max(agent.stateSince ?? takenAt, takenAt)
    await this.deps.sleep(Math.max(0, from + FORGOTTEN_MS - Date.now()))
    if (this.forgetting.get(nodeId) !== wait || this.closing) return
    this.forgetting.delete(nodeId)
    const agents = this.deps.agents()
    const now = agents.find(candidate => candidate.nodeId === nodeId)
    if (!now || !isSettled(now.state) || this.burner.takenAt(nodeId) !== takenAt) return
    this.burner.remove(nodeId)
    const lastSaid = now.transcriptPath ? lastAgentProse(this.deps.readTranscript(now.transcriptPath)) : ''
    const quoted = lastSaid.replace(/\s+/g, ' ').trim().slice(-FORGOTTEN_LAST_SAID_CHARS)
    this.deps.log({ event: 'back-burner-forgotten', nodeId })
    this.backlogAdd(`${this.token(nodeId, this.handles(agents))} may have been forgotten: the user took it over to work with it directly, ` +
      `then it sat ${Math.round(FORGOTTEN_MS / 60_000)} minutes with nothing more from them, ${STATE_WORDS[now.state]}` +
      `${now.unread ? ', and they had not looked at it since' : ''}.${quoted ? ` It last said: "${quoted}"` : ''}`)
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
    // Ended while the user had it in hand: theirs to know of, not news.
    this.burner.remove(nodeId)
    this.forgetting.delete(nodeId)
    const handle = this.handles([...this.deps.agents().filter(live => live.nodeId !== nodeId), agent]).of(nodeId)!
    this.remember(agent, handle)
    // A stop not yet told is the same news with less in it: the end replaces it.
    const isItsStop = (event: ReceptionistEvent) => event.kind === 'agent-stopped' && parseAgentRef(event.agent).key === handle
    const stopUntold = this.events.some(isItsStop)
    this.events.drop(isItsStop)
    if (!monitored && !stopUntold) return
    const token = agentToken(handle, this.deps.names.get(nodeId)?.name)
    const lastSaid = agent.transcriptPath ? lastAgentProse(this.deps.readTranscript(agent.transcriptPath)) : ''
    if (monitored) this.trace('fired', `Watch fired: ${token} ended`, lastSaid)
    const { claudeSessionId, cwd, cacheWarmUntil, cacheWarmTokens } = agent
    const cache = { claudeSessionId, cwd, cacheWarmUntil, cacheWarmTokens }
    this.events.push({ kind: 'agent-ended', agent: token, archived, lastSaid: capMessage(lastSaid), cache })
    this.maybeSpeakUp()
  }

  /** Keep an agent that is no longer live among the ended ones; see `ended`. */
  private remember(agent: RosterAgent, handle: string): void {
    this.ended.remember({ agent, handle })
  }

  /** Watch an agent until its next stop; see `monitors`. `why` is for the transcript's activity log. */
  private watch(nodeId: NodeId, kind: WatchKind, why: string): void {
    const agent = this.deps.agents().find(candidate => candidate.nodeId === nodeId)
    // Already at work on it: its next stop is the one.
    const atWork = agent !== undefined && !isSettled(agent.state)
    this.monitors.set(nodeId, { kind: atWork ? 'next-stop' : kind, ...(agent?.stateSince !== undefined && { since: agent.stateSince }) })
    // Back in Control's hands, if it was on the back burner.
    this.burner.involve(nodeId)
    this.forgetting.delete(nodeId)
    this.trace('watch', `Watching ${this.traceToken(nodeId)} for its next stop: ${why}`)
  }

  /** This server is up, for the transcript's activity log: the other end of `shutdown`'s line. */
  serverStarted(): void {
    this.trace('server', 'Server started')
  }

  /**
   * Pick up the watches and the untold news the last server left, once this one knows which agents
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
    for (const [nodeId] of this.burner.entries()) {
      const agent = agents.find(candidate => candidate.nodeId === nodeId)
      if (!agent) this.burner.remove(nodeId)
      else if (isSettled(agent.state)) void this.forgetLater(nodeId)
    }
    this.resumeQuestions()
    // What the last server never got to tell, or to answer.
    this.maybeSpeakUp()
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
   * about, in its words or on its backlog, is news the user has not had.
   *
   * Came with the user's words, the reply was theirs, and the stop was passed
   * over rather than judged: while the agent is still at that stop, it is news
   * again, for a turn of its own once this one is over. Watched for its next
   * stop instead, an agent waiting on the user was never heard of again: it
   * would not stop again until the user acted, and they had not been told.
   *
   * Came alone, the silence was Control's judgement of it, so the agent is
   * watched again, as though the stop had not come. Left to the model, it was
   * not: Control stayed silent on a stop, the agent's real answer came later,
   * and nobody was watching for it. A watch kept this way ends when the user
   * takes the agent over (`userTookOver`), as any other does.
   */
  private keepWatchingUntold(events: readonly ReceptionistEvent[], reply: Reply, withWords: boolean): void {
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
    for (const stop of stops) {
      const { nodeId } = stop
      const agent = agents.find(candidate => candidate.nodeId === nodeId)
      // Gone, or watched again already: by a send, or by monitor.
      if (!agent || told.has(nodeId) || this.monitors.has(nodeId)) continue
      const sameStop = isSettled(agent.state) && this.reportedStops.get(nodeId) === agent.stateSince
      if (withWords && sameStop) {
        this.events.push(stop)
        this.deps.log({ event: 'kept-untold', nodeId })
        this.trace('requeued', `Said nothing of ${this.traceToken(nodeId)}'s stop while answering you, and it is still waiting on you: it is news again, for the next turn`)
        continue
      }
      this.deps.log({ event: 'kept-watching', nodeId, outcome: this.watchFromNow(agent, 'its stop was neither told nor set aside, so it is watched again') })
    }
  }

  /**
   * An agent showed the user pictures: into the transcript for the user, and
   * to the model as news of how many and what they are called — never the
   * pictures, which it has no use for and which would sit in its context for
   * as long as the session lasts.
   */
  showImages(nodeId: NodeId, images: ControlImage[], summary?: string): void {
    if (!images.length) return
    const token = this.traceToken(nodeId)
    this.deps.record.images(token, images, summary)
    const captions = [summary, ...images.map(image => image.caption)]
      .flatMap(caption => caption?.replace(/\s+/g, ' ').trim() || [])
      .slice(0, IMAGE_CAPTIONS_TOLD)
      .map(caption => caption.length > IMAGE_CAPTION_CHARS ? `${caption.slice(0, IMAGE_CAPTION_CHARS - 1)}…` : caption)
    this.events.push({ kind: 'agent-images', agent: token, count: images.length, captions })
    this.maybeSpeakUp()
  }

  /** What a tool that lets go of Control does once it has, and the line saying so. */
  private letGoFor(tool: LetGoTool): string {
    const unheard = 'no device holds Control, so nobody hears you'
    switch (tool) {
      case 'restart_server': {
        const refused = this.deps.restartServer()
        this.deps.log({ event: 'restart-server', ...(refused ? { refused } : {}) })
        // Into the record, so the transcript shows the restart as the action it was, and `recall` finds it.
        this.deps.record.append([{ role: 'assistant', content: refused ? `RESTART REFUSED: ${refused}` : actionHeadline({ tool }) }])
        return refused ? `restart_server did not restart the server: ${refused}. ${unheard}` : `restart_server is restarting the server: ${unheard}`
      }
      case 'refresh_clients':
        this.deps.reloadPages()
        this.deps.log({ event: 'refresh-clients' })
        return `refresh_clients told every page to reload: ${unheard}`
    }
  }

  /** The agent has stopped: tell the model what it last said. */
  private fireMonitor(nodeId: NodeId, state: ClaudeState, words: string = STATE_WORDS[state]): void {
    const agents = this.deps.agents()
    const agent = agents.find(candidate => candidate.nodeId === nodeId)
    this.monitors.delete(nodeId)
    this.holding.delete(nodeId)
    if (!agent) return
    // Watched until now: typing into it soon after puts it on the back burner.
    this.burner.involve(nodeId)
    this.reportedStops.set(nodeId, agent.stateSince)
    const lastSaid = agent.transcriptPath ? lastAgentProse(this.deps.readTranscript(agent.transcriptPath)) : ''
    const token = this.token(nodeId, this.handles(agents))
    this.trace('fired', `Watch fired: ${token} is now ${words}`)
    this.events.push({
      kind: 'agent-stopped', agent: token, nodeId, state: words,
      lastSaid: capMessage(lastSaid),
    })
    this.maybeSpeakUp()
  }

  private maybeSpeakUp(): void {
    if (this.held || this.closing) return
    if (this.channel.isProducing()) {
      void this.maybeInterruptSelf()
      return
    }
    // Waiting out a failure: news that arrives meanwhile goes with the retry.
    if (this.backingOff) return
    if (!this.events.length && !(this.listening && this.returnNews) && this.carried === undefined) return
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
      const news = this.events.all()
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
    const carried = this.carried
    this.carried = undefined
    const words = joinWords(carried?.words, heard)
    // Whether this turn answers what the last brought up from the backlog. Spoken, the user frees whatever waited for them.
    const answering = words !== undefined && this.broughtUp
    if (words !== undefined) {
      this.broughtUp = false
      this.deps.backlog.heard()
    }
    // The reply this turn supersedes will never be heard: what backlog_next
    // gave it goes back now, in time to be counted in this turn's message.
    if (this.taken && !this.taken.attempt.isCurrent) this.putBack(this.taken.items)
    // Cut short for news: say so at once, while the turn that brings it is written.
    const selfInterrupted = this.selfInterrupted
    this.selfInterrupted = false
    if (selfInterrupted && this.listening && !this.reading) await this.channel.deliverInterim(attempt, [{ text: HANG_ON, voice: RECEPTIONIST_VOICE }])
    await this.noteInterruption(selfInterrupted ? 'self' : 'user')
    // The last reply is over, and any cut in it noted: see `DeferredReads.heardOut`.
    this.reads.heardOut()
    // Read after that await: the listener may have come or gone during it.
    const away = !this.listening
    const news = away ? undefined : this.returnNews
    if (!away) this.returnNews = undefined
    // Held on disk as this turn's until it is over: see pending-news.ts.
    const events = this.events.take(attempt, words, news)
    this.keepAway()
    const heardAgain = !away && this.letGoUntold
    if (heardAgain) this.letGoUntold = false
    const listeningAgain = !away && this.awayTold
    this.awayTold = away
    const again = heardAgain ? 'reconnected' as const : listeningAgain && !news ? 'listening' as const : undefined
    // As things stand at the turn's start, however late its message leaves: words carried to it change, nothing else does.
    const backlogSize = this.deps.backlog.size
    const watching = this.watching()
    const render = (said: string | undefined) => renderTurnBody(events, said, away ? 'away' : news, again, backlogSize, watching, pulled?.described)
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
    const entry = message ? render(message.text) : undefined
    if (message && entry !== undefined) {
      const at = this.deps.record.append([{ role: 'user', content: entry }])[0]
      if (at !== undefined) this.settle(message.via, at)
    }
    const opening: OpeningMessage = {
      words, failures: carried?.failures ?? 0, unsent: carried?.unsent ?? [], entry,
      render: said => `${render(said)}\n\n${FORMAT_REMINDER}`,
    }
    let monitoring = false
    try {
      const reply = await this.converse(attempt, opening, earlier, away, taken, answering)
      if (!attempt.isCurrent) {
        this.requeue(attempt, events, news, heardAgain, listeningAgain)
        this.putBack(taken)
        return
      }
      if (!reply) return
      // Through: a retry still pending has nothing left to wait out.
      this.failedTurns = 0
      if (this.backingOff) {
        this.backingOff = false
        this.retries++
      }
      // Acted on where the user could not hear: theirs to be told of when they are back.
      if (away && this.missed) {
        this.missed.events.push(...events)
        this.keepAway()
      }
      monitoring = await this.speak(attempt, render(opening.words), heard === undefined ? reply : acknowledgeSends(reply), taken, events, opening.words !== undefined)
    } catch (err) {
      this.putBack(taken)
      // Stopped before the session got the user's words, `ask` carried them on to the next message.
      const unsent = err instanceof Unsent && err.first
      if (!attempt.isCurrent) { this.requeue(attempt, events, news, heardAgain, listeningAgain); return }
      // Failed with the words, and any carried to them: tried again a little later, unless they have been tried enough.
      const { words: sent, failures } = opening
      const givenUp = sent !== undefined && !unsent && failures >= MAX_TURN_RETRIES
      if (sent !== undefined && !unsent && !givenUp) {
        this.carried = { words: sent, failures: failures + 1, unsent: [] }
        this.notes.push(RETRYING_AFTER_ERROR)
      }
      const newsRetried = this.retryNews(attempt, events)
      if (err instanceof LostSession) this.forgetSession()
      const message = err instanceof Error ? err.message : String(err)
      serverLog(`[receptionist] turn failed: ${message}`)
      this.deps.log({ event: 'turn-failed', heard: heard ?? null, error: message })
      this.onError(`The receptionist could not answer: ${message}`)
      const wait = this.carried !== undefined || newsRetried ? this.retryLater() : undefined
      // Muted, the toast says it. Only words that will not be tried again are apologised for.
      const apologise = givenUp && this.listening && !this.reading
      // Into the transcript as well as the toast: the toast is gone in seconds, and a
      // failure that repeats needs its error where it can be read afterwards.
      const [headline, ...rest] = message.split('\n')
      const retrying = wait === undefined ? '' : ` (trying again in ${Math.round(wait / 1000)} seconds)`
      this.trace('failed', `${apologise ? `"${TURN_FAILED_SPEECH}" — ` : ''}could not answer${retrying}: ${headline}`, rest.join('\n').trim() || undefined)
      if (apologise) monitoring = await this.channel.deliver(attempt, [{ text: TURN_FAILED_SPEECH, voice: RECEPTIONIST_VOICE }])
    } finally {
      // Told, or failed past retelling: either way, no longer the next server's to tell.
      this.events.told(attempt)
      if (!monitoring) this.channel.settle(attempt)
    }
  }

  /**
   * A failed turn's news, given back for the retry: the daemon may be
   * restarting, or the model briefly unavailable, and news dropped here was
   * never told at all. Some news is itself why the turn failed — a message
   * the model's safeguards refuse fails every time — so each piece is retried
   * `MAX_TURN_RETRIES` times, and is then set down, in the transcript and a
   * toast, where the user can see it. Returns whether any is retried.
   */
  private retryNews(attempt: Attempt, events: readonly ReceptionistEvent[]): boolean {
    const again = events.map(event => ({ ...event, failures: (event.failures ?? 0) + 1 }))
    const retry = again.filter(event => event.failures <= MAX_TURN_RETRIES)
    const dropped = again.filter(event => event.failures > MAX_TURN_RETRIES)
    this.events.requeue(retry, attempt)
    if (dropped.length) {
      const what = dropped.map(eventHeadline).join('; ')
      this.trace('failed', `Gave up on news after ${MAX_TURN_RETRIES + 1} failed turns: ${what}`, dropped.map(renderEvent).join('\n\n'))
      this.deps.notify(`Control could not take in this news: ${what}`)
    }
    return retry.length > 0
  }

  /**
   * Try again after a failed turn, waiting twice as long after each failure in
   * a row. Retrying at once is no use: on 2026-10-11 four turns flagged by the
   * model's safeguards inside 45 seconds, each in a fresh session, and the one
   * after them went through 80 seconds later. Until then news waits, so that
   * an agent stopping does not spend a retry early; the user's own words do
   * not wait, and take what is carried with them. Returns the wait.
   */
  private retryLater(): number {
    this.failedTurns++
    const wait = TURN_RETRY_MS * 2 ** (Math.min(this.failedTurns, MAX_TURN_RETRIES) - 1)
    const retry = ++this.retries
    this.backingOff = true
    void this.deps.sleep(wait).then(() => {
      if (retry !== this.retries) return
      this.backingOff = false
      this.maybeSpeakUp()
    })
    return wait
  }

  /**
   * Give a superseded turn's events back. They were never heard, and the turn
   * that superseded this one may already be over by now — so this has to
   * offer them a turn of their own, not just wait for the next phase change.
   */
  private requeue(attempt: Attempt, events: readonly ReceptionistEvent[], news: ReturnNews | undefined, heardAgain: boolean, listeningAgain: boolean): void {
    if (heardAgain) this.letGoUntold = true
    if (listeningAgain) this.awayTold = true
    if (news) this.returnNews = mergeNews(news, this.returnNews)
    this.keepAway()
    if (!events.length && !news) return
    if (events.length) {
      this.trace('requeued', `Turn dropped before a word of it was said; its news waits for the next: ${events.map(eventHeadline).join('; ')}`)
    }
    this.events.requeue(events, attempt)
    this.maybeSpeakUp()
  }

  /**
   * The model steps of one turn. `read` results go back to the model within
   * the turn; everything else runs as soon as it is asked for. Returns the
   * final reply, or undefined if the attempt lost ownership.
   */
  private async converse(
    attempt: Attempt, opening: OpeningMessage, earlier: readonly RecordMessage[], away: boolean, taken: BacklogItem[], answering: boolean,
  ): Promise<Reply | undefined> {
    // Each step after the first: what the model is told of its last reply.
    let message = ''
    for (let step = 1; step <= MAX_STEPS; step++) {
      const answer = await this.ask(attempt, step === 1 ? opening : `${message}\n\n${FORMAT_REMINDER}`, step === 1 ? earlier : [])
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
      // Set aside in a turn that brought backlog items up, or answered one that did, it waits for the user.
      await this.runTools(reply.tools.filter(isBookkeeping), agents, handles, undefined, [], answering || taken.length > 0)
      this.stageReads(attempt, reply.tools, agents, handles)
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
      const froms = reply.say.map(part => part.from)
      // The restart waits for the lookups too: see `restartLast`.
      const restart = actions.filter(isRestart)
      await this.runActions(actions.filter(call => !isRestart(call)), lines => done.push(...lines))
      // Taken, the actions are the model's to hear of even if the user talks
      // over this turn before their results go back: noted at once, for
      // whichever message leaves next, and taken back if it is this turn's.
      const note = this.noteDone(done)
      const talkedOver = spoken.length > 0 && !await this.speakInterim(attempt, froms, spoken) && !attempt.isCurrent
      const { results } = talkedOver ? { results: [] } : await this.runTools(reply.tools.filter(isLookup), agents, handles, undefined, taken)
      // Run even when talked over: it was taken, like the other actions.
      await this.runActions(restart, lines => done.push(...lines))
      if (talkedOver || !attempt.isCurrent) return undefined
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
   *
   * A turn's first message is its `opening`, rendered only as it leaves. The
   * user's words from a message that never reached the session go with the
   * next to leave, ahead of its own, and are carried here, before the queue
   * moves on: a turn begun while the message ahead of it waited has already
   * looked for them, and found none. On 2026-10-15 a message waiting out a
   * compaction learned only 13 seconds after the user spoke over it that it
   * had never got there; its words went with the turn after next, alone, and
   * Control took "make it orange" for a change of mind after "make it yellow".
   */
  private ask(attempt: Attempt, prompt: string | OpeningMessage, earlier: readonly RecordMessage[]): Promise<SessionAnswer> {
    const opening = typeof prompt === 'string' ? undefined : prompt
    const first = opening !== undefined
    const run = async (): Promise<SessionAnswer> => {
      if (opening) this.joinCarried(opening)
      // Superseded while queued: never sent, so there is nothing to answer.
      if (!attempt.isCurrent) {
        if (opening) this.carryUnsent(opening)
        throw new Unsent(first)
      }
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
      // Words that never reached the session are this message's own to say, not the recap's.
      const recap = forgets(session) ? renderRecap(opening ? withoutUnsent(earlier, opening.unsent) : earlier) : undefined
      // The compaction this message is first to reach, by the session's own clock; the daemon's answer says how it went.
      const compacted = recap && session?.compactsAt !== undefined && session.compactsAt !== this.compactionShown ? session.compactsAt : undefined
      // The old session's notes go to the first message of the new one.
      const handover = sessionId ? undefined : this.handover
      // Sampled now, as notes are, and said only when the session does not know it already.
      const status = this.deps.spacetermStatus()
      const statusNote = statusToTell(status, session?.toldStatus, session !== undefined && forgets(session))
      const message = [
        handover !== undefined ? `${HANDOVER_HEADING}\n${handover}` : undefined,
        recap, statusNote, notes.length ? `NOTE: ${notes.join(' ')}` : undefined, opening ? opening.render(opening.words) : prompt,
      ].filter(Boolean).join('\n\n')
      try {
        const sentAt = Date.now()
        const answer = await this.askWhenFree(
          { prompt: message, systemPrompt: RECEPTIONIST_SYSTEM_PROMPT, turnId: randomUUID(), ...(sessionId ? { sessionId } : {}) }, signal, attempt.signal,
        )
        if (answer.aborted && !answer.aborted.promptInSession) {
          // The session never saw this message: what it carried goes with the next.
          this.notes.unshift(...notes)
          if (opening) this.carryUnsent(opening)
          throw new Unsent(first)
        }
        this.traceCompaction(answer, compacted, sentAt, recap !== undefined)
        if (handover !== undefined) this.handover = undefined
        // The message is in the session, so the session knows the status now:
        // told it just now, or told it before and nothing changed. A session
        // other than the one asked for knows only what this message said.
        const told = statusNote !== undefined || answer.sessionId === sessionId ? statusOf(status) : NOTHING_PENDING
        if (answer.sessionId !== sessionId || answer.compactsAt !== session?.compactsAt || !sameStatus(told, session?.toldStatus ?? NOTHING_PENDING)) {
          this.session = {
            sessionId: answer.sessionId, promptHash: PROMPT_HASH,
            ...(answer.compactsAt !== undefined ? { compactsAt: answer.compactsAt } : {}),
            ...(sameStatus(told, NOTHING_PENDING) ? {} : { toldStatus: told }),
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

  /** Words carried since `opening`'s turn began go with it, ahead of its own: they were said first. */
  private joinCarried(opening: OpeningMessage): void {
    const late = this.carried
    if (!late) return
    this.carried = undefined
    opening.words = joinWords(late.words, opening.words)
    opening.failures = Math.max(late.failures, opening.failures)
    opening.unsent = [...late.unsent, ...opening.unsent]
  }

  /** `opening` never reached the session: its words, with what was carried to it, go with the next message instead. */
  private carryUnsent(opening: OpeningMessage): void {
    if (opening.words === undefined) return
    const unsent = opening.entry === undefined ? opening.unsent : [...opening.unsent, opening.entry]
    const since = this.carried
    this.carried = {
      words: joinWords(opening.words, since?.words)!,
      failures: Math.max(opening.failures, since?.failures ?? 0),
      unsent: [...unsent, ...since?.unsent ?? []],
    }
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
    interrupted = new Set<NodeId>(), taken: BacklogItem[] = [], setBack = false,
  ): Promise<{ results: string[]; done: string[] }> {
    const results: string[] = []
    const done: string[] = []
    for (const call of restartLast(calls)) {
      if (call.tool === 'spawn') {
        done.push(this.spawn(call, agents, handles))
        continue
      }
      if (call.tool === 'recall') {
        results.push(`recall "${call.search}":\n${this.deps.record.search(call.search)}`)
        continue
      }
      if (call.tool === 'list_agents') {
        results.push(this.listAgents(agents, handles))
        continue
      }
      if (call.tool === 'list_nodes') {
        results.push(this.listNodes(call.show, agents, handles))
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
        this.backlogAdd(call.item, setBack)
        continue
      }
      // Taken down by `stageReads`, with the turn it waits on.
      if (call.tool === 'mark_read') continue
      if (letsGo(call)) {
        // Away first, so that nothing more is said, whatever happens next.
        serverLog(`[receptionist] ${call.tool}: letting go of Control`)
        this.letGoUntold = true
        this.deps.letGo()
        if (call.tool === 'restart_server') await Promise.allSettled(this.sending)
        done.push(this.letGoFor(call.tool))
        continue
      }
      const nodeId = this.resolve(call.agent, handles, agents)
      const ended = nodeId ? undefined : this.resolveEnded(call.agent)
      if (ended && call.tool === 'read') {
        results.push(this.read(ended.agent, agentToken(ended.handle, this.deps.names.get(ended.agent.nodeId)?.name), call, true))
        continue
      }
      if (ended && call.tool === 'ask_agent') {
        done.push(this.askEndedAgent(ended, call.question))
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
      if (call.tool !== 'read' && call.tool !== 'agent_details' && call.tool !== 'archive_agent' && !naming) this.named(agent.nodeId, handles)
      const who = this.describe(agent, handles)
      switch (call.tool) {
        case 'read':
          results.push(this.read(agent, this.token(agent.nodeId, handles), call, false))
          break
        case 'agent_details':
          results.push(this.agentDetails(agent, agents, handles))
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
          this.track(this.send(agent.nodeId, call.message, interrupted.has(agent.nodeId), handles))
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
  private async takeFromBacklog(about: string | undefined, atPause = false): Promise<TakenItems> {
    // At a pause, only what is not waiting for the user to speak: see `BacklogItem.waitsForUser`.
    const all = this.deps.backlog.all()
    const positions = all.flatMap((item, i) => atPause && item.waitsForUser ? [] : [i])
    const items = positions.map(i => all[i])
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
    const took = this.deps.backlog.take(pick.indices.map(i => positions[i]))
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
        `If the user does not want ${them} now, add ${them === 'it' ? 'it' : 'those'} back with backlog_add, ` +
        `and ${them === 'it' ? 'it' : 'they'} will not come up on ${them === 'it' ? 'its' : 'their'} own again until the user next speaks.`,
    }
  }

  /**
   * Whether the quiet after a reply is unbroken, so that a backlog item could
   * come up: see `maybePull`. Never while words wait unread — written to a
   * muted device, or left by a voice that failed: quiet then is the user not
   * having read them yet, and each item would bring up the next unseen. Once
   * they catch up, the quiet starts over (`caughtUp`).
   */
  private quietSince(pause: number): boolean {
    return pause === this.pauses && this.listening && !this.held && !this.channel.isProducing() && !this.events.length && !this.returnNews &&
      !this.ledger.unread().count
  }

  /**
   * A reply has finished and Control is idle with something on its backlog:
   * ask Jev whether the user is ready for it (backlog-pause.ts), and bring it
   * up after as much quiet as the verdict asks — none, a moment, or long
   * enough to end a topic — and never within `INTERRUPTION_QUIET_MS` of the
   * user cutting Control off to talk. Anything that breaks the quiet
   * meanwhile — the user talking, an event, any other turn — moves `pauses`
   * on, and the item stays put. Every verdict is logged, for tuning.
   */
  private async maybePull(): Promise<void> {
    const pause = this.pauses
    if (this.deps.backlog.held || !this.deps.backlog.ready || !this.quietSince(pause) || this.pauseJudged === pause) return
    this.pauseJudged = pause
    const verdict = await decidePause(pauseDialogue(this.deps.record.recent(RECAP_MESSAGES)), (c) => this.deps.judgePause(c))
    serverLog(`[receptionist] backlog pause: ${verdict.reason}` +
      `${verdict.reason === 'judged' ? ` now ${verdict.probabilities.now.toFixed(2)}, after pause ${verdict.probabilities.afterPause.toFixed(2)}` : ''} → ${verdict.when}`)
    this.deps.log({ event: 'backlog-pause', ...verdict })
    if (verdict.when === 'not-yet') {
      this.tracePause(verdict, 0)
      return
    }
    const sinceInterruption = this.interruptedAt === undefined ? Infinity : Date.now() - this.interruptedAt
    const wait = Math.max(PAUSE_WAIT_MS[verdict.when], INTERRUPTION_QUIET_MS - sinceInterruption)
    this.tracePause(verdict, wait)
    if (wait > 0) await this.deps.sleep(wait)
    if (!this.quietSince(pause) || this.deps.backlog.held) return
    const pulled = await this.takeFromBacklog(undefined, true)
    if (!pulled.items.length) return
    // Choosing the item took a moment too.
    if (!this.quietSince(pause) || this.deps.backlog.held) {
      this.putBack(pulled.items, this.deps.backlog.held ? 'the backlog was held while it was being chosen' : 'the quiet was broken while it was being chosen')
      return
    }
    await this.runTurn(undefined, pulled)
  }

  /** Set an item aside, with the surfaces of the live agents its tokens name, so that their caches can be weighed later. */
  private backlogAdd(text: string, waitsForUser = false): void {
    const live = this.deps.agents()
    const handles = this.handles(live)
    const agents = [...new Set([...text.matchAll(AGENT_TOKEN)].flatMap(([, ref]) => this.resolve(ref, handles, live) ?? []))]
    const dropped = this.deps.backlog.add(text, Date.now(), agents, waitsForUser)
    this.deps.log({ event: 'backlog-add', item: text, agents, size: this.deps.backlog.size, dropped, waitsForUser })
    this.trace('backlog-add', `Set aside for later: ${text}`,
      `${this.deps.backlog.size} on the backlog now.${waitsForUser ? ' It waits until you next speak before it can come up again.' : ''}`)
    if (dropped.length) {
      this.trace('backlog-dropped', `Backlog full, so the oldest went: ${dropped.map(item => item.text).join(' / ')}`)
      this.notes.push(`Your backlog was full, so its oldest item was dropped: ${dropped.map(item => item.text).join('; ')}.`)
    }
  }

  /** What the user missed while away, to disk as it changes: see pending-news.ts. */
  private keepAway(): void {
    this.events.keepAway({ missed: this.missed, returnNews: this.returnNews })
  }

  /** Put back what backlog_next gave a reply nobody will hear. Empties `items`, so putting back twice is harmless. */
  private putBack(items: BacklogItem[], why = 'the reply that brought it up was never heard'): void {
    const back = items.splice(0)
    if (!back.length) return
    this.deps.backlog.restore(back)
    this.trace('backlog-back', `Back on the backlog, since ${why}: ${back.map(item => item.text).join(' / ')}`)
  }

  /**
   * Why a pause did or did not bring up the backlog, and how long it waits, for
   * the transcript's activity log. One brought up at once is shown by `backlog-take`.
   */
  private tracePause(verdict: PauseVerdict, wait: number): void {
    if (verdict.reason === 'judge-failed') {
      this.trace('backlog-wait', 'Backlog held: could not judge whether you were ready for something new', verdict.error)
      return
    }
    if (wait <= 0) return
    const seconds = Math.round(wait / 1000)
    const why = wait > PAUSE_WAIT_MS[verdict.when] ? 'you cut me off to talk'
      : verdict.when === 'mid-topic' ? 'you seem to be in the middle of a topic'
        : 'in case you have more to say'
    const odds = `Ready now ${percent(verdict.probabilities.now)}, after ${PAUSE_WAIT_MS['after-pause'] / 1000} seconds of quiet ${percent(verdict.probabilities.afterPause)}.`
    this.trace('backlog-wait', `Backlog waits for ${seconds} seconds of quiet: ${why}`, odds)
  }

  /** The last few exchanges with the user, as Jev is shown them. */
  private recentConversation(): string {
    const conversation = this.deps.record.recent(RECAP_MESSAGES)
      .map(({ role, content }) => `${role === 'user' ? '' : 'YOU: '}${content}`).join('\n')
    return lastWords(conversation, CONVERSATION_WORDS)
  }

  /**
   * The read tool: a page of an agent's transcript, plain or searched. An ended
   * agent's is read the same way, but without a cache to weigh: it cannot be asked.
   */
  private read(agent: RosterAgent, token: string, { search, before }: { search?: string; before?: number }, ended: boolean): string {
    // The whole session, paged: page by page, every word of it can be reached.
    const messages = agent.transcriptPath ? this.deps.readWholeTranscript(agent.transcriptPath) : []
    // The cache comes with the transcript: it decides whether ask_agent is worth it.
    const cache = ended
      ? `\n${endedCacheWords(agent, Date.now())}`
      : (agent.cacheWarmUntil !== undefined ? `\ncache: ${cacheWords(agent, Date.now())}` : '')
        + (agent.takesSideQuestions === false ? `\n${NO_SIDE_QUESTIONS}` : '')
    const asked = `${search ? ` for "${search}"` : ''}${before !== undefined ? ` before message ${before}` : ''}`
    return `read ${token}${asked}:${cache}\n${readAgent(messages, { search, before })}`
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
    for (const ended of this.ended.values().reverse()) {
      if (ended.handle === wanted) return ended
      if (name === undefined && this.deps.names.get(ended.agent.nodeId)?.name.toLowerCase() === wanted) return ended
    }
    return undefined
  }

  /** Start a new agent, and watch for its first answer as for a send. */
  private spawn(call: Extract<ToolCall, { tool: 'spawn' }>, agents: readonly RosterAgent[], handles: Handles): string {
    const parent = this.spawnParent(call.under, agents, handles)
    if (!parent) return `spawn [${call.under}]: that is no longer on the canvas.`
    const where = parent.node ? describeNode(parent.node, this.nodeListContext(this.deps.nodes(), agents, handles)) : 'the top level of the canvas'
    try {
      const { nodeId, cwd } = this.deps.spawn(parent.id, call.title, call.prompt)
      const runsIn = parent.node?.type === 'directory' ? '' : cwd ? `, running in ${cwd}` : ', with no directory to run in'
      // Named now, not lazily as other agents are: the result carries the
      // name, so the confirmation that follows it can introduce the agent.
      // checkNames has passed a chosen name; only one taken since then fails
      // here, and the system names the agent instead.
      const chosen = call.name && this.deps.names.setName(nodeId, call.name.name, call.name.gender)
      const named = chosen && chosen.ok ? chosen.named : this.deps.names.assign(nodeId)
      const handle = this.handles([...agents.map(agent => agent.nodeId), nodeId].map(id => ({ nodeId: id }))).of(nodeId)
      const token = agentToken(handle ?? nodeId, named?.name)
      this.deps.log({ event: 'spawned', nodeId, under: parent.id, directory: cwd ?? null, title: call.title, prompt: call.prompt, name: named?.name ?? null, chosen: call.name ?? null })
      this.deps.record.append([{ role: 'assistant', content: `STARTED ${token} under ${where}${runsIn}: ${call.prompt}` }])
      // After its name: the activity line names it as the STARTED line does.
      this.watch(nodeId, 'after-work', 'Control started it')
      const refused = chosen && !chosen.ok ? `, not ${call.name!.name}: ${this.nameProblemWords(chosen.problem)}` : ''
      const name = named ? `. It is called ${named.name}${refused}` : ''
      return `spawn started ${token} "${call.title}" under ${where}${runsIn}${name}. It is now watched for its next stop`
    } catch (err) {
      return `spawn under ${where} failed: ${err instanceof Error ? err.message : String(err)}`
    }
  }

  /**
   * Where spawn's "under" puts the new agent: anywhere the user could put one
   * themselves — the root, a live agent by its token, or any node on the
   * canvas by its handle — but never a generated node, which nothing can
   * persist under. `node` is undefined for the root.
   */
  private spawnParent(ref: string, agents: readonly RosterAgent[], handles: Handles): { id: NodeId; node?: NodeData } | undefined {
    if (ref.trim().toLowerCase() === ROOT_NODE_ID) return { id: ROOT_NODE_ID }
    const nodes = this.deps.nodes()
    const nodeId = this.resolve(ref, handles, agents) ?? this.nodeHandles(nodes).find(parseAgentRef(ref).key)
    const node = nodes.find(candidate => candidate.id === nodeId)
    return node && !isGenerated(node) ? { id: node.id, node } : undefined
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

  /** Keep a send in `sending` until it has been handed over. */
  private track(sending: Promise<void>): void {
    this.sending.add(sending)
    void sending.finally(() => this.sending.delete(sending))
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
  private async askAgent(agent: RosterAgent, question: string, handles: Handles, tries = 1): Promise<void> {
    // Named now if it has no name yet: its answer will be quoted in its voice,
    // and the toast should already call it what the listener will hear.
    const named = this.named(agent.nodeId, handles)
    const name = named?.name ?? agent.title
    const token = this.token(agent.nodeId, handles)
    const onsets = this.onsets
    // On disk until it is answered, so a restart asks it again: see `resumeQuestions`.
    const asking: Asking = { id: randomUUID(), nodeId: agent.nodeId, question, ended: false, tries }
    this.events.asked(asking)
    await this.warmUp(agent)
    let result = await this.deps.askAgent(agent.nodeId, sideQuestionPrompt(question))
    if (!result.ok && result.reason === 'nothing-to-fork') {
      // Just resumed — unarchived, or restarted — its process has not sent a
      // request yet, so there is none to replay. One turn of its own makes one.
      this.deps.log({ event: 'side-question', nodeId: agent.nodeId, question, result, retry: 'after a wake-up' })
      const now = this.deps.agents().find(candidate => candidate.nodeId === agent.nodeId)
      if (now) {
        await this.warmUp(now, true)
        result = await this.deps.askAgent(agent.nodeId, sideQuestionPrompt(question))
      }
    }
    this.answered(asking.id, agent.nodeId, token, name, question, result, onsets)
  }

  /**
   * ask_agent for an agent that has ended: from its cache while that is warm,
   * without bringing it back. The answer comes as an event, as for a live one.
   */
  private askEndedAgent(ended: EndedAgent, question: string, tries = 1): string {
    const { agent, handle } = ended
    const name = this.deps.names.get(agent.nodeId)?.name
    const token = agentToken(handle, name)
    if (!endedAskable(agent, Date.now())) {
      return `ask_agent did not ask ${token}: ${endedCacheWords(agent, Date.now())}`
    }
    const onsets = this.onsets
    const asking: Asking = { id: randomUUID(), nodeId: agent.nodeId, question, ended: true, tries }
    this.events.asked(asking)
    void this.deps.askEnded(agent, sideQuestionPrompt(question)).then(({ result, cacheWarmUntil }) => {
      // The question read the cache, which keeps it warm for longer.
      const still = this.ended.get(agent.nodeId)
      if (still && cacheWarmUntil !== undefined && cacheWarmUntil > (still.agent.cacheWarmUntil ?? 0)) {
        this.ended.update(agent.nodeId, { ...still.agent, cacheWarmUntil })
      }
      this.answered(asking.id, agent.nodeId, token, name ?? agent.title, question, result, onsets, true)
    })
    return `ask_agent asked ${token}, which has ended, from its still-warm cache, without bringing it back; the answer will come as an event`
  }

  /** A side question's outcome, live or ended: logged with what it read from the cache, toasted, and told as an event. */
  private answered(askId: string, nodeId: NodeId, token: string, name: string, question: string, result: SideQuestionResult, onsets: number, ended = false): void {
    const usage = result.ok ? result.usage : undefined
    const cache = usage ? { read: usage.cache_read_input_tokens ?? 0, written: usage.cache_creation_input_tokens ?? 0, uncached: usage.input_tokens ?? 0 } : undefined
    this.deps.log({ event: 'side-question', nodeId, question, result, ...(cache ? { cache } : {}), ...(ended ? { ended } : {}) })
    // The user has spoken since: what they said may have made the question moot.
    const stale = this.onsets !== onsets ? { beforeUserSpoke: true as const } : {}
    if (result.ok) {
      this.deps.notify(`Control asked ${name}: ${usageWords(result.usage)}`)
      this.events.push({ kind: 'agent-answer', agent: token, question, answer: result.text, ...(ended ? { ended } : {}), ...stale })
    } else {
      serverLog(`[receptionist] side question to ${token} failed: ${result.reason}${result.detail ? ` ${result.detail}` : ''}`)
      this.deps.notify(`Control's question to ${name} failed: ${SIDE_QUESTION_TOASTS[result.reason]}`)
      this.events.push({ kind: 'agent-answer-failed', agent: token, question, reason: SIDE_QUESTION_FAILURES[result.reason], ...stale })
    }
    // News now, which is on disk itself: no longer one for the next server to ask.
    this.events.answered(askId)
    this.maybeSpeakUp()
  }

  /**
   * Ask again the side questions the last server asked and never had
   * answered: the answer was on its way when the server went, and the new one
   * would never hear it. Each is asked at most `MAX_QUESTION_TRIES` times, so
   * a question that brings the server down is not asked forever. One that
   * cannot be asked again is told as a failure, so Control is never left
   * waiting for an answer that will not come.
   */
  private resumeQuestions(): void {
    const agents = this.deps.agents()
    const handles = this.handles(agents)
    for (const asking of this.events.unanswered()) {
      const live = asking.ended ? undefined : agents.find(agent => agent.nodeId === asking.nodeId)
      const ended = asking.ended ? this.ended.get(asking.nodeId) : undefined
      this.deps.log({ event: 'side-question-resumed', nodeId: asking.nodeId, question: asking.question, tries: asking.tries })
      if (asking.tries < MAX_QUESTION_TRIES && live) {
        void this.askAgent(live, asking.question, handles, asking.tries + 1)
        continue
      }
      if (asking.tries < MAX_QUESTION_TRIES && ended && endedAskable(ended.agent, Date.now())) {
        this.askEndedAgent(ended, asking.question, asking.tries + 1)
        continue
      }
      const token = live ? this.token(live.nodeId, handles) : this.traceToken(asking.nodeId)
      const reason = asking.tries >= MAX_QUESTION_TRIES
        ? `the server restarted while it was being asked, ${asking.tries} times over, so it was not asked again. Answer from its transcript with read instead`
        : 'the server restarted while it was being asked, and the agent can no longer be asked. Answer from its transcript with read instead'
      this.events.push({ kind: 'agent-answer-failed', agent: token, question: asking.question, reason })
    }
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
   *
   * `notForked`: wake it whatever its cache, because its process has nothing
   * to fork yet — it was just resumed — and the fork said so.
   */
  private async warmUp(agent: RosterAgent, notForked = false): Promise<void> {
    const { nodeId } = agent
    const already = this.warming.get(nodeId)
    if (already) return already.answered
    if (agent.state !== 'stopped') return
    if (!notForked && (agent.cacheWarmUntil === undefined || agent.cacheWarmUntil > Date.now())) return
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

  /**
   * Handles for the nodes on the canvas, as list_nodes and nearby give them
   * for what is not an agent. Always over every live node, never a filtered
   * few, so a node has the same handle in every list.
   */
  private nodeHandles(nodes: readonly NodeData[] = this.deps.nodes()): Handles {
    return new Handles(nodes.map(node => node.id), NODE_PREFIX)
  }

  /** Whatever force_user_camera can take the user to: an agent by its token, or any node by its handle. */
  private resolveTarget(ref: string, handles: Handles, agents: readonly RosterAgent[]): NodeId | undefined {
    const { key } = parseAgentRef(ref)
    return this.resolve(ref, handles, agents) ?? this.nodeHandles().find(key)
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
   * spoken part comes from — that is not a live agent's (or, for spawn, any
   * node's, or the root). One sentence per problem, with the nearest real handles.
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
      if (call.tool !== 'spawn' || this.spawnParent(call.under, agents, handles)) continue
      const near = this.nodeHandles().nearest(parseAgentRef(call.under).key)
      problems.push(`"${call.under}" (in spawn) is not root, a live agent's token, or a node's handle.${near.length ? ` Did you mean ${near.join(' or ')}?` : ' Use list_nodes to look it up.'}`)
    }
    for (const { ref, where, camera, tool } of this.agentRefs(reply)) {
      if (camera) {
        if (!this.resolveTarget(ref, handles, agents)) {
          problems.push(`"${ref}" (${where}) is not a live agent, or a node from list_nodes or nearby.${suggest(ref)}`)
        }
      } else if (this.resolve(ref, handles, agents)) {
        continue
      } else if (this.resolveEnded(ref)) {
        if (!(tool && ENDED_TOOLS.has(tool))) {
          problems.push(`"${ref}" (${where}) is no longer live: only read, ask_agent and unarchive_agent take it. Speak of it in plain words, by its name.`)
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

  /** The list_agents tool: every live agent, a line each. */
  private listAgents(agents: readonly RosterAgent[], handles: Handles): string {
    const handleOf = (nodeId: NodeId) => handles.of(nodeId) ?? nodeId
    return `list_agents:\n${renderRoster(agents, nodeId => this.deps.names.get(nodeId)?.name, handleOf)}`
  }

  /**
   * The list_nodes tool: the directories, the titles, or everything on the
   * canvas, each with its path. Logged with its size, since every result stays
   * in Control's session until compaction: a canvas big enough to near the cap
   * is the sign the tool needs rethinking.
   */
  private listNodes(show: NodeListShow, agents: readonly RosterAgent[], handles: Handles): string {
    const nodes = this.deps.nodes()
    const list = renderNodeList(nodes, show, this.nodeListContext(nodes, agents, handles))
    this.deps.log({ event: 'list-nodes', show, nodes: nodes.length, matched: list.matched, omitted: list.omitted, chars: list.text.length })
    return `list_nodes (${show}):\n${list.text}`
  }

  private nodeListContext(nodes: readonly NodeData[], agents: readonly RosterAgent[], handles: Handles): NodeListContext {
    const nodeHandles = this.nodeHandles(nodes)
    const live = new Set(agents.map(agent => agent.nodeId))
    return {
      rootCwd: this.deps.rootCwd(),
      handleOf: nodeId => nodeHandles.of(nodeId) ?? nodeId,
      agentTokenOf: nodeId => live.has(nodeId) ? this.token(nodeId, handles) : undefined,
    }
  }

  /** The agent_details tool: one agent in depth, up to the start of its last exchange. */
  private agentDetails(agent: RosterAgent, agents: readonly RosterAgent[], handles: Handles): string {
    const messages = agent.transcriptPath ? this.deps.readTranscript(agent.transcriptPath) : []
    const nodes = this.deps.nodes()
    const under = pathWords(agent.nodeId, new Map(nodes.map(node => [node.id, node])), this.nodeListContext(nodes, agents, handles))
    const details = renderAgentDetails(agent, nodeId => this.deps.names.get(nodeId)?.name, messages, nodeId => handles.of(nodeId) ?? nodeId, under || 'the top level')
    return `agent_details:\n${details}`
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
    spoken: SpokenPart[]; mentioned: NodeId[]; speakers: string[]
    /** The agent each part is spoken by in its own voice, or undefined for Control. */
    voices: Array<NodeId | undefined>
  } {
    const handles = this.handles(agents)
    const byId = new Map(agents.map(agent => [agent.nodeId, agent]))
    const mentioned: NodeId[] = []
    const resolve = (ref: string): { name: string; voice: string; nodeId: NodeId } | undefined => {
      const nodeId = this.resolve(ref, handles, agents)
      const agent = nodeId ? byId.get(nodeId) : undefined
      if (!agent) return undefined
      const named = this.named(agent.nodeId, handles)
      if (!named) return undefined
      if (!mentioned.includes(agent.nodeId)) mentioned.push(agent.nodeId)
      return { name: named.name, voice: named.voice, nodeId: agent.nodeId }
    }
    const spoken = renderSpeech(say, resolve, RECEPTIONIST_VOICE)
    // Who each part is heard as, for the speaking indicator: as `renderSpeech` decides, Control unless it is an agent's own.
    const owners = say.map(part => part.from === CONTROL ? undefined : resolve(part.from))
    const speakers = owners.map(owner => owner?.name ?? RECEPTIONIST_NAME)
    for (const nodeId of mentioned) this.deps.names.touch(nodeId)
    return { spoken, mentioned, speakers, voices: owners.map(owner => owner?.nodeId) }
  }

  /** The tokens of the agents being watched, for the turn's WATCHING line. */
  private watching(): string[] {
    const agents = this.deps.agents()
    const handles = this.handles(agents)
    return agents.filter(agent => this.monitors.has(agent.nodeId)).map(agent => this.token(agent.nodeId, handles))
  }

  private async speak(
    attempt: Attempt, body: string, reply: Reply, taken: BacklogItem[], events: readonly ReceptionistEvent[], withWords: boolean,
  ): Promise<boolean> {
    // What mark_read asked for waits on this reply, or on nothing if it is never said.
    const reads = this.takeStaged(attempt)
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
        this.keepAway()
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
    const { spoken, speakers, voices } = this.render(reply.say, agents)
    const froms = reply.say.map(part => part.from)
    // Being said: what backlog_next gave it is the user's now. Cut off, the note says to set it aside again.
    if (taken.length) this.broughtUp = true
    this.deps.backlog.settle(taken.splice(0))
    // And so is what the turn was about. A server that stops from here on says it was cut off: see carry-over.ts.
    this.events.told(attempt)
    // Except a restart or a refresh, which would take the words away with the
    // page: those wait for them to be heard. On 2026-10-18 Iris's answer came
    // with the restart Control had promised to hold until the user heard it,
    // and the restart ran first and silenced it.
    const afterWords: ToolCall[] = spoken.length ? actions.filter(letsGo) : []
    // Done before a word is said, and reported by the words: the user never
    // waits through "Sent to Kevin" for the send. Talking over the words
    // undoes nothing, which is why Control asks first when it is unsure.
    await this.runActions(actions.filter(call => !afterWords.includes(call)))
    // Read after the actions' awaits: muting while they ran writes this reply.
    const reading = this.reading
    const at = this.writeReply(froms, spoken, reading)
    if (at !== undefined && spoken.length) this.reads.defer(at, reads.map(read => withOwnParts(read, voices)))
    else if (reads.length) this.traceReads(reads, 'left unread: the reply that told you of it said nothing')
    // After the reply, so the transcript's activity log reads as it happened: silence, then the watch kept.
    this.keepWatchingUntold(events, reply, withWords)
    this.deps.log({ event: 'turn', body, say: reply.say, spoken, tools: reply.tools, ...(reading ? { muted: true } : {}) })
    // Muted, it is written, and that is all: there is nothing to cut off, nor to wait for.
    if (reading) {
      this.reads.heardOut()
      await this.runActions(afterWords)
      return false
    }
    this.lastSpoken = spoken
    this.lastSpokenAt = at
    const parts = spoken.map(({ text, voice }) => ({ text, voice }))
    if (!parts.length) return false
    const heardOut = this.whenHeardOut(attempt, afterWords)
    this.deps.carryOver.speaking(true)
    const starts = speechPartStarts(parts)
    let speaker: string | undefined
    // Where the voice is, for the transcript: lit up to there and dim after.
    // It goes back as well as forward, since the listener can rewind, so it
    // follows the voice asked outright (`followVoice`) and never the change
    // feed, whose offsets lag a sentence behind going forward and run ahead
    // of a rewind into a sentence already finished.
    let shown: number | undefined
    const reached = (heard: number): void => {
      if (at === undefined || heard === shown || this.lastSpoken !== spoken) return
      shown = heard
      this.onSpeaking({ of: at, parts: playedLengths(spoken, heard) })
    }
    // Dim from the start, in the same tick the reply joins the transcript:
    // otherwise it shows lit until the voice first reports where it is.
    reached(0)
    const monitoring = await this.channel.deliver(attempt, parts, undefined, (progress) => {
      // The voice failed: whatever it did not say waits for the user to read, and the model is told.
      if (progress.kind === 'ended' && progress.state === 'synthesis_failed') void this.noteInterruption('failed')
      // Said to the end: what it told waits on the user's answer alone, crash or not.
      if (progress.kind === 'ended' && progress.state === 'completed') this.reads.heardOut()
      if (progress.kind === 'ended') heardOut(progress.state === 'completed' || progress.state === 'synthesis_failed' || progress.state === 'lost')
      if (progress.kind !== 'playing') return
      const index = starts.filter(start => start <= progress.heard).length - 1
      const now = speakers[Math.max(0, index)]
      if (now !== speaker) this.onSpeaker(speaker = now)
    })
    if (monitoring) void this.followVoice(spoken, reached)
    // Never followed, but not talked over either: the voice refused it or is not
    // running, so the words wait as text, and there is nothing to wait for.
    else if (attempt.isCurrent) heardOut(true)
    return monitoring
  }

  /**
   * Hold `calls` — the restart or refresh a spoken reply came with — until its
   * words end: run once they were said to the end, or could not be said (the
   * transcript holds them), and dropped when the user cut them off, the turn
   * was superseded, or the listener left. A dropped one is struck out in the
   * transcript and the model told, so it is run again only if still wanted.
   * Returns the call that settles it, with whether to run them.
   */
  private whenHeardOut(attempt: Attempt, calls: readonly ToolCall[]): (run: boolean) => void {
    if (!calls.length) return () => {}
    let settled = false
    const settle = (run: boolean): void => {
      if (settled) return
      settled = true
      if (run) {
        void this.runActions(calls)
        return
      }
      this.deps.log({ event: 'held-for-words-dropped', tools: calls })
      this.deps.record.notDone(calls.map(actionHeadline))
      this.notes.push(`${calls.map(call => call.tool).join(' and ')} did not run: it waited for the words it came with, and the user did not hear them out. Run it again only if they still want it.`)
    }
    // Settled first, any abort after is a no-op.
    if (attempt.signal.aborted) settle(false)
    else attempt.signal.addEventListener('abort', () => settle(false), { once: true })
    return settle
  }

  /**
   * A reply's words into the record, as they were said, for the transcript
   * and the ledger of what the user has taken in. Returns where it is.
   */
  private writeReply(froms: readonly string[], spoken: readonly SpokenPart[], reading: boolean): number | undefined {
    const at = this.deps.record.append([{
      role: 'assistant', content: storedReply(froms, spoken),
      voices: spoken.map(part => part.voice ?? RECEPTIONIST_VOICE),
      ...(reading ? { delivery: 'text' as const } : {}),
    }])[0]
    if (at !== undefined && spoken.length) {
      this.ledger.delivered(at, spoken.map(part => part.text), reading ? 'text' : 'spoken')
      if (reading) this.onUnread(this.ledger.unread())
    }
    return at
  }

  /**
   * Ask the voice where it is in `spoken` every `VOICE_FOLLOW_MS` while it
   * says it, for the transcript's lit word: the job's change feed moves only
   * a sentence at a time, and only forward.
   */
  private async followVoice(spoken: SpokenPart[], reached: (heard: number) => void): Promise<void> {
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
  private async speakInterim(attempt: Attempt, froms: readonly string[], spoken: SpokenPart[]): Promise<boolean> {
    let over: () => void = () => {}
    const interim: NonNullable<Receptionist['interim']> = {
      attempt, spoken, text: joinSpeechParts(spoken), heard: 0, ended: false, over: new Promise<void>((resolve) => { over = resolve }),
    }
    this.interim = interim
    const queued = await this.channel.deliverInterim(attempt, spoken, (progress) => {
      if (progress.kind === 'playing') {
        if (!interim.ended) interim.heard = progress.heard
        return
      }
      interim.ended = true
      interim.heard = progress.state === 'completed' ? interim.text.length : progress.heard ?? interim.heard
      over()
    })
    if (!attempt.isCurrent) return queued
    // Written like any reply: the transcript shows every word Control says,
    // not only the step that ends the turn. Refused by the voice, it waits
    // there for the user to read, as a reply the voice failed on does.
    interim.at = this.writeReply(froms, spoken, false)
    if (!queued && interim.at !== undefined) {
      const none = spoken.map(() => 0)
      this.deps.record.amendHeard(interim.at, none, true)
      this.ledger.heard(interim.at, none, true)
      this.onUnread(this.ledger.unread())
    }
    if (queued) void this.followInterim(interim)
    return queued
  }

  /**
   * Light the transcript's words as the interim words are said, asking the
   * voice where it is as `followVoice` does for the answer — and keep how far
   * they got, word by word, for a cut the drop cannot place.
   */
  private async followInterim(interim: NonNullable<Receptionist['interim']>): Promise<void> {
    const at = interim.at
    if (at === undefined) return
    this.onSpeaking({ of: at, parts: playedLengths(interim.spoken, 0) })
    while (this.interim === interim && !interim.ended && interim.attempt.isCurrent) {
      await this.deps.voiceTick()
      const offset = await this.channel.interimOffset()
      if (offset === undefined || this.interim !== interim || interim.ended) continue
      interim.heard = offset
      this.onSpeaking({ of: at, parts: playedLengths(interim.spoken, offset) })
    }
    // Said to the end: all of it lit, until the turn moves on.
    if (interim.ended && interim.heard >= interim.text.length && interim.attempt.isCurrent) {
      this.onSpeaking({ of: at, parts: playedLengths(interim.spoken, interim.heard) })
    }
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
   * Control cut its own reply short for news, for the transcript's activity log:
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

  /** A reply that was written and never said, word for word, for the transcript's activity log. */
  private traceUnspoken(say: readonly SayPart[], why: string): void {
    this.trace('unspoken', `Never spoken: ${why}`, say.map(part => `${part.from === CONTROL ? 'Control' : `{${stripBraces(part.from)}}`}: ${part.text}`).join('\n\n'))
  }

  /**
   * A compaction, into the transcript, when the session is next used — which
   * can be an hour after the compaction itself. `expected` is the one the
   * session's clock said was due: the daemon keeps what it compacted in
   * memory only, so after a restart of its own it has nothing to report.
   */
  private traceCompaction(answer: SessionAnswer, expected: number | undefined, sentAt: number, recapped: boolean): void {
    if (answer.compaction) {
      const { text, detail } = compactionTrace(answer.compaction, answer.contextWindow, sentAt, recapped)
      this.trace('compacted', text, detail)
    } else if (expected !== undefined) {
      const minutes = Math.round((sentAt - expected) / 60_000)
      this.trace('compacted', `Memory compacted ${minutes < 1 ? 'just now' : `${minutes} min ago`}: its last few messages were repeated to it word for word`)
    }
    if (expected !== undefined) this.compactionShown = expected
  }

  /** Why Control did or did not speak, into the transcript: see `ReceptionistDeps.record.trace`. */
  private trace(what: ControlTraceKind, text: string, detail?: string): void {
    this.deps.record.trace({ what, text, ...(detail ? { detail } : {}) })
  }

  /** An agent's token for the activity log, whether it is live, just started, or has ended. */
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
   * server went down — or the voice `failed`, and what they missed waits for
   * them rather than being struck out: see `ConsumptionLedger.settle`.
   */
  private noteInterruption(cause: Interruption, stopping?: Promise<unknown>): Promise<boolean> {
    // One at a time, each after what stopped the speech: noted while a stop is
    // still dropping the job, the cut would be lost along with the reply.
    const noted = this.interruptions.then(async () => {
      await stopping
      return this.takeInterruption(cause)
    })
    this.interruptions = noted.catch(() => undefined)
    return noted
  }

  private async takeInterruption(cause: Interruption): Promise<boolean> {
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
      const waiting = cause === 'lost' || cause === 'failed' || muted
      this.deps.record.amendHeard(spokenAt, lengths, waiting)
      this.ledger.heard(spokenAt, lengths, waiting)
      if (waiting) this.onUnread(this.ledger.unread())
      if (!this.ledger.whole(spokenAt)) this.traceDropped(this.reads.cut(spokenAt, read => this.ledger.whole(spokenAt, read.parts)), true)
    }
    const kept = redactSpoken(spoken, heard)
    const audible = kept.map(part => part.text).join(' ')
    if (muted) {
      this.notes.push(`The user muted you partway through your last reply. They heard only: "${audible}". The rest is shown to them as text, which they may not have read yet; do not assume they know it.`)
      return true
    }
    if (cause === 'failed') {
      this.notes.push(`${audible === INTERRUPTED_MARKER ? 'None of your last reply was heard' : `Your last reply was cut short: they heard only "${audible}"`}, because Voice Operator could not turn it into speech. What they did not hear is shown to them as text, which they may not have read yet; do not assume they know it.`)
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
    this.keepAway()
    return true
  }
}

/** `read` waiting on the parts of its reply spoken in its agent's own voice, if any: see `DeferredRead.parts`. */
function withOwnParts(read: DeferredRead, voices: ReadonlyArray<NodeId | undefined>): DeferredRead {
  const parts = voices.flatMap((nodeId, part) => nodeId === read.nodeId ? [part] : [])
  return parts.length ? { ...read, parts } : read
}

/** Reads split by whether each waits on its agent's own words, for the activity log to say which. */
function byOwnWords(reads: readonly DeferredRead[]): Array<[boolean, DeferredRead[]]> {
  const own = reads.filter(read => read.parts)
  const all = reads.filter(read => !read.parts)
  return ([[true, own], [false, all]] as Array<[boolean, DeferredRead[]]>).filter(([, some]) => some.length)
}

/** Why a reply stopped short of the user: see `noteInterruption`. */
type Interruption = 'user' | 'self' | 'lost' | 'failed'

function emptyNews(): ReturnNews {
  return { events: [], unheard: false }
}

/** Whether there is anything to tell: a move with nothing cut off is not news. */
function hasNews(news: ReturnNews): boolean {
  return news.events.length > 0 || news.cutOff !== undefined || news.unheard
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

/** One event as a line of the transcript's activity log: who, and what became of them. */
function eventHeadline(event: ReceptionistEvent): string {
  switch (event.kind) {
    case 'agent-stopped': return `${event.agent} is now ${event.state}`
    case 'agent-ended': return `${event.agent} ended`
    case 'agent-answer': return `${event.agent} answered "${event.question}"`
    case 'agent-answer-failed': return `asking ${event.agent} failed`
    case 'agent-images': return `${event.agent} showed you ${event.count === 1 ? 'a picture' : `${event.count} pictures`}`
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

/** A reply as the record keeps it: what was actually spoken, introductions and all, so the transcript reads as it was heard. */
function storedReply(froms: readonly string[], spoken: readonly SpokenPart[]): string {
  const say: SayPart[] = spoken.map((part, i) => ({ from: froms[i], text: part.text }))
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

/**
 * The user's words carried to the next message: see `Receptionist.carried`.
 * `unsent` is the record's entries for those of them whose message never
 * reached the session — to leave out of a recap, which repeats only what the
 * session once had. Words carried for a retry, or by a restart, may have got
 * there, and are told as said again: they have none.
 */
interface Carried {
  words: string
  /** Failed turns the words have already been through: see `MAX_TURN_RETRIES`. */
  failures: number
  unsent: readonly string[]
}

/** A turn's first message, rendered as it leaves, with whatever words were carried to it by then: see `Receptionist.ask`. */
interface OpeningMessage {
  /** The user's words it says: the turn's own, after any carried to it. */
  words: string | undefined
  failures: number
  /** The record's entries for carried words that never reached the session. */
  unsent: readonly string[]
  /** The record's entry for the turn's own words, if it has any. */
  entry: string | undefined
  render(words: string | undefined): string
}

function joinWords(before: string | undefined, after: string | undefined): string | undefined {
  return before === undefined ? after : after === undefined ? before : `${before} ${after}`
}

/** `earlier` less the user's entries in `unsent`, each matched once, latest first. */
function withoutUnsent(earlier: readonly RecordMessage[], unsent: readonly string[]): readonly RecordMessage[] {
  if (!unsent.length) return earlier
  const left = [...unsent]
  const kept: RecordMessage[] = []
  for (let i = earlier.length - 1; i >= 0; i--) {
    const message = earlier[i]
    const at = message.role === 'user' ? left.lastIndexOf(message.content) : -1
    if (at >= 0) left.splice(at, 1)
    else kept.unshift(message)
  }
  return kept
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
