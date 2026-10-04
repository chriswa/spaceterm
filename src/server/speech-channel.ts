import { serverLog } from './server-log'
import {
  joinSpeechParts, speechStatus, type SpeechBackend, type SpeechContent, type SpeechStatus,
} from './voice-operator'
import type { SummaryChatPhase } from '../shared/protocol'

export type { SpeechPart, SpeechContent } from './voice-operator'

/**
 * The playback lifecycle of one spoken conversation, independent of what is
 * being said or why.
 *
 * Extracted from Summary Chat, where every rule below was learned the hard way
 * — each comment records a bug. Anything that speaks a conversation (Summary
 * Chat, the receptionist) holds one of these instead of re-deriving that
 * lifecycle, because the bugs it guards against are all in the *timing*, and
 * a second copy would have to rediscover each of them.
 */

/** What a channel is doing. Shared with Summary Chat's protocol, which is where it started. */
export type SpeechPhase = SummaryChatPhase

const SPEECH_LONG_POLL_TIMEOUT_MS = 5 * 60_000
/** How long Voice Operator holds a long poll open, in seconds. */
const SPEECH_LONG_POLL_SECONDS = 30
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

/**
 * Why speech the channel was asked for produced no sound, when that is a
 * fault rather than a choice. `refused` carries Voice Operator's named error
 * (`speech_muted`, …), or `unreachable` when it is installed but not answering.
 */
export type SpeechFailure =
  | { kind: 'refused'; error: string }
  | { kind: 'synthesis_failed' }

/**
 * What a failure means to the listener. `subject` names what was being spoken
 * — "the summary", "the answer" — so each feature keeps its own wording while
 * the mapping from Voice Operator's errors lives in one place.
 */
export function speechFailureMessage(failure: SpeechFailure, subject = 'the answer'): string {
  if (failure.kind === 'synthesis_failed') return `Voice Operator could not turn ${subject} into speech.`
  if (failure.error === 'speech_muted') return 'Voice Operator has speech muted, so there is nothing to hear.'
  if (failure.error === 'unreachable') return `Voice Operator is not answering, so ${subject} could not be spoken.`
  return `Voice Operator would not speak ${subject}.`
}

export interface SpeechChannelDeps {
  /** Resolve after `ms` milliseconds. The monitor's poll floor. */
  sleep(ms: number): Promise<void>
  /**
   * Whether Voice Operator is installed and publishing a discovery document.
   * Tells "not running" (a supported way to use speech features: stay quiet)
   * apart from "running and not answering" (a fault worth reporting).
   */
  voiceOperatorDiscovered(): boolean
}

export interface SpeechChannelOptions {
  /** Where the next `deliver` speaks. Settable later via `speech`. */
  speech: SpeechBackend
  /** Prefix for every log line, e.g. `[summary-chat] 1a2b3c4d`. */
  label: string
  /**
   * Every phase change, in the order they happen. Called synchronously from
   * the one place the phase changes, so a listener derives everything — a
   * speaking indicator, a waiting cue — from this and cannot disagree with it.
   */
  onPhase(phase: SpeechPhase, previous: SpeechPhase): void
  /** Speech failed in a way the listener should hear about. */
  onFailure(failure: SpeechFailure): void
  deps: SpeechChannelDeps
}

/** The job the channel is following, and the backend that owns it. */
interface LiveJob {
  id: string
  /**
   * Captured with the job, not read off `channel.speech`: the backend can be
   * reassigned between turns, and a status or DELETE for a job sent to the
   * wrong backend would silently find nothing to stop.
   */
  backend: SpeechBackend
}

/**
 * One run on a channel — typically a model request, the speech job it
 * produces, and the monitor that watches that job play out.
 *
 * Every `await` in that chain resumes into a world which may have moved on: the
 * listener may have cancelled, or started a newer answer on the same channel.
 * The point of this object is that all of those resumption points ask the *same
 * question of the same thing*. They used to each invent their own staleness
 * test, and only some of them had one at all — which is how a cancel arriving
 * between the model answering and the speech POST returning produced a job
 * nobody owned, still talking at a listener who had asked for silence.
 */
export class Attempt {
  private readonly controller = new AbortController()

  /** @internal Made only by `SpeechChannel.begin`. */
  constructor(private readonly owner: AttemptOwner) {}

  /** Cancels the in-flight request this attempt is waiting on, if any. */
  get signal(): AbortSignal { return this.controller.signal }

  /**
   * Whether this attempt still owns its channel. False once it has been
   * cancelled, superseded, or has settled — so a resumption point that reads
   * false must touch nothing, because someone else already has.
   */
  get isCurrent(): boolean { return this.owner.current() === this }

  /** Give up ownership. Aborting is what unblocks a parked long poll. */
  abandon(): void {
    this.owner.release(this)
    this.controller.abort()
  }
}

interface AttemptOwner {
  current(): Attempt | undefined
  release(attempt: Attempt): void
}

export class SpeechChannel {
  /** Where the next `deliver` speaks. A job already under way stays where it started. */
  speech: SpeechBackend
  private readonly label: string
  private readonly onPhase: SpeechChannelOptions['onPhase']
  private readonly onFailure: SpeechChannelOptions['onFailure']
  private readonly deps: SpeechChannelDeps
  private currentPhase: SpeechPhase = 'ready'
  private attempt: Attempt | undefined
  private job: LiveJob | undefined
  /** Jobs spoken by `deliverInterim` this attempt: not followed, but dropped by `cancel`. */
  private interimJobs: LiveJob[] = []
  /**
   * Where the listener cut off the last spoken answer, recorded at the moment
   * the interruption was observed. Consumed by `heardPrefix`.
   */
  private interruptedAtCharacter: number | undefined
  /** What an `Attempt` may see of this channel: who owns it, and a way to let go. */
  private readonly owner: AttemptOwner = {
    current: () => this.attempt,
    release: (attempt) => { if (this.attempt === attempt) this.attempt = undefined },
  }

  constructor(opts: SpeechChannelOptions) {
    this.speech = opts.speech
    this.label = opts.label
    this.onPhase = opts.onPhase
    this.onFailure = opts.onFailure
    this.deps = opts.deps
  }

  /**
   * The single answer to "what is this channel doing". Every listener is
   * derived from it — see `onPhase`.
   */
  get phase(): SpeechPhase { return this.currentPhase }

  /**
   * Whether the channel is producing something, and so has something to
   * interrupt.
   *
   * Stated as "not idle" rather than by listing the busy phases, so that adding
   * a phase cannot quietly remove a state from a cancel gesture. Adding
   * `synthesizing` to a list of busy phases would have been an easy omission to
   * make and a hard one to notice: it is the *longest* phase on a slow
   * synthesizer, which makes it the one a listener is most likely to be in when
   * they ask for silence.
   *
   * A channel parked in `waiting_for_user` reads idle: its job is still open
   * but nothing is audible and nothing is pending.
   */
  isProducing(): boolean {
    return this.currentPhase !== 'ready'
  }

  /**
   * Take ownership of the channel for a new run, then announce `phase`.
   *
   * Supersedes any run already under way *before* the new phase is announced,
   * so there is never a moment where two attempts both believe they own the
   * channel. `thinking` while something is being generated upstream;
   * `synthesizing` when the text is already in hand — which is what keeps a
   * cancel gesture working across the POST, since `isProducing` reads the phase.
   */
  begin(phase: 'thinking' | 'synthesizing'): Attempt {
    this.attempt?.abandon()
    this.interimJobs = []
    const attempt = new Attempt(this.owner)
    this.attempt = attempt
    this.setPhase(phase)
    return attempt
  }

  /**
   * Hand content to the speech backend and start following it.
   *
   * Returns whether a monitor now owns the channel's phase; a caller that gets
   * `false` is responsible for calling `settle` itself (a `finally` that
   * settles unless this returned true is the intended shape). Everything from
   * the POST onwards is here, down to the window where a cancel that lands
   * mid-POST has to drop the job.
   */
  async deliver(attempt: Attempt, content: SpeechContent, voice?: string): Promise<boolean> {
    const characters = joinSpeechParts(content).length
    const backend = this.speech
    const speech = await this.speak(backend, content, voice)
    if (!attempt.isCurrent) {
      // Cancelled while the POST was in flight. The job now exists and no
      // monitor will ever adopt it, so it has to be dropped right here — this
      // is the window that used to speak a whole answer at a listener who had
      // already asked for silence.
      if (speech.job) void backend.drop(speech.job.id)
      return false
    }
    if (speech.error) {
      serverLog(`${this.label} speech refused: ${speech.error}`)
      this.onFailure({ kind: 'refused', error: speech.error })
      return false
    }
    if (!speech.job) {
      serverLog(`${this.label} produced ${characters} chars; Voice Operator is not running, so nothing was spoken`)
      return false
    }
    this.job = { id: speech.job.id, backend }
    // Hand the wait over here, at the moment Voice Operator takes the job.
    // It is not `speaking` — nothing has made a sound yet, and it may not
    // for many seconds — but it is no longer ours to announce: Voice
    // Operator's own waiting echo starts now, and a channel left in
    // `thinking` would play a second one underneath it.
    this.setPhase('synthesizing')
    // "Queued", not "spoke". This point in the flow only knows that Voice
    // Operator took the job — the old wording claimed the answer had been
    // read out, and it logged that just as loudly on the presses where not
    // one word was ever synthesized.
    serverLog(`${this.label} queued ${characters} chars as speech ${speech.job.id}: ${quoteForLog(content)}`)
    void this.monitor(attempt, this.job, speech.job)
    return true
  }

  /**
   * Speak something while the attempt is still working: "let me check" before
   * a slow step, so the listener hears what is happening instead of silence.
   *
   * Queued with the backend ahead of the answer the attempt will deliver, so
   * it plays first. It is not followed — the answer's job is the one whose
   * interruption offset means anything — but `cancel` drops it with the rest,
   * so a stop still stops everything. The phase moves to `synthesizing`: the
   * wait now belongs to the speech backend, and a `thinking` cue would play
   * over the words.
   */
  async deliverInterim(attempt: Attempt, content: SpeechContent): Promise<void> {
    const backend = this.speech
    const speech = await this.speak(backend, content, undefined)
    if (!attempt.isCurrent) {
      if (speech.job) void backend.drop(speech.job.id)
      return
    }
    // A refusal is left for the answer to report: one toast, not two.
    if (!speech.job) return
    serverLog(`${this.label} queued interim speech ${speech.job.id}: ${quoteForLog(content)}`)
    this.interimJobs.push({ id: speech.job.id, backend })
    this.setPhase('synthesizing')
  }

  /**
   * End an attempt, returning the channel to idle.
   *
   * Silently does nothing for an attempt that no longer owns the channel, so
   * every exit path can simply call it rather than first working out whether
   * it is still entitled to.
   */
  settle(attempt: Attempt): void {
    if (!attempt.isCurrent) return
    this.job = undefined
    this.interimJobs = []
    this.attempt = undefined
    this.setPhase('ready')
  }

  /**
   * Stop the channel producing, and settle it. Returns whether there was
   * anything — a run or a job — to stop.
   *
   * The phase is settled here rather than left to the monitor: the monitor
   * returns silently once it no longer owns the channel, so a cancelled job
   * used to strand the surface in `thinking` forever — which is how a waiting
   * cue could outlive the thing it was waiting for.
   */
  async cancel(): Promise<boolean> {
    const job = this.job
    const attempt = this.attempt
    const interim = this.interimJobs
    this.job = undefined
    this.attempt = undefined
    this.interimJobs = []
    for (const spoken of interim) void spoken.backend.drop(spoken.id)
    // Abandoning aborts the request the attempt is parked on, which is what
    // frees a monitor sitting in a thirty-second long poll.
    attempt?.abandon()
    this.setPhase('ready')
    if (!job) return attempt !== undefined
    const status = speechStatus(await job.backend.drop(job.id))
    // Being cut off is exactly the situation the interruption offset exists to
    // describe, so record it for the next turn. A reported zero is a real
    // answer — the listener heard no complete sentence — and has to be told
    // apart from an absent field, or the whole unheard answer stays in the
    // history as though it had been delivered.
    if (typeof status?.character_offset === 'number') {
      this.interruptedAtCharacter = status.character_offset
    }
    return true
  }

  /**
   * Stop whatever is audible, as though the listener had cut it off, but leave
   * the attempt running: the listener has gone, and the work that produced
   * the speech still matters. The monitor sees the job end cut off, records
   * how far it got for `heardPrefix`, and settles as it would after any cut.
   */
  async silence(): Promise<void> {
    const interim = this.interimJobs
    this.interimJobs = []
    for (const spoken of interim) void spoken.backend.drop(spoken.id)
    if (this.job) await this.job.backend.drop(this.job.id)
  }

  /**
   * How much of the previous answer the listener actually heard, if they cut it
   * off: a UTF-16 offset into `joinSpeechParts` of what was delivered. Consumed
   * once, so a later turn does not repeat stale context.
   */
  async heardPrefix(): Promise<number | undefined> {
    const recorded = this.interruptedAtCharacter
    this.interruptedAtCharacter = undefined
    if (recorded !== undefined) return recorded
    // Still-live job: the follow-up beat the monitor to the terminal status.
    const job = this.job
    if (!job) return undefined
    const status = speechStatus(await job.backend.status(job.id))
    if (!status || !wasCutOff(status.state)) return undefined
    return status.character_offset ?? 0
  }

  /**
   * The one place the phase changes.
   *
   * Every phase that is not `thinking` cancels `thinking` at the same instant,
   * which is what lets a waiting cue be a pure function of the phase.
   */
  private setPhase(phase: SpeechPhase): void {
    const previous = this.currentPhase
    if (previous === phase) return
    this.currentPhase = phase
    this.onPhase(phase, previous)
  }

  /**
   * Follow one speech job until it stops, keeping the phase in step.
   *
   * Two polling strategies, chosen by whether the backend offers a change
   * cursor. With one, this parks in a long poll that the service wakes on *any*
   * observable change — including the cancellation we issue ourselves, so a
   * cancel and its monitor never have to race. Without one (an older service),
   * it falls back to the short-poll cadence that cursor replaced; see
   * `pollWaitSeconds` for why that cadence had to exist at all.
   */
  private async monitor(attempt: Attempt, job: LiveJob, accepted: SpeechStatus): Promise<void> {
    const startedAt = Date.now()
    let cursor = accepted.version
    let reportedPlayback: string | undefined
    let stallReported = false
    while (attempt.isCurrent) {
      // A cursor poll is paced by the service; a legacy poll is paced by us.
      const wait = cursor === undefined ? pollWaitSeconds(this.currentPhase) : SPEECH_LONG_POLL_SECONDS
      // The default request timeout is intentionally short for one-shot
      // operations. A speech monitor, however, must tolerate a stalled local
      // service without falsely declaring the job finished.
      const status = speechStatus(await job.backend.status(
        job.id,
        { wait, ...(cursor === undefined ? {} : { since: cursor }) },
        { signal: attempt.signal },
        wait === 0 ? 3_000 : SPEECH_LONG_POLL_TIMEOUT_MS,
      ))
      if (!attempt.isCurrent) return
      if (!status) {
        // Voice Operator stopped answering about a job it had already accepted.
        // Settling is right — the channel must not hang on it — but it is not
        // the same as an answer that finished, and it left no trace at all.
        serverLog(`${this.label} lost track of speech ${job.id} after ${sinceSeconds(startedAt)}`)
        this.settle(attempt)
        return
      }
      if (status.state === 'in_progress') {
        const playback = status.playback_state ?? 'unknown'
        if (playback !== reportedPlayback) {
          serverLog(`${this.label} speech ${job.id} ${playback} at ${sinceSeconds(startedAt)}`)
          reportedPlayback = playback
        } else if (!stallReported && playback === 'queued'
                   && Date.now() - startedAt >= SPEECH_STALL_REPORT_MS) {
          serverLog(`${this.label} speech ${job.id} still queued after ${sinceSeconds(startedAt)} — accepted but silent`)
          stallReported = true
        }
        // `in_progress` is the lifecycle of the whole Voice Operator job, and
        // covers everything from "accepted, still queued" to "talking". Its
        // playback state is what distinguishes those (see playbackPhase), so
        // the phase is driven from there rather than from the job.
        this.setPhase(playbackPhase(status.playback_state, this.currentPhase))
        // A poll that did not advance the cursor told us nothing, so fall back
        // to the floor rather than trust the service to pace us. Without this a
        // service that ignores `since` — while still reporting a version —
        // would spin this loop as fast as the event loop allows.
        const advanced = cursor !== undefined && status.version !== undefined && status.version > cursor
        cursor = status.version
        if (!advanced) await this.deps.sleep(SPEECH_POLL_INTERVAL_MS)
        continue
      }
      serverLog(`${this.label} speech ${job.id} ended as ${status.state} after ${sinceSeconds(startedAt)}`)
      // Capture the cut-off point now, while the job is fresh in hand. A job
      // the client cancelled without being asked to — the phone's page was
      // killed, or its connection dropped — was cut off just the same, and
      // settling it as though it had been heard is how a reply went unheard
      // without anyone knowing.
      if (wasCutOff(status.state)) {
        this.interruptedAtCharacter = status.character_offset ?? 0
      }
      // A job that died in synthesis made no sound and offered no reason, yet
      // used to settle down exactly the same path as an answer read out in
      // full. To a listener those two are the same event — silence — so the
      // one that is a fault has to say so.
      if (status.state === 'synthesis_failed') this.onFailure({ kind: 'synthesis_failed' })
      this.settle(attempt)
      return
    }
  }

  /**
   * Queue content for speaking.
   *
   * Refusals come back named rather than as a silent absence: Voice Operator
   * declines a job when the user has muted speech, and a listener who asked
   * and then heard nothing deserves to be told which of "muted" and "broken"
   * they are looking at.
   */
  private async speak(
    backend: SpeechBackend, content: SpeechContent, voice: string | undefined,
  ): Promise<{ job?: SpeechStatus; error?: string }> {
    const response = await backend.speak(content, voice)
    const job = speechStatus(response)
    if (job?.id) return { job }
    // An absent response covers two different situations, and reporting both as
    // silence is what let a press that never reached Voice Operator log itself
    // as spoken. No discovery file means Voice Operator is simply not running,
    // which is a supported way to run — the caller still has its text and
    // stays quiet about the audio it was never going to make. Discovery
    // present and the request still failing is the other thing entirely: the
    // service is there and did not answer.
    if (response === undefined) {
      return this.deps.voiceOperatorDiscovered() ? { error: 'unreachable' } : {}
    }
    const error = (response.body as { error?: unknown } | undefined)?.error
    return { error: typeof error === 'string' ? error : 'rejected' }
  }
}

/**
 * A job that stopped before the listener heard all of it: talked over, or
 * cancelled by a client that went away. The channel's own cancel never gets
 * here — its monitor has already let go of the job.
 */
function wasCutOff(state: SpeechStatus['state']): boolean {
  return state === 'interrupted_by_user' || state === 'cancelled_by_client'
}

/** What was sent to be spoken, for comparing against what was heard; long answers trimmed. */
function quoteForLog(content: SpeechContent): string {
  const text = joinSpeechParts(content)
  return JSON.stringify(text.length <= 300 ? text : `${text.slice(0, 299)}…`)
}

/** Elapsed time since `startedAt`, for a log line. */
function sinceSeconds(startedAt: number): string {
  return `${((Date.now() - startedAt) / 1000).toFixed(1)}s`
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
 * So: while the channel is showing something that tracks the audio, poll
 * immediately and let SPEECH_POLL_INTERVAL_MS set the cadence. Once Voice
 * Operator is merely listening (`waiting_for_user`, mapped to `ready`) there
 * is nothing to track, and a job can sit there indefinitely — hand the waiting
 * back to the service rather than spinning on it.
 *
 * A service that reports `version` needs none of this: `?since=` wakes on every
 * change, so the monitor long-polls throughout and this is not consulted.
 */
function pollWaitSeconds(phase: SpeechPhase): number {
  return phase === 'ready' ? SPEECH_LONG_POLL_SECONDS : 0
}

/**
 * What an `in_progress` speech job's playback state means for the channel.
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
 * Now that the monitor polls fast enough to see those handoffs, a literal
 * reading would flicker the indicator in the gaps between an answer's own
 * sentences. An answer that has begun is speaking until it stops or ends,
 * however its synthesis is paced.
 *
 * Before the first sound, though, `queued` is exactly what it says — Voice
 * Operator is synthesizing — and the channel reports `synthesizing`. Note what
 * it never returns: `thinking`. Once a speech job exists, generation is done,
 * and `thinking` is the one phase that makes spaceterm audible.
 */
function playbackPhase(
  playbackState: SpeechStatus['playback_state'],
  current: SpeechPhase,
): SpeechPhase {
  // Older services did not send playback_state; assume audible for compatibility.
  if (playbackState === undefined || playbackState === 'speaking') return 'speaking'
  if (playbackState === 'waiting_for_user') return 'ready'
  return current === 'speaking' ? 'speaking' : 'synthesizing'
}
