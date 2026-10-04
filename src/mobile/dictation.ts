import type { DictationApi } from '../shared/api'
import { Downsampler, TARGET_SAMPLE_RATE, pcmToBase64 } from './pcm'
import { acquire, type Capture } from './held-microphone'

/**
 * One dictation: the microphone, streamed to the server as it is spoken.
 *
 * Streaming rather than recording-then-uploading is the point. Voice Operator
 * opens Wispr's stream the moment the session starts, so by the time you lift
 * your finger only the tail is left to transcribe.
 *
 * Audio captured before the server has answered `start` is held and sent once
 * it has — the first syllable is usually spoken before the round trip lands.
 *
 * iOS can hand back a microphone that is granted, "live", and silent — no
 * samples at all, seen after switching away from the app and back. Nothing
 * fails, so `audioArrived` is the only honest signal that listening has begun,
 * and every step logs what it saw so the next such failure says why.
 */

/** How much audio to batch per message: small enough to stream, large enough not to spam. */
const SEND_INTERVAL_MS = 200

const log = (message: string) => window.api?.log(`[dictation] ${message}`)

/** How long a granted microphone may stay silent before listening gives up on it. */
export const NO_AUDIO_TIMEOUT_MS = 2000

/**
 * A dictation that has begun, once sound is actually arriving — the moment a
 * start cue may honestly say "safe to talk". A microphone that is granted but
 * silent throws here instead, having been cancelled, rather than leaving a
 * Stop button over a recording of nothing.
 */
export async function whenHearing(pending: Promise<Dictation>): Promise<Dictation> {
  const dictation = await pending
  const heard = await Promise.race([
    dictation.audioArrived.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), NO_AUDIO_TIMEOUT_MS))
  ])
  if (heard) return dictation
  log(`no sound within ${NO_AUDIO_TIMEOUT_MS}ms: ${dictation.describe()}`)
  // A held microphone that has gone silent is closed, so the next dictation opens a fresh one.
  dictation.cancel({ broken: true })
  throw new Error('The microphone is not sending any sound. Try again; if it keeps happening, reopen the app.')
}

/** What the microphone has delivered so far — counted, not kept. */
export class AudioStats {
  blocks = 0
  samples = 0
  /** Loudest sample, 0..1: tells silence (a zeroed stream) from no stream. */
  peak = 0

  push(block: Float32Array): void {
    this.blocks++
    this.samples += block.length
    for (let i = 0; i < block.length; i++) {
      const v = Math.abs(block[i])
      if (v > this.peak) this.peak = v
    }
  }

  describe(sampleRate: number): string {
    const seconds = sampleRate > 0 ? this.samples / sampleRate : 0
    const db = this.peak > 0 ? `${(20 * Math.log10(this.peak)).toFixed(0)} dBFS` : 'silent'
    return `${this.blocks} blocks, ${seconds.toFixed(1)}s, peak ${db}`
  }
}

export class Dictation {
  /**
   * Dictations capturing now, on this page. Hands-free mode stands aside while
   * one it did not start is under way.
   */
  static live = 0

  private id: string | null = null
  private queued: Int16Array[] = []
  private timer: number | undefined
  /** Capture has stopped, whether to finish or to cancel. */
  private stopped = false
  /** Abandoned: the session, whenever it arrives, is to be thrown away. */
  private cancelled = false
  private readonly stats = new AudioStats()
  private readonly began = performance.now()
  /** Resolves with the first block of sound — the moment it is safe to talk. */
  readonly audioArrived: Promise<void>

  /** Stops this dictation hearing the capture. */
  private readonly unlisten: () => void

  private constructor(
    private readonly api: DictationApi,
    /** The microphone: held open between dictations, or this one's own. See held-microphone.ts. */
    private readonly capture: Capture,
    started: Promise<string>,
  ) {
    const resampler = new Downsampler(capture.sampleRate)
    let arrived: () => void = () => undefined
    this.audioArrived = new Promise((resolve) => { arrived = resolve })
    Dictation.live++
    this.unlisten = capture.listen((block) => {
      if (this.stats.blocks === 0) {
        log(`first audio after ${Math.round(performance.now() - this.began)}ms (${capture.describe()})`)
        arrived()
      }
      this.stats.push(block)
      const pcm = resampler.push(block)
      if (pcm.length > 0) this.queued.push(pcm)
    })
    this.timer = window.setInterval(() => this.flush(), SEND_INTERVAL_MS)
    started.then(
      (id) => {
        if (this.cancelled) {
          api.cancel(id)
          return
        }
        this.id = id
        this.flush()
      },
      () => undefined // surfaced by finish(), which awaits the same promise
    )
    this.started = started
  }

  private readonly started: Promise<string>

  /**
   * Take the microphone and open a server session, in parallel. Call inside a
   * tap: a microphone that is not held open yet is opened here.
   */
  static async begin(api: DictationApi): Promise<Dictation> {
    // Asked for before the first await, so a microphone that must be opened
    // is opened inside the tap, as iOS requires.
    const capturing = acquire()
    const started = api.start(TARGET_SAMPLE_RATE)
    started.catch(() => undefined)
    let capture: Capture
    try {
      capture = await capturing
    } catch (err) {
      void started.then((id) => api.cancel(id), () => undefined)
      throw err
    }
    log(`capture open: ${capture.describe()}, page ${document.visibilityState}`)
    return new Dictation(api, capture, started)
  }

  /** For the log when sound never came: what the capture looks like now. */
  describe(): string {
    return `${this.stats.describe(this.capture.sampleRate)}; ${this.capture.describe()}`
  }

  /** Stop listening and return the transcript, or throw with the server's reason. */
  async finish(): Promise<string> {
    log(`finish: ${this.describe()}`)
    this.stopCapture()
    const id = await this.started
    this.flush()
    return this.api.finish(id)
  }

  /** Abandon the dictation. `broken`: its microphone went silent, so a held one is closed too. */
  cancel({ broken = false }: { broken?: boolean } = {}): void {
    if (!this.stopped) log(`cancel: ${this.describe()}`)
    this.cancelled = true
    this.stopCapture(broken)
    if (this.id) this.api.cancel(this.id)
  }

  private flush(): void {
    if (!this.id || this.queued.length === 0) return
    const total = this.queued.reduce((n, b) => n + b.length, 0)
    const joined = new Int16Array(total)
    let offset = 0
    for (const block of this.queued) {
      joined.set(block, offset)
      offset += block.length
    }
    this.queued = []
    this.api.audio(this.id, pcmToBase64(joined))
  }

  private stopCapture(broken = false): void {
    if (this.stopped) return
    this.stopped = true
    Dictation.live--
    window.clearInterval(this.timer)
    this.unlisten()
    this.capture.release(broken)
  }
}
