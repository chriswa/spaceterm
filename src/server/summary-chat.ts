import * as fs from 'fs'
import * as path from 'path'
import { homedir, userInfo } from 'os'
import { randomUUID } from 'crypto'
import { execFileSync } from 'child_process'
import { serverLog } from './server-log'
import type { NodeId } from '../shared/ids'
import type { ClaudeState } from '../shared/state'
import type { PendingTurn } from './pending-turn'
import { speakableToolText } from './speakable-tool-text'
import type { SummaryChatPhase, SummaryChatToggleOutcome, SummaryChatUiState } from '../shared/protocol'

const DISCOVERY_PATH = path.join(homedir(), 'Library', 'Application Support', 'VoiceOperator', 'speech-service.json')
const MAX_MESSAGES = 24
const MAX_CHARS = 48_000
const SUMMARY_CHAT_DIR = path.join(process.env.SPACETERM_HOME ?? path.join(homedir(), '.spaceterm'), 'summary-chat')
const AUDIT_PATH = path.join(SUMMARY_CHAT_DIR, 'sessions.jsonl')
const HAIKU_URL = 'https://api.anthropic.com/v1/messages'
const HAIKU_MODEL = 'claude-haiku-4-5-20251001'
const MAX_HAIKU_HISTORY_MESSAGES = 12
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
const SPEECH_LONG_POLL_TIMEOUT_MS = 5 * 60_000
/** How long Voice Operator holds a long poll open, in seconds. */
const SPEECH_LONG_POLL_SECONDS = 30
const VOICE_REFRESH_MS = 5_000
/**
 * Time between speech-status polls.
 *
 * Two jobs. While the monitor is tracking playback it is the *cadence*, and so
 * the worst-case lag on synthesizing → speaking → idle: 250ms is under the
 * threshold where an indicator reads as late. While the monitor is
 * long-polling it is a *floor* — a Voice Operator that answers `?wait=`
 * immediately (an older build, or one that has lost its job queue) would
 * otherwise spin this loop as fast as the event loop allows.
 */
const SPEECH_POLL_INTERVAL_MS = 250
/**
 * How long a job may sit accepted-but-silent before the monitor says so.
 *
 * Voice Operator answering `queued` forever is a real failure with no natural
 * end: the surface sits in `synthesizing`, the menu bar keeps its cyan, and
 * nothing times out. It is also a *silent* failure on this side now — the
 * waiting cue belongs to Voice Operator from the handoff on — so the log line
 * is the only place it surfaces at all.
 *
 * Necessarily longer than one long-poll cycle. The monitor learns nothing until
 * a poll returns, and a poll parks for `SPEECH_LONG_POLL_SECONDS` when nothing
 * changes — so a threshold below that can never be reached, and the first
 * observation would report the transition instead. This has to mean "still
 * queued after a full cycle went by with no change", which is the shape of the
 * failure worth a line of its own.
 */
const SPEECH_STALL_REPORT_MS = (SPEECH_LONG_POLL_SECONDS + 15) * 1_000
const SUMMARY_SYSTEM_PROMPT = `You are a fast voice companion helping a user understand a coding-agent conversation. Your first task is to summarize the coding-agent's messages in the latest "turn", which starts at the user's latest substantial message. A bare request to continue is not substantial; a short answer such as "yes" is substantial. Speak at most three concise sentences of plain English. The user can ask follow up questions, so make it clear where more info is available. Do not self-identify as the coding-agent, instead refer to it as "the agent". By default, skip summarizing the user's messages, since they probably already know what they wrote. Note that you have a chunk of conversation and earlier messages may be invalidated by later ones. Focus on what the agent concluded, accomplished, is blocked on, or needs next in response to that current request. Do not recap earlier work unless it is essential to make the current-turn answer intelligible. If the agent needs something from the user, make certain to include that information last. Do not use markdown, lists, code, preambles, or quotation marks. Answer only with words which can be spoken.`

/**
 * Marks where a spoken answer was cut off, in the history resent to Haiku.
 *
 * The Messages API is stateless: every turn resends the whole conversation, so
 * an answer the listener never heard the end of would otherwise come back
 * verbatim and be treated as delivered. See `redactUnheard`.
 */
const INTERRUPTED_MARKER = '*INTERRUPTED*'

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
type SpeechStatus = {
  id: string
  state: 'in_progress' | 'completed' | 'interrupted_by_user' | 'cancelled_by_client' | 'synthesis_failed'
  playback_state?: 'queued' | 'speaking' | 'waiting_for_user'
  character_offset?: number
  /**
   * Voice Operator's change cursor for this job, bumped on every observable
   * change. Absent on services predating it — see `monitorSpeech`, which falls
   * back to the polling cadence that cursor replaced.
   */
  version?: number
}

/** What one press of the chord did, and why, if it did nothing. */
export type ToggleResult =
  | { outcome: Exclude<SummaryChatToggleOutcome, 'rejected'> }
  | { outcome: 'rejected'; message: string }

/**
 * One run of `ask` — a Haiku request, the speech job it produces, and the
 * monitor that watches that job play out.
 *
 * Every `await` in that chain resumes into a world which may have moved on: the
 * listener may have cancelled, or started a newer answer on the same surface.
 * The point of this object is that all of those resumption points ask the *same
 * question of the same thing*. They used to each invent their own staleness
 * test, and only some of them had one at all — which is how a cancel arriving
 * between Haiku answering and the speech POST returning produced a job nobody
 * owned, still talking at a listener who had asked for silence.
 */
class Attempt {
  private readonly controller = new AbortController()

  constructor(private readonly conversation: Conversation) {}

  /** Cancels the in-flight HTTP request this attempt is waiting on, if any. */
  get signal(): AbortSignal { return this.controller.signal }

  /**
   * Whether this attempt still owns its conversation. False once it has been
   * cancelled, superseded, or has settled — so a resumption point that reads
   * false must touch nothing, because someone else already has.
   */
  get isCurrent(): boolean { return this.conversation.attempt === this }

  /** Give up ownership. Aborting is what unblocks a parked long poll. */
  abandon(): void {
    if (this.isCurrent) this.conversation.attempt = undefined
    this.controller.abort()
  }
}

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

/** A validated summary request, ready to commit to. */
interface Prepared {
  nodeId: NodeId
  transcriptPath: string
  sourceAgentSessionId?: string
  messages: TranscriptMessage[]
  /** Prefixed to the initial answer when set. See `PENDING_TURN_CAUTION`. */
  caution?: string
  /** Which interactive tool's input was injected, if any. Audited. */
  injectedTool?: PendingTurn['tool']
}

interface Conversation {
  auditId: string
  nodeId: NodeId
  sourceAgentSessionId?: string
  haikuHistory: HaikuMessage[]
  /** Prefixed to this conversation's first answer only. See `PENDING_TURN_CAUTION`. */
  caution?: string
  voice?: string
  speechId?: string
  /** The run currently allowed to act on this conversation. See `Attempt`. */
  attempt?: Attempt
  /**
   * The single answer to "what is this surface doing". Every listener — the
   * bubble, the waiting cue, the card's speaking glow — is derived from this
   * one value, so none of them can disagree about whether a surface is still
   * waiting while it is already talking.
   */
  phase: SummaryChatPhase
  /**
   * Where the listener cut off the last spoken answer, recorded by
   * monitorSpeech at the moment it observed the interruption. Consumed by the
   * next follow-up.
   */
  interruptedAtCharacter?: number
  /**
   * Monotonic use counter, not a timestamp. "Most recently used" is a sequence
   * question, and two conversations started in the same millisecond used to tie
   * — leaving the target conversation up to sort stability.
   */
  lastUsedSeq: number
}

/**
 * Everything SummaryChat reaches outside its own process: two HTTP services
 * (Anthropic's Messages API and the local Voice Operator), the filesystem, the
 * macOS Keychain, and a timer. Each is narrow enough to fake, which is what
 * makes the conversation lifecycle testable without a network or a keychain.
 */
export interface SummaryChatDeps {
  /** HTTP. Same shape as global `fetch`. */
  fetch: typeof fetch
  /** Voice Operator's discovery document, or undefined when it is not running. */
  readDiscovery(): { port?: unknown } | undefined
  /** Parse an agent transcript off disk. Returns [] when unreadable. */
  readTranscript(filePath: string): TranscriptMessage[]
  /** Claude Code's OAuth credential. Throws when unavailable. */
  oauthToken(): string
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
  readTranscript,
  oauthToken: claudeCodeOAuthToken,
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
  async toggle(nodeId: NodeId | undefined, snapshot: SurfaceSnapshot = {}): Promise<ToggleResult> {
    if (await this.cancelAll()) return { outcome: 'cancelled' }
    if (!nodeId) return { outcome: 'rejected', message: 'Focus an agent terminal to start Summary Chat.' }
    const prepared = this.prepare(nodeId, snapshot)
    if ('message' in prepared) return { outcome: 'rejected', message: prepared.message }
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
    const busy = Array.from(this.conversations.values()).filter(isBusy)
    if (!busy.length) return false
    // Concurrently, not in sequence: cancelling a speaking job promotes the
    // next one in Voice Operator's queue, so a serial walk gives a queued job a
    // window to start talking before its own DELETE arrives.
    await Promise.all(busy.map(conversation => this.cancel(conversation)))
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
  async start(nodeId: NodeId, snapshot: SurfaceSnapshot = {}): Promise<ToggleResult> {
    const prepared = this.prepare(nodeId, snapshot)
    if ('message' in prepared) return { outcome: 'rejected', message: prepared.message }
    await this.run(prepared)
    return { outcome: 'started' }
  }

  /** Everything a summary needs before it commits to anything, or why it can't. */
  private prepare(nodeId: NodeId, snapshot: SurfaceSnapshot): Prepared | { message: string } {
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
    return {
      nodeId,
      transcriptPath,
      sourceAgentSessionId,
      messages: withPending,
      caution: injected && claudeState ? PENDING_TURN_CAUTION[claudeState] : undefined,
      injectedTool: injected ? pendingTurn?.tool : undefined,
    }
  }

  private async run({ nodeId, transcriptPath, sourceAgentSessionId, messages, caution, injectedTool }: Prepared): Promise<void> {
    // A previous conversation on this surface may still hold an open speech job
    // even when it was idle enough not to count as busy — Voice Operator parked
    // on `waiting_for_user`, say. Nothing should outlive the answer it belongs to.
    const previous = this.conversations.get(nodeId)
    if (previous) await this.cancel(previous)
    const conversation: Conversation = {
      auditId: randomUUID(),
      nodeId,
      sourceAgentSessionId,
      haikuHistory: [],
      caution,
      voice: this.voiceFor(nodeId),
      phase: 'ready',
      lastUsedSeq: ++this.useCounter,
    }
    this.conversations.set(nodeId, conversation)
    this.onStatusChanged(nodeId, 'target')
    const prompt = initialPrompt(messages)
    this.recordInitialSnapshot(conversation, transcriptPath, messages, prompt, injectedTool)
    await this.ask(conversation, prompt, 'initial')
  }

  async followUp(text: string): Promise<void> {
    const conversation = Array.from(this.conversations.values())
          .sort((a, b) => b.lastUsedSeq - a.lastUsedSeq)[0]
    if (!conversation) {
      serverLog('[summary-chat] voice command ignored: no active summary conversation')
      return
    }
    const heard = await this.heardPrefix(conversation)
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
   * The one place a surface's phase changes.
   *
   * Both public signals are emitted from here, in a fixed order, so a listener
   * that watches only one of them still sees a coherent lifecycle. In
   * particular every phase that is not `thinking` cancels `thinking` at the
   * same instant, which is what lets the renderer's waiting cue be a pure
   * function of the phase.
   *
   * The speaking indicator stays tied to `speaking` alone. `synthesizing` is a
   * wait, not sound, and lighting the indicator on it would claim a surface was
   * talking through the seconds before it makes any noise.
   */
  private setPhase(conversation: Conversation, phase: SummaryChatPhase): void {
    if (conversation.phase === phase) return
    const wasSpeaking = conversation.phase === 'speaking'
    conversation.phase = phase
    if (phase === 'speaking') this.onSpeakingChanged(conversation.nodeId, true, conversation.voice)
    else if (wasSpeaking) this.onSpeakingChanged(conversation.nodeId, false)
    this.onStatusChanged(conversation.nodeId, phase)
  }

  private async ask(conversation: Conversation, prompt: string, kind: 'initial' | 'follow-up'): Promise<void> {
    conversation.lastUsedSeq = ++this.useCounter
    // Supersede any run already under way on this surface before announcing a
    // new phase, so there is never a moment where two attempts both believe
    // they own the conversation.
    conversation.attempt?.abandon()
    const attempt = new Attempt(conversation)
    conversation.attempt = attempt
    this.setPhase(conversation, 'thinking')
    let monitoring = false
    try {
      // Initial only. On a follow-up the listener has already been warned, and
      // repeating it every turn would cost them the warning's meaning.
      const text = await this.askHaiku(
        conversation, prompt, attempt, kind === 'initial' ? conversation.caution : undefined,
      )
      // Audited before the ownership check: the request was made and the tokens
      // were spent, whether or not anyone still wants the answer.
      this.deps.audit.append({
        event: 'haiku-response', auditId: conversation.auditId, nodeId: conversation.nodeId,
        kind, provider: 'messages-api', responseCharacters: text.length,
        // The text itself, not just its length. Whether the answer was worth
        // hearing is the first question asked when nothing comes out of the
        // speakers, and a character count cannot answer it.
        responseText: text,
      })
      if (!attempt.isCurrent || !text) return
      // The Voice Operator may have appeared after this chat started. Lock a
      // deterministic voice as soon as its voice list becomes available.
      conversation.voice ??= this.voiceFor(conversation.nodeId)
      const speech = await this.speak(text, conversation.voice)
      if (!attempt.isCurrent) {
        // Cancelled while the POST was in flight. The job now exists and no
        // monitor will ever adopt it, so it has to be dropped right here — this
        // is the window that used to speak a whole answer at a listener who had
        // already asked for silence.
        if (speech.job) void this.dropSpeech(speech.job.id)
        return
      }
      if (speech.error) {
        serverLog(`[summary-chat] ${conversation.nodeId.slice(0, 8)} speech refused: ${speech.error}`)
        this.onStatusChanged(conversation.nodeId, 'error', speechErrorMessage(speech.error))
        return
      }
      if (speech.job) {
        conversation.speechId = speech.job.id
        // Hand the wait over here, at the moment Voice Operator takes the job.
        // It is not `speaking` — nothing has made a sound yet, and it may not
        // for many seconds — but it is no longer ours to announce: Voice
        // Operator's own waiting echo starts now, and a surface left in
        // `thinking` would play a second one underneath it.
        this.setPhase(conversation, 'synthesizing')
        monitoring = true
        // "Queued", not "spoke". This point in the flow only knows that Voice
        // Operator took the job — the old wording claimed the summary had been
        // read out, and it logged that just as loudly on the presses where not
        // one word was ever synthesized.
        serverLog(`[summary-chat] ${conversation.nodeId.slice(0, 8)} queued ${text.length} chars as speech ${speech.job.id}`)
        void this.monitorSpeech(conversation, attempt, speech.job)
      } else {
        serverLog(`[summary-chat] ${conversation.nodeId.slice(0, 8)} summarised ${text.length} chars; Voice Operator is not running, so nothing was spoken`)
      }
    } catch (err) {
      // A cancelled request is not a failure. Reporting one would put an error
      // toast on screen every time the listener deliberately cut an answer off.
      if (!attempt.isCurrent) return
      serverLog(`[summary-chat] ${conversation.nodeId.slice(0, 8)} Haiku failed: ${err instanceof Error ? err.message : String(err)}`)
      this.onStatusChanged(conversation.nodeId, 'error', 'Summary Chat could not reach Haiku.')
    } finally {
      // Only the owner settles. A superseded or cancelled attempt leaves the
      // phase to whoever took the conversation from it.
      if (!monitoring && attempt.isCurrent) this.settle(conversation, attempt)
    }
  }

  /**
   * End an attempt, returning its surface to idle.
   *
   * Silently does nothing for an attempt that no longer owns the conversation,
   * so every path out of `ask` and `monitorSpeech` can simply call it rather
   * than first working out whether it is still entitled to.
   */
  private settle(conversation: Conversation, attempt: Attempt): void {
    if (!attempt.isCurrent) return
    conversation.speechId = undefined
    conversation.attempt = undefined
    this.setPhase(conversation, 'ready')
  }

  /**
   * Voice Operator's former low-latency path: call Haiku's Messages endpoint
   * directly with the Claude Code OAuth credential kept in the macOS Keychain.
   * Keep a bounded history locally because this endpoint is stateless.
   */
  private async askHaiku(
    conversation: Conversation, prompt: string, attempt: Attempt, caution?: string,
  ): Promise<string> {
    const pending: HaikuMessage = { role: 'user', content: prompt }
    const messages = boundedHaikuHistory([...conversation.haikuHistory, pending])
    const response = await this.deps.fetch(HAIKU_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.deps.oauthToken()}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'anthropic-version': '2023-06-01',
        'user-agent': 'claude-code/2.1.47',
      },
      body: JSON.stringify({
        model: HAIKU_MODEL,
        max_tokens: 250,
        system: [
          { type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." },
          { type: 'text', text: SUMMARY_SYSTEM_PROMPT },
        ],
        messages,
      }),
      // Two ways to stop waiting: the request took too long, or nobody wants
      // the answer any more. Cancelling mid-summary drops the Haiku call rather
      // than paying for a reply that will be thrown away.
      signal: AbortSignal.any([attempt.signal, AbortSignal.timeout(30_000)]),
    })
    if (!response.ok) throw new Error(`Messages API returned ${response.status}`)
    const payload = await response.json() as { content?: Array<{ type?: string; text?: string }> }
    const text = payload.content
      ?.filter(block => block.type === 'text' && typeof block.text === 'string')
      .map(block => block.text!)
      .join('')
      .trim()
    if (!text) throw new Error('Messages API returned no text')
    // The caution joins the answer here, before it is either stored or spoken,
    // so the stored string and the spoken string stay the same string.
    // `redactUnheard` maps Voice Operator's `character_offset` onto the stored
    // answer; speaking a prefix that the history does not contain would shift
    // every interruption offset by its length, silently.
    const answer = caution ? `${caution} ${text}` : text
    conversation.haikuHistory = boundedHaikuHistory([...conversation.haikuHistory, pending, { role: 'assistant', content: answer }])
    return answer
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
    injectedTool?: PendingTurn['tool'],
  ): void {
    try {
      const snapshotPath = this.deps.audit.writeSnapshot(conversation.auditId, prompt)
      const messageCharacters = messages.reduce((total, message) => total + message.text.length, 0)
      this.deps.audit.append({
        event: 'started', auditId: conversation.auditId, nodeId: conversation.nodeId,
        sourceAgentSessionId: conversation.sourceAgentSessionId ?? null,
        transcriptPath, snapshotPath, messageCount: messages.length,
        messageCharacters, promptCharacters: prompt.length,
        injectedTool: injectedTool ?? null, caution: conversation.caution ?? null,
      })
    } catch (err) {
      serverLog(`[summary-chat] failed to record audit snapshot: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /**
   * How much of the previous answer the listener actually heard, if they cut it
   * off. Consumed once, so a later follow-up does not repeat stale context.
   */
  private async heardPrefix(conversation: Conversation): Promise<number | undefined> {
    const recorded = conversation.interruptedAtCharacter
    conversation.interruptedAtCharacter = undefined
    if (recorded !== undefined) return recorded
    // Still-live job: the follow-up beat the monitor to the terminal status.
    if (!conversation.speechId) return undefined
    const status = speechStatus(await this.speechRequest(`/v1/speech/${encodeURIComponent(conversation.speechId)}?wait=0`))
    if (status?.state !== 'interrupted_by_user') return undefined
    return status.character_offset ?? 0
  }

  /**
   * Stop a conversation producing, and settle its surface.
   *
   * The phase is settled here rather than left to `monitorSpeech`: the monitor
   * returns silently once it no longer owns the conversation, so a cancelled
   * job used to strand the surface in `thinking` forever — which is how a
   * waiting cue could outlive the thing it was waiting for.
   */
  private async cancel(conversation: Conversation): Promise<void> {
    const speechId = conversation.speechId
    const attempt = conversation.attempt
    conversation.speechId = undefined
    conversation.attempt = undefined
    // Abandoning aborts the request the attempt is parked on, which is what
    // frees a monitor sitting in a thirty-second long poll.
    attempt?.abandon()
    this.setPhase(conversation, 'ready')
    if (!speechId) return
    const status = speechStatus(await this.dropSpeech(speechId))
    // Being cut off is exactly the situation the interruption offset exists to
    // describe, so record it for the next follow-up. A reported zero is a real
    // answer — the listener heard no complete sentence — and has to be told
    // apart from an absent field, or the whole unheard answer stays in the
    // history as though it had been delivered.
    if (typeof status?.character_offset === 'number') {
      conversation.interruptedAtCharacter = status.character_offset
    }
  }

  /** Ask Voice Operator to drop a job, wherever it is in its lifecycle. */
  private dropSpeech(speechId: string): Promise<SpeechResponse> {
    return this.speechRequest(`/v1/speech/${encodeURIComponent(speechId)}`, { method: 'DELETE' })
  }

  /**
   * Follow one speech job until it stops, keeping the surface's phase in step.
   *
   * Two polling strategies, chosen by whether Voice Operator offers a change
   * cursor. With one, this parks in a long poll that the service wakes on *any*
   * observable change — including the cancellation we issue ourselves, so a
   * cancel and its monitor never have to race. Without one (an older service),
   * it falls back to the short-poll cadence that cursor replaced; see
   * `pollWaitSeconds` for why that cadence had to exist at all.
   */
  private async monitorSpeech(conversation: Conversation, attempt: Attempt, job: SpeechStatus): Promise<void> {
    const speechId = job.id
    const label = conversation.nodeId.slice(0, 8)
    const startedAt = Date.now()
    let cursor = job.version
    let reportedPlayback: string | undefined
    let stallReported = false
    while (attempt.isCurrent) {
      // A cursor poll is paced by the service; a legacy poll is paced by us.
      const wait = cursor === undefined ? pollWaitSeconds(conversation.phase) : SPEECH_LONG_POLL_SECONDS
      const since = cursor === undefined ? '' : `&since=${cursor}`
      // The default request timeout is intentionally short for one-shot
      // operations. A speech monitor, however, must tolerate a stalled local
      // service without falsely declaring the job finished.
      const status = speechStatus(await this.speechRequest(
        `/v1/speech/${encodeURIComponent(speechId)}?wait=${wait}${since}`,
        { signal: attempt.signal },
        wait === 0 ? 3_000 : SPEECH_LONG_POLL_TIMEOUT_MS,
      ))
      if (!attempt.isCurrent) return
      if (!status) {
        // Voice Operator stopped answering about a job it had already accepted.
        // Settling is right — the surface must not hang on it — but it is not
        // the same as an answer that finished, and it left no trace at all.
        serverLog(`[summary-chat] ${label} lost track of speech ${speechId} after ${sinceSeconds(startedAt)}`)
        this.settle(conversation, attempt)
        return
      }
      if (status.state === 'in_progress') {
        const playback = status.playback_state ?? 'unknown'
        if (playback !== reportedPlayback) {
          serverLog(`[summary-chat] ${label} speech ${speechId} ${playback} at ${sinceSeconds(startedAt)}`)
          reportedPlayback = playback
        } else if (!stallReported && playback === 'queued'
                   && Date.now() - startedAt >= SPEECH_STALL_REPORT_MS) {
          serverLog(`[summary-chat] ${label} speech ${speechId} still queued after ${sinceSeconds(startedAt)} — accepted but silent`)
          stallReported = true
        }
        // `in_progress` is the lifecycle of the whole Voice Operator job, and
        // covers everything from "accepted, still queued" to "talking". Its
        // playback state is what distinguishes those (see playbackPhase), so
        // the surface's phase is driven from there rather than from the job.
        this.setPhase(conversation, playbackPhase(status.playback_state, conversation.phase))
        // A poll that did not advance the cursor told us nothing, so fall back
        // to the floor rather than trust the service to pace us. Without this a
        // service that ignores `since` — while still reporting a version —
        // would spin this loop as fast as the event loop allows.
        const advanced = cursor !== undefined && status.version !== undefined && status.version > cursor
        cursor = status.version
        if (!advanced) await this.deps.sleep(SPEECH_POLL_INTERVAL_MS)
        continue
      }
      serverLog(`[summary-chat] ${label} speech ${speechId} ended as ${status.state} after ${sinceSeconds(startedAt)}`)
      // Capture the cut-off point now, while the job is fresh in hand.
      if (status.state === 'interrupted_by_user') {
        conversation.interruptedAtCharacter = status.character_offset ?? 0
      }
      // A job that died in synthesis made no sound and offered no reason, yet
      // used to settle down exactly the same path as a summary read out in
      // full. To a listener those two are the same event — silence — so the
      // one that is a fault has to say so.
      if (status.state === 'synthesis_failed') {
        this.onStatusChanged(conversation.nodeId, 'error', 'Voice Operator could not turn the summary into speech.')
      }
      this.settle(conversation, attempt)
      return
    }
  }

  private async refreshVoices(): Promise<void> {
    const response = await this.speechRequest('/v1/voices')
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

  /**
   * Queue an answer for speaking.
   *
   * Refusals come back named rather than as a silent absence: Voice Operator
   * declines a job when the user has muted speech, and a listener who pressed
   * the chord and then heard nothing deserves to be told which of "muted" and
   * "broken" they are looking at.
   */
  private async speak(text: string, voice: string | undefined): Promise<{ job?: SpeechStatus; error?: string }> {
    const response = await this.speechRequest('/v1/speech', {
      method: 'POST', body: JSON.stringify({ text, ...(voice ? { voice } : {}) }),
    })
    const job = speechStatus(response)
    if (job?.id) return { job }
    // An absent response covers two different situations, and reporting both as
    // silence is what let a press that never reached Voice Operator log itself
    // as spoken. No discovery file means Voice Operator is simply not running,
    // which is a supported way to use Summary Chat — the surface still gets its
    // text summary and stays quiet about the audio it was never going to make.
    // Discovery present and the request still failing is the other thing
    // entirely: the service is there and did not answer.
    if (response === undefined) {
      return this.deps.readDiscovery() ? { error: 'unreachable' } : {}
    }
    const error = (response.body as { error?: unknown } | undefined)?.error
    return { error: typeof error === 'string' ? error : 'rejected' }
  }

  /**
   * One call to Voice Operator. Returns undefined only when the service could
   * not be reached at all — an HTTP status is an *answer*, not a failure.
   *
   * The status is handed back rather than filtered here, because this service
   * uses status codes as outcomes: 409 is "the listener interrupted it", 410 is
   * "cancelled, here is how far it got", 503 is "speech is muted". A
   * transport-level allowlist can only ever get that wrong, and it did — a
   * DELETE that successfully stopped speech answers 410, so the old allowlist
   * discarded the response along with the character offset it carried.
   */
  private async speechRequest(endpoint: string, init?: RequestInit, timeoutMs = 3_000): Promise<SpeechResponse> {
    const discovery = this.deps.readDiscovery()
    if (!discovery) return undefined
    const port = typeof discovery.port === 'number' && discovery.port > 0 && discovery.port < 65536
      ? discovery.port
      : undefined
    if (port === undefined) return undefined
    try {
      const response = await this.deps.fetch(`http://127.0.0.1:${port}${endpoint}`, {
        ...init,
        headers: { 'content-type': 'application/json', ...init?.headers },
        signal: init?.signal
          ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)])
          : AbortSignal.timeout(timeoutMs),
      })
      return { status: response.status, body: await response.json().catch(() => undefined) }
    } catch {
      return undefined
    }
  }
}

/**
 * Whether a surface is producing an answer, and so has something to interrupt.
 *
 * Read off the phase rather than tracked separately, because the phase is
 * already the one value every other consumer derives from — see
 * `Conversation.phase`. A second notion of "busy" alongside it is a second
 * thing to keep in step, and the cancel gesture would be exactly where the two
 * drifting apart is felt.
 *
 * Stated as "not idle" rather than by listing the busy phases, so that adding
 * a phase cannot quietly remove a state from the cancel gesture. Adding
 * `synthesizing` to a list of busy phases would have been an easy omission to
 * make and a hard one to notice: it is the *longest* phase on a slow
 * synthesizer, which makes it the one a listener is most likely to be in when
 * they press the chord to shut it up.
 */
function isBusy(conversation: Conversation): boolean {
  return conversation.phase !== 'ready'
}

/** A Voice Operator reply, or undefined when the service could not be reached. */
type SpeechResponse = { status: number; body: unknown } | undefined

/** Elapsed time since `startedAt`, for a log line. */
function sinceSeconds(startedAt: number): string {
  return `${((Date.now() - startedAt) / 1000).toFixed(1)}s`
}

/** The speech job in a reply, if the reply carries one at all. */
function speechStatus(response: SpeechResponse): SpeechStatus | undefined {
  const body = response?.body as SpeechStatus | undefined
  return typeof body?.id === 'string' && typeof body.state === 'string' ? body : undefined
}

/** What a named refusal from Voice Operator means to the listener. */
function speechErrorMessage(error: string | undefined): string {
  if (error === 'speech_muted') return 'Voice Operator has speech muted, so there is nothing to hear.'
  if (error === 'unreachable') return 'Voice Operator is not answering, so the summary could not be spoken.'
  return 'Voice Operator would not speak the summary.'
}

/**
 * How long to ask Voice Operator to hold the next status poll open, on a
 * service too old to offer a change cursor.
 *
 * Measured, not assumed: a bare `?wait=N` wakes **only** at a terminal state.
 * It does not wake when playback moves from `queued` to `speaking`, which is
 * why the indicator used to sit on "thinking" for the whole spoken answer and
 * then jump straight to idle — the app asked a question that could only be
 * answered after the answer no longer mattered.
 *
 * So: while the surface is showing something that tracks the audio, poll
 * immediately and let SPEECH_POLL_INTERVAL_MS set the cadence. Once Voice
 * Operator is merely listening (`waiting_for_user`, mapped to `ready`) there
 * is nothing to track, and a job can sit there indefinitely — hand the waiting
 * back to the service rather than spinning on it.
 *
 * A service that reports `version` needs none of this: `?since=` wakes on every
 * change, so `monitorSpeech` long-polls throughout and this is not consulted.
 */
function pollWaitSeconds(phase: SummaryChatPhase): number {
  return phase === 'ready' ? SPEECH_LONG_POLL_SECONDS : 0
}

/**
 * What an `in_progress` speech job's playback state means for the surface.
 *
 * `waiting_for_user` deliberately maps to `ready`, not `thinking`: the job is
 * still open, but Voice Operator is listening rather than producing audio, and
 * a job can sit there indefinitely. Treating it as "still waiting" is what let
 * the waiting cue run forever after an answer had already been spoken.
 *
 * `queued` is read *relative to the phase we are already in*, which is the one
 * piece of hysteresis here. Voice Operator's queue is sentence-at-a-time: it
 * drops back to `queued` at every sentence handoff within a single job and
 * only returns to `speaking` once the next sentence's audio actually starts.
 * Now that this monitor polls fast enough to see those handoffs, a literal
 * reading would flicker the indicator in the gaps between an answer's own
 * sentences. An answer that has begun is speaking until it stops or ends,
 * however its synthesis is paced.
 *
 * Before the first sound, though, `queued` is exactly what it says — Voice
 * Operator is synthesizing — and the surface reports `synthesizing`. Note what
 * it never returns: `thinking`. Once a speech job exists, Haiku is done, and
 * `thinking` is the one phase that makes spaceterm audible.
 */
function playbackPhase(
  playbackState: SpeechStatus['playback_state'],
  current: SummaryChatPhase,
): SummaryChatPhase {
  // Older services did not send playback_state; assume audible for compatibility.
  if (playbackState === undefined || playbackState === 'speaking') return 'speaking'
  if (playbackState === 'waiting_for_user') return 'ready'
  return current === 'speaking' ? 'speaking' : 'synthesizing'
}

function initialPrompt(messages: TranscriptMessage[]): string {
  const anchor = latestSubstantialUserMessage(messages)
  const background = messages.slice(0, anchor)
  const turn = messages.slice(anchor)
  const format = (items: TranscriptMessage[]) => items
    .map(message => `${message.role.toUpperCase()}: ${message.text}`)
    .join('\n\n')
  return `BACKGROUND CONTEXT is only for disambiguation and for preparing to answer follow-up voice questions.

BACKGROUND CONTEXT:
${format(background) || '(none)'}

CURRENT TURN TO SUMMARIZE:
${format(turn)}`
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
 * The Messages API is stateless — `askHaiku` resends the whole history on every
 * turn — so an answer that was cut off mid-flow would keep being presented to
 * Haiku as though all of it had been delivered. It would then answer "as I
 * said…" about words nobody heard. Redacting the tail is what makes the resent
 * history match the listener's experience.
 *
 * The cut is backed up to the last sentence boundary at or before `heard`, so a
 * sentence that was half out of the speaker's mouth is dropped rather than
 * presented as delivered. Voice Operator already reports whole sentences, but
 * relying on that would put the correctness of the transcript in another
 * process's hands for no gain.
 */
export function redactUnheard(text: string, heard: number): string {
  if (heard >= text.length) return text
  const audible = text.slice(0, Math.max(0, heard))
  const spoken = audible.slice(0, lastSentenceEnd(audible)).trim()
  return spoken ? `${spoken} ${INTERRUPTED_MARKER}` : INTERRUPTED_MARKER
}

/**
 * Where the last complete sentence in `text` ends, or 0 if there is none.
 * Terminators only count when followed by whitespace or the end of the string,
 * which keeps decimals and version numbers from reading as sentence ends.
 */
function lastSentenceEnd(text: string): number {
  let end = 0
  for (const match of text.matchAll(/[.!?…]["')\]]*(?=\s|$)/g)) {
    end = (match.index ?? 0) + match[0].length
  }
  return end
}

function boundedHaikuHistory(history: HaikuMessage[]): HaikuMessage[] {
  if (history.length <= MAX_HAIKU_HISTORY_MESSAGES) return history
  // Keep the initial prompt (which contains the focused transcript) and the
  // newest exchanges; this preserves grounding without unbounded request size.
  return [history[0], ...history.slice(-(MAX_HAIKU_HISTORY_MESSAGES - 1))]
}

function claudeCodeOAuthToken(): string {
  const account = process.env.USER || process.env.LOGNAME || userInfo().username
  try {
    const raw = execFileSync('/usr/bin/security', [
      'find-generic-password', '-s', 'Claude Code-credentials', '-a', account, '-w',
    ], { encoding: 'utf8', timeout: 3_000, stdio: ['ignore', 'pipe', 'ignore'] })
    const credentials = JSON.parse(raw) as { claudeAiOauth?: { accessToken?: unknown } }
    const token = credentials.claudeAiOauth?.accessToken
    if (typeof token === 'string' && token) return token
  } catch { /* Present the same generic failure regardless of Keychain details. */ }
  throw new Error('Claude Code OAuth credential is unavailable')
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
  const result: TranscriptMessage[] = []
  for (const line of raw.split('\n')) {
    if (!line) continue
    try {
      const entry = JSON.parse(line) as Record<string, any>
      const message = extractMessage(entry)
      if (message) result.push(message)
    } catch { /* Ignore a partial JSONL write. */ }
  }
  return selectSpeakable(result)
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
  let chars = all[anchor].text.length
  /** Take one message if both budgets allow; false means this direction is done. */
  const admit = (index: number): boolean => {
    if (kept.size >= MAX_MESSAGES) return false
    if (chars + all[index].text.length > MAX_CHARS) return false
    kept.add(index)
    chars += all[index].text.length
    return true
  }
  for (let i = all.length - 1; i > anchor; i--) if (!admit(i)) break
  for (let i = anchor - 1; i >= 0; i--) if (!admit(i)) break
  return Array.from(kept).sort((a, b) => a - b).map(index => all[index])
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

function extractMessage(entry: Record<string, any>): TranscriptMessage | undefined {
  // Claude's transcript shape.
  if ((entry.type === 'user' || entry.type === 'assistant') && entry.message) {
    const text = contentText(entry.message.content)
    return text ? { role: entry.type, text } : undefined
  }
  // Cursor's JSONL uses role at the top level rather than type.
  if ((entry.role === 'user' || entry.role === 'assistant') && entry.message) {
    const text = contentText(entry.message.content)
    return text ? { role: entry.role, text } : undefined
  }
  // Codex writes a separate canonical user_message event. Using it avoids
  // accidentally treating its injected environment/developer context as human
  // speech. Assistant output remains in response_item messages.
  if (entry.type === 'event_msg' && entry.payload?.type === 'user_message' && typeof entry.payload.message === 'string') {
    const text = entry.payload.message.trim()
    return text ? { role: 'user', text } : undefined
  }
  // Codex rollout shape. Ignore developer/system messages and tool calls.
  if (entry.type === 'response_item' && entry.payload?.type === 'message') {
    const role = entry.payload.role
    if (role !== 'assistant') return undefined
    const text = contentText(entry.payload.content)
    return text ? { role, text } : undefined
  }
  return undefined
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    const type = (block as { type?: unknown }).type
    if (type === 'text' || type === 'input_text' || type === 'output_text') {
      const text = (block as { text?: unknown }).text
      if (typeof text === 'string' && text.trim()) parts.push(text.trim())
      continue
    }
    if (type === 'tool_use') {
      const spoken = speakableToolText(
        (block as { name?: unknown }).name,
        (block as { input?: unknown }).input,
      )
      if (spoken) parts.push(spoken)
    }
  }
  return parts.join('\n\n').trim()
}
