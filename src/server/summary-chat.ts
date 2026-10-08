import * as fs from 'fs'
import * as path from 'path'
import { homedir } from 'os'
import { randomUUID } from 'crypto'
import { serverLog } from './server-log'
import { askClaudePrint } from './claude-print'
import type { NodeId } from '../shared/ids'
import type { ClaudeState } from '../shared/state'
import type { PendingTurn } from './pending-turn'
import { speakableToolText } from './speakable-tool-text'
import { VoiceOperator, DISCOVERY_PATH, type SpeechBackend } from './voice-operator'
import { SpeechChannel, speechFailureMessage, type Attempt, type SpeechPhase } from './speech-channel'
import type {
  SummaryChatMode, SummaryChatToggleOutcome, SummaryChatUiState,
} from '../shared/protocol'

const MAX_MESSAGES = 24
const MAX_CHARS = 48_000
const SUMMARY_CHAT_DIR = path.join(process.env.SPACETERM_HOME ?? path.join(homedir(), '.spaceterm'), 'summary-chat')
const AUDIT_PATH = path.join(SUMMARY_CHAT_DIR, 'sessions.jsonl')
const MAX_HAIKU_HISTORY_MESSAGES = 12
/**
 * How many of a run's tool calls are named individually.
 *
 * The tail, not the head: "what is it doing now" is the question a spoken
 * summary answers, and the newest calls are the ones that answer it. The rest
 * are counted rather than dropped silently — a trace that quietly truncated
 * would read as a complete account of a much smaller run.
 */
const TOOL_RUN_LISTED = 10
/** Per-call budget. Long enough to identify a target, short enough to stay speakable. */
const TOOL_TARGET_CHARS = 90
/**
 * Marks a synthetic message as a record of what the agent *did*.
 *
 * Explicit because these lines enter the same list as things the agent *said*,
 * and a summary that reports a shell command as a statement is worse than one
 * that omits it. `SUMMARY_SYSTEM_PROMPT` tells Haiku what the marker means.
 */
const TOOL_ACTIVITY_MARKER = '[agent tool activity, not speech]'
/**
 * Voices Summary Chat will never pick.
 *
 * Two lists because the two reasons age differently. A blocked *id* is a
 * judgement about one voice. A blocked *language* excludes a whole accent
 * group, and has to keep excluding it: Kokoro ids are `<language><gender>_<name>`,
 * so `h` is Hindi, and a Hindi voice added in a later Kokoro release should be
 * excluded on arrival rather than the next time someone notices one speaking.
 */
const BLOCKED_VOICE_IDS = new Set(['af_nicole'])
const BLOCKED_VOICE_LANGUAGES = new Set(['h'])

const isBlockedVoice = (id: string): boolean => {
  if (BLOCKED_VOICE_IDS.has(id)) return true
  // Only ids that actually follow the convention are read as language-tagged;
  // anything else is left to the id list, so an unrecognised naming scheme
  // cannot be silently blocked by its first letter.
  const language = /^([a-z])[fm]_/.exec(id)?.[1]
  return language !== undefined && BLOCKED_VOICE_LANGUAGES.has(language)
}
const VOICE_REFRESH_MS = 5_000
/**
 * Everything both modes' system prompts say, which is everything except the
 * opening task.
 *
 * Shared rather than duplicated because these are the rules that make an answer
 * *speakable*, and they have to hold whatever the listener asked for. Two
 * copies would drift, and the drift would be inaudible until a Verbatim
 * follow-up started reading file paths out character by character.
 */
const VOICE_STYLE_RULES = `Speak at most three concise sentences of plain English. The user can ask follow up questions, so make it clear where more info is available. Do not self-identify as the coding-agent, instead refer to it as "the agent". By default, skip repeating the user's own messages back to them, since they probably already know what they wrote. Note that you have a chunk of conversation and earlier messages may be invalidated by later ones. Focus on what the agent concluded, accomplished, is blocked on, or needs next in response to the current request. Do not recap earlier work unless it is essential to make the current answer intelligible. If the agent needs something from the user, make certain to include that information last. A message beginning "${TOOL_ACTIVITY_MARKER}" is a record of actions the agent took, not words it said: describe what it was working on and never read a command, path, or pattern aloud verbatim. Do not use markdown, lists, code, preambles, or quotation marks. Answer only with words which can be spoken.`

const SUMMARY_SYSTEM_PROMPT = `You are a fast voice companion helping a user understand a coding-agent conversation. Your first task is to summarize the coding-agent's messages in the latest "turn", which starts at the user's latest substantial message. A bare request to continue is not substantial; a short answer such as "yes" is substantial. ${VOICE_STYLE_RULES}`

/**
 * The Verbatim mode system prompt.
 *
 * A different opening because the conversation starts in a different place: the
 * listener has already heard the agent's final message read out in full, so
 * summarizing it is the one thing they did not ask for. Every request in this
 * mode is a question, including the first.
 */
const VERBATIM_SYSTEM_PROMPT = `You are a fast voice companion helping a user understand a coding-agent conversation. The listener has already heard the agent's final message read out to them word for word, so do not summarize it back to them. Your task is to answer their questions about that message and about the conversation around it, using the transcript you are given. ${VOICE_STYLE_RULES}`

/**
 * Marks where a spoken answer was cut off, in the history resent to Haiku.
 *
 * Every turn resends the whole conversation, so an answer the listener never
 * heard the end of would otherwise come back verbatim and be treated as
 * delivered. See `redactUnheard`.
 */
export const INTERRUPTED_MARKER = '*INTERRUPTED*'

/**
 * What the listener is told when the injected turn is all we have.
 *
 * Claude Code does not write an assistant turn to its transcript until that
 * turn's interactive tool resolves, so a surface parked on a question or a plan
 * has its final message only inside the running process. The hook payload
 * recovers the question or the plan — the tool's input — but nothing recovers
 * the prose the agent wrote above it. Both tools were measured; both lose it.
 *
 * Without this note a summary built from the question alone reads as a complete
 * account of the turn, which is precisely the failure that started this: a
 * spoken answer that said the agent "hadn't decided anything yet" while a fully
 * reasoned proposal sat on screen. Short, because it is spoken before every
 * word the listener actually asked for.
 */
const PENDING_TURN_CAUTION: Partial<Record<ClaudeState, string>> = {
  waiting_question: "Note: only the question is available; the agent's message before it isn't saved yet.",
  waiting_plan: "Note: only the plan is available; the agent's message before it isn't saved yet.",
}

export type TranscriptMessage = { role: 'user' | 'assistant'; text: string }
type HaikuMessage = { role: 'user' | 'assistant'; content: string }
/**
 * One request for a Haiku answer: the conversation's instructions and its
 * bounded history, ending with the new user message.
 *
 * The history is held here and resent whole, rather than kept in a Claude Code
 * session, because `redactLastAnswer` rewrites it after an interruption.
 */
export interface ModelRequest {
  instructions: string
  messages: HaikuMessage[]
}

/** Haiku's reply, and where it came from, so an answer can be traced to its Claude Code session. */
export interface ModelAnswer {
  text: string
  /** The claude-print-daemon session that produced it. Its transcript is under `~/.claude-print-daemon/work`. */
  claudeSessionId?: string
  /** How the daemon got a process for it: `spare`, `cold`, … */
  source?: string
  wallMs?: number
  costUsd?: number
}
/** What one press of the chord did, and why, if it did nothing. */
export type ToggleResult =
  | { outcome: Exclude<SummaryChatToggleOutcome, 'rejected'> }
  | { outcome: 'rejected'; message: string }

/**
 * Everything about a surface that a summary is built from, gathered by the
 * caller because only the server has it all.
 *
 * A bundle rather than four positional arguments: `prepare` took three and this
 * change would have made it five, at which point the call site stops being
 * readable and a transposed pair of optional strings compiles fine.
 */
export type SurfaceSnapshot = {
  transcriptPath?: string
  sourceAgentSessionId?: string
  /** Drives the caution note. See `PENDING_TURN_CAUTION`. */
  claudeState?: ClaudeState
  /** The un-flushed final turn, when the surface is parked on one. */
  pendingTurn?: PendingTurn
}

/** What both modes need before either will commit to anything. */
interface PreparedCommon {
  nodeId: NodeId
  transcriptPath: string
  sourceAgentSessionId?: string
  messages: TranscriptMessage[]
  /** Prefixed to the first thing spoken when set. See `PENDING_TURN_CAUTION`. */
  caution?: string
  /** Which interactive tool's input was injected, if any. Audited. */
  injectedTool?: PendingTurn['tool']
  /** Where this conversation speaks; Voice Operator on the Mac unless the press said otherwise. */
  speech?: SpeechBackend
}

/**
 * A validated request, ready to commit to.
 *
 * Discriminated on the mode rather than carrying an optional `finalMessage`,
 * because the message only exists for one of the two and an optional field
 * would let the summary path read it — or, worse, let the verbatim path find
 * it missing at the point where it is about to speak.
 */
type Prepared =
  | (PreparedCommon & { mode: 'summary' })
  | (PreparedCommon & { mode: 'verbatim'; finalMessage: string })

/**
 * A Verbatim read's Haiku setup, held until a follow-up needs it.
 *
 * The whole point of the mode is that no model runs until the listener asks
 * something, so the material a first Haiku turn would need is captured at press
 * time and parked here. Captured *then*, not rebuilt on the follow-up: the
 * listener is asking about the conversation as it stood when they heard it, and
 * an agent that kept working in the meantime would otherwise have its later
 * output silently folded into the answer.
 */
interface DeferredContext {
  /** The transcript window, already split and rendered. */
  sections: TranscriptSections
  /** Exactly the string Voice Operator was given, so offsets into it line up. */
  spoken: string
}

interface Conversation {
  auditId: string
  nodeId: NodeId
  sourceAgentSessionId?: string
  /** Which system prompt this conversation's requests carry. Fixed at creation. */
  systemPrompt: string
  haikuHistory: HaikuMessage[]
  /** Verbatim mode only, until the first follow-up consumes it. */
  deferred?: DeferredContext
  /** Prefixed to this conversation's first answer only. See `PENDING_TURN_CAUTION`. */
  caution?: string
  voice?: string
  /**
   * This conversation's playback: its phase, its speech job, and the run that
   * owns it. The phase is the single answer to "what is this surface doing" —
   * the bubble, the waiting cue and the card's speaking glow are all derived
   * from it, so none of them can disagree about whether a surface is still
   * waiting while it is already talking.
   *
   * Its backend is fixed when the conversation starts: the device that asked
   * hears the follow-ups too.
   */
  channel: SpeechChannel
  /**
   * Monotonic use counter, not a timestamp. "Most recently used" is a sequence
   * question, and two conversations started in the same millisecond used to tie
   * — leaving the target conversation up to sort stability.
   */
  lastUsedSeq: number
}

/**
 * Everything SummaryChat reaches outside its own process: Haiku, the local
 * Voice Operator over HTTP, the filesystem, and a timer. Each is narrow enough
 * to fake, which is what makes the conversation lifecycle testable without a
 * network or a model.
 */
export interface SummaryChatDeps {
  /** HTTP, for Voice Operator. Same shape as global `fetch`. */
  fetch: typeof fetch
  /** Haiku's answer to one request. Rejects on failure or abort. */
  askModel(request: ModelRequest, signal: AbortSignal): Promise<ModelAnswer>
  /** Voice Operator's discovery document, or undefined when it is not running. */
  readDiscovery(): { port?: unknown } | undefined
  /** Parse an agent transcript off disk. Returns [] when unreadable. */
  readTranscript(filePath: string): TranscriptMessage[]
  /** Audit trail. Best-effort — failures must not break a conversation. */
  audit: SummaryChatAudit
  /** Run `fn` every `ms` milliseconds. Returns a cancel function. */
  scheduleInterval(fn: () => void, ms: number): () => void
  /** Resolve after `ms` milliseconds. */
  sleep(ms: number): Promise<void>
}

export interface SummaryChatAudit {
  /** Persist the initial prompt; returns the path recorded in the audit entry. */
  writeSnapshot(auditId: string, prompt: string): string
  append(entry: Record<string, unknown>): void
}

export const REAL_SUMMARY_CHAT_AUDIT: SummaryChatAudit = {
  writeSnapshot(auditId, prompt) {
    fs.mkdirSync(SUMMARY_CHAT_DIR, { recursive: true })
    const snapshotPath = path.join(SUMMARY_CHAT_DIR, `${auditId}.initial-prompt.txt`)
    fs.writeFileSync(snapshotPath, prompt)
    return snapshotPath
  },
  append(entry) {
    try {
      fs.mkdirSync(SUMMARY_CHAT_DIR, { recursive: true })
      fs.appendFileSync(AUDIT_PATH, JSON.stringify({ timestamp: new Date().toISOString(), ...entry }) + '\n')
    } catch (err) {
      serverLog(`[summary-chat] failed to append audit: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

export const REAL_SUMMARY_CHAT_DEPS: SummaryChatDeps = {
  fetch: (...args) => fetch(...args),
  readDiscovery() {
    try {
      return JSON.parse(fs.readFileSync(DISCOVERY_PATH, 'utf8')) as { port?: unknown }
    } catch {
      return undefined
    }
  },
  async askModel(request, signal) {
    const response = await askClaudePrint({
      prompt: renderModelRequest(request),
      model: 'haiku',
      noThinking: true,
      tag: 'summary-chat',
      signal,
    })
    return {
      text: response.result,
      claudeSessionId: response.session_id,
      source: response.source,
      wallMs: response.wall_ms,
      costUsd: response.total_cost_usd,
    }
  },
  readTranscript,
  audit: REAL_SUMMARY_CHAT_AUDIT,
  scheduleInterval(fn, ms) {
    const timer = setInterval(fn, ms)
    return () => clearInterval(timer)
  },
  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}

/**
 * Owns the direct Haiku conversations which make an agent transcript speakable.
 * Each conversation is keyed by stable node id, so follow-up dictation retains
 * the original transcript and prior spoken answers.
 */
export class SummaryChat {
  /** The shared Voice Operator client, built from this instance's deps. */
  private readonly vo = new VoiceOperator({
    fetch: (...args) => this.deps.fetch(...args),
    readDiscovery: () => this.deps.readDiscovery(),
  })
  private readonly conversations = new Map<string, Conversation>()
  private voices: string[] = []
  private useCounter = 0
  private readonly cancelVoiceRefresh: () => void

  constructor(
    private readonly onSpeakingChanged: (nodeId: NodeId, speaking: boolean, voice?: string) => void,
    private readonly onStatusChanged: (nodeId: NodeId, state: SummaryChatUiState, message?: string) => void,
    private readonly deps: SummaryChatDeps = REAL_SUMMARY_CHAT_DEPS,
  ) {
    this.cancelVoiceRefresh = this.deps.scheduleInterval(() => { void this.refreshVoices() }, VOICE_REFRESH_MS)
    void this.refreshVoices()
  }

  async dispose(): Promise<void> {
    this.cancelVoiceRefresh()
    // Awaited, unlike before: quitting mid-answer used to race the process
    // exit against the DELETE, and losing that race leaves Voice Operator
    // talking on behalf of an app that no longer exists.
    await this.cancelAll()
  }

  /** The conversation unqualified Voice Operator commands currently target. */
  getTargetNodeId(): NodeId | undefined {
    return Array.from(this.conversations.values())
      .sort((a, b) => b.lastUsedSeq - a.lastUsedSeq)[0]?.nodeId
  }

  /**
   * One press of the chord: cut off whatever is being produced, or — when
   * nothing is — summarize the focused surface.
   *
   * Cancelling wins whenever anything is audible or on its way to being
   * audible, whatever surface it belongs to and whatever is focused. That is
   * the whole point of the gesture: it is the listener saying "stop", and a
   * stop that only worked on the surface you happened to be looking at would
   * leave them hunting for the one that is talking.
   */
  async toggle(
    nodeId: NodeId | undefined, snapshot: SurfaceSnapshot = {}, mode: SummaryChatMode = 'summary',
    speech?: SpeechBackend,
  ): Promise<ToggleResult> {
    if (await this.cancelAll()) return { outcome: 'cancelled' }
    if (!nodeId) return { outcome: 'rejected', message: 'Focus an agent terminal to start Summary Chat.' }
    const prepared = this.prepare(nodeId, snapshot, mode)
    if ('message' in prepared) return { outcome: 'rejected', message: prepared.message }
    prepared.speech = speech
    // Answer the press now rather than when the answer is ready. The exchange
    // takes seconds; a confirmation that waited for it would land long after
    // the gesture it is confirming, and a second press in the meantime would
    // find nothing to cancel.
    void this.run(prepared)
    return { outcome: 'started' }
  }

  /**
   * Stop every surface that is producing an answer.
   *
   * "Producing" is read off the phase, which is already the one value the whole
   * app derives from. A surface parked in `waiting_for_user` reads `ready`: the
   * job is still open but nothing is audible and nothing is pending, so a press
   * there is a request to *start*, not a request for silence that has already
   * arrived.
   *
   * Returns whether there was anything to stop — which is what makes the press
   * a toggle.
   */
  async cancelAll(): Promise<boolean> {
    const busy = Array.from(this.conversations.values()).filter(conversation => conversation.channel.isProducing())
    if (!busy.length) return false
    // Concurrently, not in sequence: cancelling a speaking job promotes the
    // next one in Voice Operator's queue, so a serial walk gives a queued job a
    // window to start talking before its own DELETE arrives.
    await Promise.all(busy.map(conversation => conversation.channel.cancel()))
    return true
  }

  /**
   * Summarize a surface, awaiting the whole exchange.
   *
   * `toggle` is the gesture; this is the operation, and it is split from the
   * gesture because they want opposite things from time. A press must be
   * answered immediately, while a caller that wants to *observe* the answer —
   * every test here — wants to await it.
   */
  async start(
    nodeId: NodeId, snapshot: SurfaceSnapshot = {}, mode: SummaryChatMode = 'summary',
    speech?: SpeechBackend,
  ): Promise<ToggleResult> {
    const prepared = this.prepare(nodeId, snapshot, mode)
    if ('message' in prepared) return { outcome: 'rejected', message: prepared.message }
    prepared.speech = speech
    await this.run(prepared)
    return { outcome: 'started' }
  }

  /** Everything a press needs before it commits to anything, or why it can't. */
  private prepare(
    nodeId: NodeId, snapshot: SurfaceSnapshot, mode: SummaryChatMode,
  ): Prepared | { message: string } {
    const { transcriptPath, sourceAgentSessionId, claudeState, pendingTurn } = snapshot
    if (!transcriptPath) {
      serverLog(`[summary-chat] ${nodeId.slice(0, 8)} has no resolved transcript`)
      return { message: 'This surface has no transcript to summarize yet.' }
    }
    const messages = this.deps.readTranscript(transcriptPath)
    // Two failures used to share one message, which hid the one that matters:
    // an empty read means the resolved path is wrong or the file has not been
    // written yet, and the path is logged so that case is diagnosable at a
    // glance. A non-empty transcript with no user turn is the genuinely
    // different "nothing to anchor a summary on" case.
    if (!messages.length) {
      serverLog(`[summary-chat] ${nodeId.slice(0, 8)} transcript ${transcriptPath} is empty or unreadable`)
      return { message: 'This surface has no transcript to summarize yet.' }
    }
    if (!messages.some(message => message.role === 'user')) {
      serverLog(`[summary-chat] ${nodeId.slice(0, 8)} transcript has no user-facing messages`)
      return { message: 'This transcript has no user messages to summarize yet.' }
    }
    // Appended after `selectSpeakable` has already chosen its window, so the
    // one message the listener is actually waiting on can never be the message
    // the budget drops — the same reasoning that exempts the anchor.
    const withPending = appendPendingTurn(messages, pendingTurn)
    const injected = withPending.length > messages.length
    if (injected) {
      serverLog(`[summary-chat] ${nodeId.slice(0, 8)} injected pending ${pendingTurn?.tool} turn (${pendingTurn?.text.length} chars)`)
    }
    const common: PreparedCommon = {
      nodeId,
      transcriptPath,
      sourceAgentSessionId,
      messages: withPending,
      caution: injected && claudeState ? PENDING_TURN_CAUTION[claudeState] : undefined,
      injectedTool: injected ? pendingTurn?.tool : undefined,
    }
    if (mode === 'summary') return { ...common, mode }
    // A turn that ended on a tool call has no final message to read. That is an
    // ordinary state for a surface still working, not a broken transcript, so
    // it gets its own refusal rather than the generic one above — the listener
    // is being told to wait, not that something is wrong.
    const finalMessage = finalAgentMessage(withPending)
    if (!finalMessage) {
      serverLog(`[summary-chat] ${nodeId.slice(0, 8)} has no finished agent message to read out`)
      return { message: "The agent hasn't finished a message to read out yet." }
    }
    return { ...common, mode, finalMessage }
  }

  private async run(prepared: Prepared): Promise<void> {
    const { nodeId, transcriptPath, sourceAgentSessionId, messages, caution, injectedTool } = prepared
    // A previous conversation on this surface may still hold an open speech job
    // even when it was idle enough not to count as busy — Voice Operator parked
    // on `waiting_for_user`, say. Nothing should outlive the answer it belongs to.
    const previous = this.conversations.get(nodeId)
    if (previous) await previous.channel.cancel()
    const sections = transcriptSections(messages)
    const conversation = this.createConversation({
      auditId: randomUUID(),
      nodeId,
      sourceAgentSessionId,
      systemPrompt: prepared.mode === 'summary' ? SUMMARY_SYSTEM_PROMPT : VERBATIM_SYSTEM_PROMPT,
      haikuHistory: [],
      caution,
      voice: this.voiceFor(nodeId),
      lastUsedSeq: ++this.useCounter,
    }, prepared.speech ?? this.vo)
    this.conversations.set(nodeId, conversation)
    this.onStatusChanged(nodeId, 'target')
    if (prepared.mode === 'verbatim') {
      // The caution joins the spoken string here for the same reason it joins a
      // Haiku answer in `askHaiku`: what is stored and what is spoken have to be
      // the same string, or every interruption offset is off by its length.
      const spoken = caution ? `${caution} ${prepared.finalMessage}` : prepared.finalMessage
      conversation.deferred = { sections, spoken }
      this.recordInitialSnapshot(conversation, transcriptPath, messages, spoken, injectedTool, 'verbatim')
      await this.speakFinalMessage(conversation, spoken)
      return
    }
    const prompt = summaryPrompt(sections)
    this.recordInitialSnapshot(conversation, transcriptPath, messages, prompt, injectedTool, 'summary')
    await this.ask(conversation, prompt, 'initial')
  }

  /**
   * Read the agent's final message out, with no model in the loop.
   *
   * Deliberately never enters `thinking`: nothing is being generated, so there
   * is nothing for spaceterm's waiting cue to announce. The surface is waiting
   * on Voice Operator from the first instant, which is what `synthesizing`
   * already means — and setting it *before* the POST is what keeps the press a
   * toggle across that window, since `isProducing` is what the cancel gesture
   * reads.
   */
  private async speakFinalMessage(conversation: Conversation, text: string): Promise<void> {
    const attempt = this.beginAttempt(conversation, 'synthesizing')
    let monitoring = false
    try {
      monitoring = await this.deliver(conversation, attempt, text)
    } finally {
      if (!monitoring) conversation.channel.settle(attempt)
    }
  }

  /**
   * Abandon every conversation: cut off anything audible and forget them, so
   * nothing is left for a follow-up to address until a new summary starts.
   */
  async end(): Promise<void> {
    const all = Array.from(this.conversations.values())
    this.conversations.clear()
    await Promise.all(all.map(conversation => conversation.channel.cancel()))
    for (const conversation of all) this.onStatusChanged(conversation.nodeId, 'ended')
  }

  async followUp(text: string): Promise<void> {
    const conversation = Array.from(this.conversations.values())
          .sort((a, b) => b.lastUsedSeq - a.lastUsedSeq)[0]
    if (!conversation) {
      serverLog('[summary-chat] voice command ignored: no active summary conversation')
      return
    }
    const heard = await conversation.channel.heardPrefix()
    const deferred = conversation.deferred
    if (deferred) {
      // The first question after a verbatim read is where this conversation
      // catches up: the transcript it was never given, and the message the
      // listener actually heard, both arrive in the same turn.
      conversation.deferred = undefined
      const audible = heard === undefined ? deferred.spoken : redactUnheard(deferred.spoken, heard)
      await this.ask(conversation, verbatimFollowUpPrompt(deferred.sections, audible, text), 'verbatim-follow-up')
      return
    }
    const redacted = heard !== undefined && this.redactLastAnswer(conversation, heard)
    const context = redacted
      ? `Your previous answer was cut off where it now reads ${INTERRUPTED_MARKER}; the listener never heard the rest, and it has been removed. `
      : ''
    await this.ask(conversation, `${context}The listener asks: ${text}`, 'follow-up')
  }

  /**
   * Trim the last answer in the resent history down to what was audible.
   *
   * Done to the stored history rather than described in the prompt: the model
   * cannot mistake an answer it can no longer see for one the listener heard,
   * whereas it demonstrably could ignore a note about a character offset while
   * the full text sat right there above it.
   *
   * Returns whether anything was actually removed.
   */
  private redactLastAnswer(conversation: Conversation, heard: number): boolean {
    const index = conversation.haikuHistory.map(message => message.role).lastIndexOf('assistant')
    if (index < 0) return false
    const spoken = conversation.haikuHistory[index].content
    const audible = redactUnheard(spoken, heard)
    if (audible === spoken) return false
    conversation.haikuHistory[index] = { role: 'assistant', content: audible }
    this.deps.audit.append({
      event: 'answer-redacted', auditId: conversation.auditId, nodeId: conversation.nodeId,
      spokenCharacters: spoken.length, heardCharacters: heard, keptCharacters: audible.length,
    })
    serverLog(`[summary-chat] ${conversation.nodeId.slice(0, 8)} redacted ${spoken.length - audible.length} unheard chars`)
    return true
  }

  /**
   * Build a conversation around its speech channel.
   *
   * The channel's callbacks need the conversation (for its node and voice), and
   * the conversation holds the channel, so one is finished after the other.
   */
  private createConversation(fields: Omit<Conversation, 'channel'>, speech: SpeechBackend): Conversation {
    const conversation = fields as Conversation
    conversation.channel = new SpeechChannel({
      speech,
      label: `[summary-chat] ${fields.nodeId.slice(0, 8)}`,
      onPhase: (phase, previous) => this.phaseChanged(conversation, phase, previous),
      onFailure: (failure) => this.onStatusChanged(conversation.nodeId, 'error', speechFailureMessage(failure, 'the summary')),
      deps: {
        sleep: (ms) => this.deps.sleep(ms),
        voiceOperatorDiscovered: () => Boolean(this.deps.readDiscovery()),
      },
    })
    return conversation
  }

  /**
   * Turn one phase change into both public signals, in a fixed order, so a
   * listener that watches only one of them still sees a coherent lifecycle.
   *
   * The speaking indicator stays tied to `speaking` alone. `synthesizing` is a
   * wait, not sound, and lighting the indicator on it would claim a surface was
   * talking through the seconds before it makes any noise.
   */
  private phaseChanged(conversation: Conversation, phase: SpeechPhase, previous: SpeechPhase): void {
    if (phase === 'speaking') this.onSpeakingChanged(conversation.nodeId, true, conversation.voice)
    else if (previous === 'speaking') this.onSpeakingChanged(conversation.nodeId, false)
    this.onStatusChanged(conversation.nodeId, phase)
  }

  /** Start a run on a conversation, which also makes it the follow-up target. */
  private beginAttempt(conversation: Conversation, phase: 'thinking' | 'synthesizing'): Attempt {
    conversation.lastUsedSeq = ++this.useCounter
    return conversation.channel.begin(phase)
  }

  /** Speak one answer in this conversation's voice. See `SpeechChannel.deliver`. */
  private deliver(conversation: Conversation, attempt: Attempt, text: string): Promise<boolean> {
    // The Voice Operator may have appeared after this chat started. Lock a
    // deterministic voice as soon as its voice list becomes available.
    conversation.voice ??= this.voiceFor(conversation.nodeId)
    return conversation.channel.deliver(attempt, text, conversation.voice)
  }

  private async ask(
    conversation: Conversation, prompt: string, kind: AskKind,
  ): Promise<void> {
    const attempt = this.beginAttempt(conversation, 'thinking')
    let monitoring = false
    try {
      // Initial only. On a follow-up the listener has already been warned, and
      // repeating it every turn would cost them the warning's meaning.
      const { text, from } = await this.askHaiku(
        conversation, prompt, attempt, kind === 'initial' ? conversation.caution : undefined,
      )
      serverLog(`[summary-chat] ${conversation.nodeId.slice(0, 8)} ${kind} answered by claude-print-daemon session ${from.claudeSessionId ?? '?'} (${from.source ?? '?'}, ${from.wallMs ?? '?'}ms, $${from.costUsd?.toFixed(4) ?? '?'})`)
      // Audited before the ownership check: the request was made and the tokens
      // were spent, whether or not anyone still wants the answer.
      this.deps.audit.append({
        event: 'haiku-response', auditId: conversation.auditId, nodeId: conversation.nodeId,
        kind, provider: 'claude-print-daemon', responseCharacters: text.length,
        claudeSessionId: from.claudeSessionId ?? null, source: from.source ?? null,
        wallMs: from.wallMs ?? null, costUsd: from.costUsd ?? null,
        // The text itself, not just its length. Whether the answer was worth
        // hearing is the first question asked when nothing comes out of the
        // speakers, and a character count cannot answer it.
        responseText: text,
      })
      if (!attempt.isCurrent || !text) return
      monitoring = await this.deliver(conversation, attempt, text)
    } catch (err) {
      // A cancelled request is not a failure. Reporting one would put an error
      // toast on screen every time the listener deliberately cut an answer off.
      if (!attempt.isCurrent) return
      const message = err instanceof Error ? err.message : String(err)
      serverLog(`[summary-chat] ${conversation.nodeId.slice(0, 8)} Haiku failed: ${message}`)
      this.deps.audit.append({
        event: 'haiku-failed', auditId: conversation.auditId, nodeId: conversation.nodeId,
        kind, provider: 'claude-print-daemon', error: message,
      })
      this.onStatusChanged(conversation.nodeId, 'error', 'Summary Chat could not reach Haiku.')
    } finally {
      // Only the owner settles. A superseded or cancelled attempt leaves the
      // phase to whoever took the conversation from it.
      if (!monitoring) conversation.channel.settle(attempt)
    }
  }

  /**
   * Ask Haiku, through claude-print-daemon's warm Haiku spare. Every request
   * starts a fresh Claude Code session carrying the whole bounded history,
   * because the history is ours to edit: see `ModelRequest`.
   */
  private async askHaiku(
    conversation: Conversation, prompt: string, attempt: Attempt, caution?: string,
  ): Promise<{ text: string; from: Omit<ModelAnswer, 'text'> }> {
    const pending: HaikuMessage = { role: 'user', content: prompt }
    const messages = boundedHaikuHistory([...conversation.haikuHistory, pending])
    const { text: raw, ...from } = await this.deps.askModel(
      { instructions: conversation.systemPrompt, messages },
      // Two ways to stop waiting: the request took too long, or nobody wants
      // the answer any more.
      AbortSignal.any([attempt.signal, AbortSignal.timeout(30_000)]),
    )
    const text = raw.trim()
    if (!text) throw new Error('Haiku returned no text')
    // The caution joins the answer here, before it is either stored or spoken,
    // so the stored string and the spoken string stay the same string.
    // `redactUnheard` maps Voice Operator's `character_offset` onto the stored
    // answer; speaking a prefix that the history does not contain would shift
    // every interruption offset by its length, silently.
    const answer = caution ? `${caution} ${text}` : text
    conversation.haikuHistory = boundedHaikuHistory([...conversation.haikuHistory, pending, { role: 'assistant', content: answer }])
    return { text: answer, from }
  }

  /**
   * Persist what this summary was built from.
   *
   * `messageCount` against a snapshot of the prompt is what made the un-flushed
   * turn diagnosable at all — a surface mid-proposal audited as two messages,
   * and the prompt file proved Haiku had never been shown the question. Naming
   * the injected tool keeps that diagnosis a field lookup rather than an
   * investigation the next time a spoken answer sounds wrong.
   */
  private recordInitialSnapshot(
    conversation: Conversation, transcriptPath: string, messages: TranscriptMessage[], prompt: string,
    injectedTool: PendingTurn['tool'] | undefined, mode: SummaryChatMode,
  ): void {
    try {
      const snapshotPath = this.deps.audit.writeSnapshot(conversation.auditId, prompt)
      const messageCharacters = messages.reduce((total, message) => total + message.text.length, 0)
      this.deps.audit.append({
        event: 'started', auditId: conversation.auditId, nodeId: conversation.nodeId, mode,
        sourceAgentSessionId: conversation.sourceAgentSessionId ?? null,
        transcriptPath, snapshotPath, messageCount: messages.length,
        messageCharacters, promptCharacters: prompt.length,
        injectedTool: injectedTool ?? null, caution: conversation.caution ?? null,
      })
    } catch (err) {
      serverLog(`[summary-chat] failed to record audit snapshot: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  private async refreshVoices(): Promise<void> {
    const response = await this.vo.voices()
    const body = response?.status === 200 ? response.body as { voices?: Array<{ id?: string }> } : undefined
    const voices = body?.voices
      ?.map(voice => voice.id)
      .filter((id): id is string => id !== undefined && id !== '' && !isBlockedVoice(id))
      .sort() ?? []
    if (voices.length) this.voices = voices
  }

  private voiceFor(nodeId: NodeId): string | undefined {
    if (!this.voices.length) return undefined
    let hash = 0
    for (const char of nodeId) hash = ((hash * 31) + char.charCodeAt(0)) >>> 0
    return this.voices[hash % this.voices.length]
  }

}

/** What one Haiku request is for. Gates the caution, and named in the audit. */
type AskKind = 'initial' | 'follow-up' | 'verbatim-follow-up'

/**
 * The transcript window, split at the turn boundary and rendered.
 *
 * Rendered once and kept, rather than rebuilt per prompt, because Verbatim mode
 * captures it at press time and spends it on a question that may not arrive for
 * minutes. Both modes phrase their prompt around the same two blocks.
 */
interface TranscriptSections {
  background: string
  turn: string
}

function transcriptSections(messages: TranscriptMessage[]): TranscriptSections {
  const anchor = latestSubstantialUserMessage(messages)
  const format = (items: TranscriptMessage[]): string => items
    .map(message => `${message.role.toUpperCase()}: ${message.text}`)
    .join('\n\n')
  return {
    background: format(messages.slice(0, anchor)) || '(none)',
    turn: format(messages.slice(anchor)),
  }
}

function summaryPrompt({ background, turn }: TranscriptSections): string {
  return `BACKGROUND CONTEXT is only for disambiguation and for preparing to answer follow-up voice questions.

BACKGROUND CONTEXT:
${background}

CURRENT TURN TO SUMMARIZE:
${turn}`
}

/**
 * The first — and only the first — Haiku turn of a Verbatim conversation.
 *
 * The final message appears twice on purpose: once where it belongs in the
 * transcript, and again as the thing the listener heard. The duplication is
 * what survives an interruption. Quoting only the audible part would hide the
 * rest of the message from the model, and the listener's very next question is
 * usually about exactly that rest — "what was it going to say?". Quoting only
 * the transcript copy would lose the other half of the answer: where they
 * stopped it, and therefore what they already know.
 */
function verbatimFollowUpPrompt(
  { background, turn }: TranscriptSections, heard: string, question: string,
): string {
  const cut = heard.includes(INTERRUPTED_MARKER)
    ? `, cut off where it reads ${INTERRUPTED_MARKER} — they stopped it there and never heard the rest`
    : ''
  return `BACKGROUND CONTEXT is only for disambiguation.

BACKGROUND CONTEXT:
${background}

CURRENT TURN:
${turn}

The listener has just heard the agent's final message read aloud word for word${cut}. This is what reached them:

${heard}

The listener asks: ${question}`
}

/**
 * A plain "continue" extends the previous task; it should not cause a spoken
 * recap to be anchored on that single-word instruction. We intentionally keep
 * this narrow: terse but meaningful replies such as "yes" remain substantial.
 */
function latestSubstantialUserMessage(messages: TranscriptMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message.role === 'user' && !isBareContinuation(message.text)) return index
  }
  return messages.map(message => message.role).lastIndexOf('user')
}

function isBareContinuation(text: string): boolean {
  return /^(?:please\s+)?(?:continue|keep going|go on|proceed)(?:\s+please)?[.!…]*$/i.test(text.trim())
}

/**
 * Rewrite a spoken answer to only the part the listener actually heard.
 *
 * `askHaiku` resends the whole history on every turn, so an answer that was
 * cut off mid-flow would keep being presented to
 * Haiku as though all of it had been delivered. It would then answer "as I
 * said…" about words nobody heard. Redacting the tail is what makes the resent
 * history match the listener's experience.
 *
 * The marker takes the place of the word the voice was cut off in, and
 * everything after it goes. Voice Operator reports where its voice actually
 * stopped, down to the word, and the whole value of that resolution is that
 * stopping three words from the end of a long sentence is recorded as hearing
 * nearly all of it rather than none of it — which is what a listener who
 * interrupts to ask "wait, what was that last bit?" is relying on.
 *
 * The reported offset is the *end* of the word that was in progress: Voice
 * Operator counts a word as heard once it has started, so that the offset and
 * the word its reading overlay had lit up are the same word. Which makes that
 * last word the uncertain one, and dropping it puts the marker where the
 * listener's attention was actually cut. This is deliberately conservative in
 * one direction — a word that had in fact just finished is dropped too — which
 * is the right way to be wrong: a marker slightly early reads as "they were
 * around here", while a word they only half heard, presented as delivered,
 * invites the next answer to build on something they never got.
 *
 * A "word" is a run of non-whitespace, so `src/main.ts` is one thing to hear
 * rather than three and is dropped whole rather than leaving a `src/ma`.
 */
export function redactUnheard(text: string, heard: number): string {
  if (heard >= text.length) return text
  const spoken = text.slice(0, interruptedWordStart(text, Math.max(0, heard))).trim()
  return spoken ? `${spoken} ${INTERRUPTED_MARKER}` : INTERRUPTED_MARKER
}

/**
 * Where the word the voice was cut off in begins.
 *
 * A word's end offset points at whatever follows the word — a space, a comma —
 * never at the start of the next word, since a word and its successor are
 * separated by the whitespace that defines them. So a cut sitting immediately
 * after whitespace did not come from a word ending: it is a whole-sentence
 * offset, from an older Voice Operator or from a sentence that finished before
 * the interruption, and the sentence it completes is left whole.
 *
 * Anything else is inside or just past a word, and that word is the one the
 * marker replaces.
 */
export function interruptedWordStart(text: string, at: number): number {
  if (at === 0 || /\s/.test(text[at - 1])) return at
  let start = at
  while (start > 0 && !/\s/.test(text[start - 1])) start--
  return start
}

function boundedHaikuHistory(history: HaikuMessage[]): HaikuMessage[] {
  if (history.length <= MAX_HAIKU_HISTORY_MESSAGES) return history
  // Keep the initial prompt (which contains the focused transcript) and the
  // newest exchanges; this preserves grounding without unbounded request size.
  return [history[0], ...history.slice(-(MAX_HAIKU_HISTORY_MESSAGES - 1))]
}

/**
 * A `ModelRequest` as the single user message of a fresh Claude Code session.
 *
 * Claude Code's system prompt is left empty and the instructions travel here,
 * so every request can share the daemon's one warm Haiku spare. Earlier turns
 * are quoted as a transcript, and the reply is asked for the last message only.
 */
export function renderModelRequest(request: ModelRequest): string {
  const earlier = request.messages.slice(0, -1)
  const latest = request.messages[request.messages.length - 1]
  const parts = [`<instructions>\n${request.instructions}\n</instructions>`]
  if (earlier.length) {
    const turns = earlier.map(m => m.role === 'user' ? `<user>\n${m.content}\n</user>` : `<you>\n${m.content}\n</you>`)
    parts.push(`<conversation_so_far>\n${turns.join('\n')}\n</conversation_so_far>`)
    parts.push('Reply to the latest message below, following the instructions and continuing the conversation so far.')
  }
  parts.push(latest.content)
  return parts.join('\n\n')
}

export function readTranscript(filePath: string): TranscriptMessage[] {
  let raw: string
  try { raw = fs.readFileSync(filePath, 'utf8') } catch { return [] }
  return parseTranscript(raw)
}

/**
 * Select the speakable messages from a raw JSONL transcript.
 *
 * Split from readTranscript so the selection rules — which agent shapes count
 * as human speech, and how much backwards context fits — can be tested against
 * fixture text rather than files on disk.
 */
export function parseTranscript(raw: string): TranscriptMessage[] {
  return selectSpeakable(parseWholeTranscript(raw))
}

/**
 * Every message in a transcript, in the same shape `readTranscript` gives but
 * without its window — for searching the early hours of a long session.
 */
export function readWholeTranscript(filePath: string): TranscriptMessage[] {
  let raw: string
  try { raw = fs.readFileSync(filePath, 'utf8') } catch { return [] }
  return parseWholeTranscript(raw)
}

export function parseWholeTranscript(raw: string): TranscriptMessage[] {
  const extracted: Extracted[] = []
  for (const line of raw.split('\n')) {
    if (!line) continue
    try {
      extracted.push(...extractEntry(JSON.parse(line) as Record<string, any>))
    } catch { /* Ignore a partial JSONL write. */ }
  }
  return coalesceToolRuns(extracted)
}

/**
 * One tool call, reduced to what a listener would want to hear about it.
 *
 * The name alone is nearly useless — "the agent ran thirty-five Bash commands"
 * describes a night of work and a typo equally well. The target is what carries
 * the meaning, so it is kept and bounded rather than dropped.
 */
type ToolCall = { name: string; target?: string }

/**
 * What one transcript entry yields.
 *
 * Two kinds because tool calls have to be *coalesced* before they can become
 * messages, and coalescing needs to see the run. An entry can yield both: an
 * agent that says something and then calls a tool writes one entry per block,
 * but older transcripts put them together.
 */
type Extracted =
  | { kind: 'message'; role: 'user' | 'assistant'; text: string }
  | { kind: 'tools'; calls: ToolCall[] }

/**
 * Turn runs of tool calls into one synthetic assistant message each.
 *
 * Coalescing is the whole point. A long unattended run is exactly what a spoken
 * summary is most useful for, and it is also the run with the least prose: one
 * observed turn spent six minutes on 35 shell calls and 24 thinking blocks
 * while emitting a single sentence, so the transcript offered two speakable
 * messages and Haiku correctly reported that nothing had been decided. Emitting
 * one message *per call* would have been worse than nothing — 35 messages would
 * have consumed the entire budget and pushed the prose out of the window.
 *
 * Thinking blocks cannot help here: the transcript stores a signature with the
 * text empty, so there is nothing in them to read.
 */
function coalesceToolRuns(items: Extracted[]): TranscriptMessage[] {
  const messages: TranscriptMessage[] = []
  let run: ToolCall[] = []
  const flush = (): void => {
    if (!run.length) return
    messages.push({ role: 'assistant', text: renderToolRun(run) })
    run = []
  }
  for (const item of items) {
    if (item.kind === 'tools') { run.push(...item.calls); continue }
    // Prose closes the run it follows, so the trace stays in step with the
    // narration around it rather than collapsing a whole turn into one blob.
    flush()
    messages.push({ role: item.role, text: item.text })
  }
  flush()
  return messages
}

function renderToolRun(calls: ToolCall[]): string {
  const counts = new Map<string, number>()
  for (const call of calls) counts.set(call.name, (counts.get(call.name) ?? 0) + 1)
  const tally = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name, count]) => (count > 1 ? `${name} x${count}` : name))
    .join(', ')
  const listed = calls.slice(-TOOL_RUN_LISTED)
  const omitted = calls.length - listed.length
  const plural = (n: number): string => (n === 1 ? 'call' : 'calls')
  const header = `${TOOL_ACTIVITY_MARKER} ${calls.length} ${plural(calls.length)}: ${tally}.`
  const elision = omitted ? `\n(${omitted} earlier ${plural(omitted)} not listed.)` : ''
  const lines = listed.map(call => (call.target ? `- ${call.name}: ${call.target}` : `- ${call.name}`))
  return `${header}${elision}\n${lines.join('\n')}`
}

/**
 * The most identifying string in a tool's input.
 *
 * A priority-ordered key sweep rather than a per-tool table: the table would be
 * a second list of tool names to keep in step with Claude Code, and would go
 * quietly wrong for every tool added after it was written. This ordering reads
 * the right field for each of the tools that actually appear — `file_path` for
 * Read and Edit, `pattern` for Grep and Glob, `command` for Bash, `url` for
 * WebFetch, `description` for Task — and degrades to "no target" rather than to
 * a wrong one.
 */
const TOOL_TARGET_KEYS = [
  'file_path', 'notebook_path', 'pattern', 'command', 'url', 'path', 'description', 'query', 'prompt',
]

function toolTarget(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined
  for (const key of TOOL_TARGET_KEYS) {
    const raw = (input as Record<string, unknown>)[key]
    // Codex passes a shell invocation as an argv array; everything else is a
    // string. Both describe one target, so both render as one.
    const value = Array.isArray(raw)
      ? raw.filter((part): part is string => typeof part === 'string').join(' ')
      : raw
    if (typeof value !== 'string' || !value.trim()) continue
    // Commands are routinely multi-line. A trace that kept the newlines would
    // break the one-line-per-call shape this is readable because of.
    const collapsed = value.trim().replace(/\s+/g, ' ')
    return collapsed.length > TOOL_TARGET_CHARS ? `${collapsed.slice(0, TOOL_TARGET_CHARS)}…` : collapsed
  }
  return undefined
}

/**
 * Narrow a whole transcript to the window Haiku is handed.
 *
 * One message is not optional: the latest user message. It is the *anchor* —
 * what `initialPrompt` splits the turn on, and what `prepare` looks for before
 * it will summarize anything at all. Everything else is history, and history
 * competes for a budget newest-first: the agent's most recent output, which is
 * what the listener is asking about, then older background if room remains.
 *
 * The anchor used to be exempt from `MAX_CHARS` only, which read as that
 * invariant without being it — `MAX_MESSAGES` still applied to it. A surface
 * whose latest turn ran past 24 agent messages, which is exactly the long
 * unattended run a spoken summary is most useful for, therefore selected 24
 * assistant messages and no user message, and the chord rejected it as having
 * "no user messages to summarize yet". Exempting the anchor from *both* caps is
 * what makes the invariant true, and holding every other message to the same
 * two caps is what keeps the rule small enough to state.
 */
function selectSpeakable(all: TranscriptMessage[]): TranscriptMessage[] {
  const anchor = all.map(message => message.role).lastIndexOf('user')
  if (anchor < 0) return []
  const kept = new Set<number>([anchor])
  // The anchor is exempt, and that now means exempt rather than merely
  // un-evictable. It used to be kept *and* charged, which let a long pasted
  // user message spend the whole budget on itself and leave the agent's reply
  // — the thing the listener actually pressed the key to hear — outside the
  // window. Exempting it costs at most one message's overrun, which is the
  // price the exemption was always going to have.
  let chars = 0
  /** Take one message if both budgets allow; false means this direction is done. */
  const admit = (index: number): boolean => {
    if (kept.has(index)) return true
    if (kept.size >= MAX_MESSAGES) return false
    if (chars + all[index].text.length > MAX_CHARS) return false
    kept.add(index)
    chars += all[index].text.length
    return true
  }
  // The agent's final message goes in before anything else competes for room.
  // It is what a summary is about and what a verbatim read *is*, so it is the
  // last thing that should lose a budget fight — but it still fights, because a
  // run of two hundred prose entries is a real transcript shape and exempting
  // it outright would hand Haiku the whole history.
  const run = finalAgentRun(all, anchor)
  for (let i = run.length - 1; i >= 0; i--) if (!admit(run[i])) break
  for (let i = all.length - 1; i > anchor; i--) if (!admit(i)) break
  for (let i = anchor - 1; i >= 0; i--) if (!admit(i)) break
  return Array.from(kept).sort((a, b) => a - b).map(index => all[index])
}

/**
 * Indices of the trailing run of agent prose, newest-last.
 *
 * "The agent's final message" is a run rather than one entry because Claude Code
 * writes each content block as its own transcript entry: a message interrupted
 * by nothing at all still arrives in pieces. The run ends at the first thing
 * that is not the agent talking — a user turn, or a record of work it did — so
 * a reply is rejoined while the tool calls that preceded it stay out.
 *
 * Stops at `after` so it can never reach back past the anchor, which is what
 * keeps a transcript with no agent reply from returning the whole history.
 */
function finalAgentRun(all: TranscriptMessage[], after = -1): number[] {
  const run: number[] = []
  for (let i = all.length - 1; i > after; i--) {
    const message = all[i]
    if (message.role !== 'assistant') break
    if (isToolActivity(message)) break
    run.unshift(i)
  }
  return run
}

/**
 * The agent's final message, as one speakable string, or '' when its last act
 * was a tool call rather than a sentence.
 *
 * An empty result is an ordinary state — the agent is still working — and the
 * caller reports it as such rather than as an unreadable transcript.
 */
export function finalAgentMessage(messages: TranscriptMessage[]): string {
  return finalAgentRun(messages).map(index => messages[index].text).join('\n\n')
}

/** Whether a message is a record of tool calls rather than words the agent wrote. */
export function isToolActivity(message: TranscriptMessage): boolean {
  return message.role === 'assistant' && message.text.startsWith(TOOL_ACTIVITY_MARKER)
}

/**
 * The agent's last words, even when tool calls came after them — '' only when
 * nothing it wrote since the last user turn. An agent that says "committing
 * and ending now" and then self-terminates leaves no message after its last
 * tool call, and `finalAgentMessage` would report that as silence.
 */
export function lastAgentProse(messages: TranscriptMessage[]): string {
  let end = messages.length
  while (end > 0 && isToolActivity(messages[end - 1])) end--
  return finalAgentMessage(messages.slice(0, end))
}

/**
 * Add the un-flushed turn to the window, unless the transcript already has it.
 *
 * The dedupe is not defensive padding: a chord pressed just after the listener
 * answers finds the cache still populated *and* the transcript finally written,
 * and appending then would hand Haiku the same question twice and invite it to
 * report two of them. Matching on rendered text is what makes that comparable
 * at all — `speakableToolText` renders the hook payload and the transcript
 * block through one function precisely so these two strings are identical.
 */
function appendPendingTurn(
  messages: TranscriptMessage[],
  pending: PendingTurn | undefined,
): TranscriptMessage[] {
  if (!pending) return messages
  if (messages.some(message => message.role === 'assistant' && message.text === pending.text)) return messages
  return [...messages, { role: 'assistant', text: pending.text }]
}

function extractEntry(entry: Record<string, any>): Extracted[] {
  // Claude's transcript shape, and Cursor's, which differ only in whether the
  // role sits on `type` or `role`.
  const role = entry.type === 'user' || entry.type === 'assistant' ? entry.type
    : entry.role === 'user' || entry.role === 'assistant' ? entry.role
      : undefined
  if (role && entry.message) return fromContent(role, entry.message.content)
  // Codex writes a separate canonical user_message event. Using it avoids
  // accidentally treating its injected environment/developer context as human
  // speech. Assistant output remains in response_item messages.
  if (entry.type === 'event_msg' && entry.payload?.type === 'user_message' && typeof entry.payload.message === 'string') {
    const text = entry.payload.message.trim()
    return text ? [{ kind: 'message', role: 'user', text }] : []
  }
  // Codex rollout shape. Its current recorder emits a human turn as a
  // response_item message, rather than the older user_message event above.
  // Do not accept every `role: user` item: Codex injects environment context
  // through that same role. `user.text` is the recorder's explicit marker for
  // text the human supplied, and keeps that setup out of the spoken history.
  if (entry.type === 'response_item' && entry.payload?.type === 'message') {
    if (entry.payload.role === 'assistant') return fromContent('assistant', entry.payload.content)
    if (entry.payload.role === 'user' && isCodexHumanMessage(entry.payload)) {
      return fromContent('user', entry.payload.content)
    }
    return []
  }
  // Codex records a tool call as its own entry, with the input as a JSON string
  // rather than an object — the one shape difference that matters here.
  if (entry.type === 'response_item' && entry.payload?.type === 'function_call') {
    const call = codexFunctionCall(entry.payload)
    return call ? [{ kind: 'tools', calls: [call] }] : []
  }
  return []
}

/** Whether a Codex `response_item` user message is actual human input. */
function isCodexHumanMessage(payload: Record<string, any>): boolean {
  const kinds = payload.internal_chat_message_metadata_passthrough?.content_item_kinds
  return Array.isArray(kinds) && kinds.includes('user.text')
}

function codexFunctionCall(payload: Record<string, any>): ToolCall | undefined {
  if (typeof payload.name !== 'string' || !payload.name) return undefined
  let input: unknown
  try {
    input = typeof payload.arguments === 'string' ? JSON.parse(payload.arguments) : payload.arguments
  } catch { /* An unparseable argument string still leaves a usable tool name. */ }
  return { name: payload.name, target: toolTarget(input) }
}

/**
 * Split one message's content blocks into what was said and what was done.
 *
 * The two are separated here rather than downstream because only this point can
 * see both: `speakableToolText` promotes the handful of tools whose input *is*
 * the message back into speech, and everything else it declines becomes
 * activity. Without that split a plan would be filed as a shell command, and a
 * shell command would be quoted as though the agent had said it.
 */
function fromContent(role: 'user' | 'assistant', content: unknown): Extracted[] {
  if (typeof content === 'string') {
    const text = content.trim()
    return text ? [{ kind: 'message', role, text }] : []
  }
  if (!Array.isArray(content)) return []
  const spokenParts: string[] = []
  const calls: ToolCall[] = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    const type = (block as { type?: unknown }).type
    if (type === 'text' || type === 'input_text' || type === 'output_text') {
      const text = (block as { text?: unknown }).text
      if (typeof text === 'string' && text.trim()) spokenParts.push(text.trim())
      continue
    }
    if (type !== 'tool_use') continue
    const { name, input } = block as { name?: unknown; input?: unknown }
    const spoken = speakableToolText(name, input)
    if (spoken) { spokenParts.push(spoken); continue }
    // Only the agent acts. A `tool_use` under a user role would be a shape this
    // code does not understand, and inventing activity from it would be worse
    // than ignoring it.
    if (role === 'assistant' && typeof name === 'string' && name) {
      calls.push({ name, target: toolTarget(input) })
    }
  }
  const out: Extracted[] = []
  // Speech first: an agent narrates, then acts, and the trace reads as the
  // consequence of the sentence above it.
  if (spokenParts.length) out.push({ kind: 'message', role, text: spokenParts.join('\n\n') })
  if (calls.length) out.push({ kind: 'tools', calls })
  return out
}
