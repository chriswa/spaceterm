/**
 * Whether the user is dictating anywhere: on the phone (remote-dictation.ts),
 * or on the Mac with Voice Operator's own push-to-talk, which it reports over
 * hooks.sock as each dictation starts and ends. The receptionist stops when
 * they start, and holds until they finish (see `Receptionist.userSpeaking`),
 * so it hears one answer for both: one device finishing never releases it
 * while the other is still talking.
 *
 * A dictation ends only once its words are where they are going. Voice
 * Operator reports the end after it has transcribed and sent them; the phone's
 * for Control ends when the phone hands them over. So an end with no words
 * for Control means there are none, and Control carries on with what it was
 * doing.
 */

/** One report from Voice Operator of a Mac dictation starting or ending. */
export interface MacDictationReport {
  active: boolean
  /** Names the Voice Operator process: a new one starts its `seq` again. */
  launch: string
  /** Counts up with each report from one process. */
  seq: number
}

/**
 * How long a Mac dictation holds the receptionist without word of its end.
 * Voice Operator quitting mid-dictation never sends one; a relaunch does (its
 * first report says it is not dictating), and this covers it not coming back.
 * Far longer than anyone dictates in one breath.
 */
export const MAC_DICTATION_LIMIT_MS = 10 * 60_000

export interface DictationPresenceDeps {
  /** Run `fn` after `ms`, returning a way to call it off. */
  schedule(ms: number, fn: () => void): () => void
}

const REAL_DEPS: DictationPresenceDeps = {
  schedule: (ms, fn) => {
    const timer = setTimeout(fn, ms)
    return () => clearTimeout(timer)
  },
}

export class DictationPresence {
  private phoneSpeaking = false
  private macSpeaking = false
  private lastMac: { launch: string; seq: number } | undefined
  private cancelLimit: (() => void) | undefined

  constructor(
    private readonly onChange: (speaking: boolean) => void,
    private readonly deps: DictationPresenceDeps = REAL_DEPS,
  ) {}

  get speaking(): boolean { return this.phoneSpeaking || this.macSpeaking }

  /** Whether anyone is dictating on the phone, as remote-dictation.ts reports it. */
  phone(speaking: boolean): void {
    this.update(() => { this.phoneSpeaking = speaking })
  }

  /**
   * Voice Operator's report. Each comes over its own connection, so a report
   * older than one already taken is dropped: a stop overtaken by its start
   * would otherwise leave the receptionist held until the limit.
   */
  mac(report: MacDictationReport): void {
    const last = this.lastMac
    if (last && last.launch === report.launch && report.seq <= last.seq) return
    this.lastMac = { launch: report.launch, seq: report.seq }
    this.cancelLimit?.()
    this.cancelLimit = report.active
      ? this.deps.schedule(MAC_DICTATION_LIMIT_MS, () => this.update(() => { this.macSpeaking = false }))
      : undefined
    this.update(() => { this.macSpeaking = report.active })
  }

  private update(change: () => void): void {
    const before = this.speaking
    change()
    if (this.speaking !== before) this.onChange(this.speaking)
  }
}
