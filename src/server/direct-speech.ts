import { serverLog } from './server-log'
import { VoiceOperator, speechStatus, type SpeechStatus } from './voice-operator'
import { cleanTerminalCopy } from '../shared/cleanTerminalCopy'
import { cartesiaFixup } from '../shared/cartesiaFixup'

/**
 * Speech for text that is handed to us already written: the MCP `TTS` tool, the
 * `spaceterm-speak` CLI, and the speak-the-selection chord.
 *
 * Distinct from Summary Chat, which runs a model to *produce* what it speaks
 * and keeps a per-surface conversation around it. This path has no
 * conversation, no surface, and nothing to follow up on — one utterance at a
 * time, and a way to shut it up.
 *
 * It lives on the server rather than in the renderer because Voice Operator is
 * a local HTTP service and the server is what talks to it (see
 * `voice-operator.ts`). The renderer used to own this path and drove a
 * `cartesia-read` subprocess through the main process; that binary is gone, and
 * with it the queue, the gap timer, and the availability plumbing this replaces
 * — Voice Operator queues jobs itself.
 */

/** What a speak request did, as far as the listener is concerned. */
export type SpeakOutcome =
  | 'started'
  | 'stopped'
  /** Voice Operator is not running, or stopped answering. */
  | 'unavailable'
  /** Voice Operator is running and declined: speech is muted. */
  | 'muted'
  /** Nothing to say — empty text, or text that cleaned down to nothing. */
  | 'empty'

/** How long a status long-poll parks before the service answers anyway. */
const POLL_WAIT_SECONDS = 25
const POLL_TIMEOUT_MS = (POLL_WAIT_SECONDS + 5) * 1_000

export interface DirectSpeechDeps {
  vo: VoiceOperator
  /** Told whenever the "something is being spoken" answer changes. */
  onActiveChanged(active: boolean): void
}

export class DirectSpeech {
  /**
   * Jobs Voice Operator has accepted and not yet finished.
   *
   * A set rather than one id because the service queues: two MCP calls in quick
   * succession are two live jobs, and a stop gesture means both. Tracked at all
   * — rather than asking the service what is playing — because only these are
   * *ours*; Summary Chat's jobs are on the same service and must survive a
   * chord aimed at a spoken selection.
   */
  private readonly jobs = new Set<string>()

  constructor(private readonly deps: DirectSpeechDeps) {}

  /** Whether anything this path started is still queued or speaking. */
  isActive(): boolean {
    return this.jobs.size > 0
  }

  /**
   * Speak `text`, cleaned the way the clipboard path cleans it.
   *
   * The cleanup is not optional here, unlike the toolbar's Copy Cleanup toggle:
   * that toggle is about what lands in the clipboard, and terminal decoration
   * read aloud is never what anyone meant.
   */
  async speak(text: string): Promise<SpeakOutcome> {
    const cleaned = cartesiaFixup(cleanTerminalCopy(text))
    if (!cleaned.trim()) return 'empty'

    const response = await this.deps.vo.speak(cleaned)
    const job = speechStatus(response)
    if (!job?.id) {
      // Named rather than reported as silence. A listener who pressed the chord
      // and heard nothing deserves to know which of "muted", "not running" and
      // "broken" they are looking at — reporting all three as failure is what
      // let a dead engine go unnoticed for as long as it did.
      const error = (response?.body as { error?: unknown } | undefined)?.error
      const outcome = error === 'speech_muted' ? 'muted' : 'unavailable'
      serverLog(`[speech] Voice Operator did not take the job: ${outcome}`)
      return outcome
    }

    const wasActive = this.isActive()
    this.jobs.add(job.id)
    if (!wasActive) this.deps.onActiveChanged(true)
    serverLog(`[speech] speaking ${job.id} (${cleaned.length} chars)`)
    void this.monitor(job)
    return 'started'
  }

  /** Drop everything this path has running. Safe when nothing is. */
  async stop(): Promise<void> {
    const ids = [...this.jobs]
    this.jobs.clear()
    if (ids.length) this.deps.onActiveChanged(false)
    await Promise.all(ids.map(id => this.deps.vo.drop(id)))
  }

  /**
   * One gesture that means "say this, or shut up if you are already talking".
   *
   * Decided here rather than in the renderer, because only this side knows
   * whether a job is still live: the renderer's copy of that used to be a
   * boolean it set when it started speaking and cleared when its subprocess
   * exited, which is exactly the kind of second opinion that drifts.
   */
  async toggle(text: string): Promise<SpeakOutcome> {
    if (this.isActive()) {
      await this.stop()
      return 'stopped'
    }
    return this.speak(text)
  }

  /** Follow a job until it ends, so `isActive` means something. */
  private async monitor(job: SpeechStatus): Promise<void> {
    let cursor = job.version
    while (this.jobs.has(job.id)) {
      const response = await this.deps.vo.status(
        job.id,
        { wait: POLL_WAIT_SECONDS, ...(cursor === undefined ? {} : { since: cursor }) },
        undefined,
        POLL_TIMEOUT_MS,
      )
      // Stopped while we were parked: `stop` already settled the state, and the
      // job id is no longer ours to reason about.
      if (!this.jobs.has(job.id)) return
      const status = speechStatus(response)
      if (!status) {
        // The service stopped answering about a job it had accepted. Settling
        // is right — the gesture must not be wedged "speaking" forever — but it
        // is not the same as finishing, so it says so.
        serverLog(`[speech] lost track of ${job.id}`)
        this.forget(job.id)
        return
      }
      if (status.state !== 'in_progress') {
        serverLog(`[speech] ${job.id} ended as ${status.state}`)
        this.forget(job.id)
        return
      }
      // A poll that did not advance the cursor told us nothing new; without the
      // floor a service that ignores `since` would spin this loop.
      const advanced = cursor !== undefined && status.version !== undefined && status.version > cursor
      cursor = status.version
      if (!advanced && cursor === undefined) await new Promise(r => setTimeout(r, 1_000))
    }
  }

  private forget(id: string): void {
    this.jobs.delete(id)
    if (!this.isActive()) this.deps.onActiveChanged(false)
  }
}
