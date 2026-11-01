/**
 * Control's attention to the user in hands-free — whether they need to say
 * "Control" first — kept here, on the client's side, where Voice Operator's
 * protocol puts it: Voice Operator only listens the way it is told
 * (`attention` on its socket), and reports what this needs to decide.
 *
 * - **Engaged** — no "Control" needed — on `engage()`: as hands-free comes
 *   on, and whenever the user speaks to Control.
 * - **Lapsed** once nobody has spoken on the source for `engagedMs` (Voice
 *   Operator's `quiet`): the user may not know, so speech without "Control"
 *   gets the alarm. After `alarmLimit` alarms Control stops sounding them:
 *   attention is dismissed.
 * - **Dismissed** on `dismiss()`: the user ended it themselves ("stop
 *   listening", "stop talking") and knows, so no alarm at all.
 *
 * Voice Operator plays "conversation closed" whenever attention stops being
 * engaged, so what the user hears always matches what it listens for. The
 * Swift twin, for Claude Code's voice mode, is Voice Operator's
 * `AttentionKeeper.swift`.
 */

export type Attention = 'engaged' | 'lapsed' | 'dismissed'

/** What Voice Operator is told: `closesAt` (wall ms) is when engaged attention lapses if nobody speaks, for the button to draw. */
export interface AttentionMessage {
  type: 'attention'
  state: Attention
  closesAt: number | null
}

/** How long attention stays engaged through quiet, unless Voice Operator's `session` suggests otherwise (its menu). */
export const DEFAULT_ENGAGED_MS = 15_000
/** Alarms sounded after attention lapses before it is dismissed, quietly. */
export const ALARM_LIMIT = 3

export class AttentionKeeper {
  engagedMs = DEFAULT_ENGAGED_MS
  private current: Attention = 'lapsed'
  private quiet = false
  private closesAt: number | null = null
  private timer: ReturnType<typeof setTimeout> | undefined
  private alarms = 0

  constructor(private readonly send: (message: AttentionMessage) => void) {}

  get attention(): Attention { return this.current }

  /** No "Control" needed, until it lapses. */
  engage(): void {
    this.current = 'engaged'
    this.alarms = 0
    this.schedule()
  }

  /** The user ended it: "Control" from here, and no alarm. */
  dismiss(): void { this.set('dismissed') }

  /** Voice Operator's `state`: whether anyone is speaking on the source. */
  see(quiet: boolean): void {
    if (quiet === this.quiet) return
    this.quiet = quiet
    if (this.current === 'engaged') this.schedule()
  }

  /** Say it again, as it stands: Voice Operator may have lost it (a stream resumed). */
  restate(): void {
    if (this.current === 'engaged') this.schedule()
    else this.send({ type: 'attention', state: this.current, closesAt: null })
  }

  /** Voice Operator sounded the alarm (its `notWakeWord` cue). */
  alarmed(): void {
    if (this.current !== 'lapsed') return
    this.alarms++
    if (this.alarms >= ALARM_LIMIT) this.set('dismissed')
  }

  /** Hands-free went off: nothing to keep. */
  reset(): void {
    this.stopTimer()
    this.current = 'lapsed'
    this.quiet = false
    this.alarms = 0
  }

  private set(next: Attention): void {
    this.stopTimer()
    this.current = next
    this.alarms = 0
    this.send({ type: 'attention', state: next, closesAt: null })
  }

  /** Engaged: held while anyone speaks, and timed from when they stop. */
  private schedule(): void {
    this.stopTimer()
    if (this.quiet) {
      this.closesAt = Date.now() + this.engagedMs
      this.timer = setTimeout(() => {
        this.timer = undefined
        if (this.current === 'engaged') this.set('lapsed')
      }, this.engagedMs)
    }
    this.send({ type: 'attention', state: 'engaged', closesAt: this.closesAt })
  }

  private stopTimer(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    this.closesAt = null
  }
}
