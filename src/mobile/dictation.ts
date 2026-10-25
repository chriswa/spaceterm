import { create } from 'zustand'
import type { DictationApi } from '../shared/api'
import { Downsampler, TARGET_SAMPLE_RATE, pcmToBase64 } from './pcm'
import { acquire, replaceSilentCapture, type Capture } from './held-microphone'
import { recordMobileEvent } from './mobile-events'
import { noteMicLevel } from './mic-level'

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
 * and every step logs what it saw so the next such failure says why. In the
 * iPhone app such a dictation carries on with the app's own microphone
 * (`replaceSilentCapture`), which that WebKit fault does not reach.
 */

/** How much audio to batch per message: small enough to stream, large enough not to spam. */
const SEND_INTERVAL_MS = 200

const log = (message: string) => window.api?.log(`[dictation] ${message}`)

/**
 * What every dictation on the page is doing, for the mark around the
 * Dynamic Island (MicIndicator.tsx) and the microphone button's orange:
 * `capturing` while audio is going to the transcriber — from its first block,
 * not from the microphone opening, which over AirPods can be seconds earlier
 * (an orange button then invited talking into nothing) — and `transcribing`
 * while the words are being waited for. A microphone merely held open —
 * hands-free mode listening for "Control" — is neither.
 */
export const useMicActivity = create<{ capturing: number; transcribing: number }>(() => ({ capturing: 0, transcribing: 0 }))
const bump = (key: 'capturing' | 'transcribing', by: number) =>
  useMicActivity.setState((s) => ({ [key]: Math.max(0, s[key] + by) }))

/** How long a granted microphone may stay silent before listening gives up on it. */
export const NO_AUDIO_TIMEOUT_MS = 2000

/**
 * The same, for the app's own microphone standing in for a silent one: its
 * engine turns echo cancellation on as it starts, and iOS stops it once for
 * that and it is started again (NativeMicrophone.swift), so first audio comes
 * up to a second later than WebKit's.
 */
const REPLACEMENT_AUDIO_TIMEOUT_MS = 3000

/**
 * A dictation that has begun, once sound is actually arriving — the moment a
 * start cue may honestly say "safe to talk". A microphone that is granted but
 * silent throws here instead, having been cancelled, rather than leaving a
 * Stop button over a recording of nothing.
 */
export async function whenHearing(pending: Promise<Dictation>): Promise<Dictation> {
  const dictation = await pending
  if (await heardWithin(dictation, NO_AUDIO_TIMEOUT_MS)) return dictation
  log(`no sound within ${NO_AUDIO_TIMEOUT_MS}ms: ${dictation.describe()}`)
  recordMobileEvent('dictation-no-audio', { withinMs: NO_AUDIO_TIMEOUT_MS, capture: dictation.describe() })
  if (await dictation.replaceSilentCapture() && await heardWithin(dictation, REPLACEMENT_AUDIO_TIMEOUT_MS)) return dictation
  // A held microphone that has gone silent is closed, so the next dictation opens a fresh one.
  dictation.cancel({ broken: true })
  throw new Error(dictation.sentOnlyZeros()
    ? 'The microphone is sending only silence: are your AirPods connected to another device? Try again, or take them out and put them back.'
    : 'The microphone is not sending any sound. Try again; if it keeps happening, reopen the app.')
}

function heardWithin(dictation: Dictation, ms: number): Promise<boolean> {
  return Promise.race([
    dictation.audioArrived.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), ms)),
  ])
}

/** Where a dictation's microphone comes from: held-microphone.ts, or a test's own. */
export interface Microphones {
  /** A capture for one dictation. Called inside the tap. */
  acquire(): Promise<Capture>
  /** Another microphone in place of one that has sent nothing, or undefined when there is none to try. */
  replaceSilent(capture: Capture): Promise<Capture | undefined>
}

const REAL_MICROPHONES: Microphones = { acquire, replaceSilent: replaceSilentCapture }

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

/** What a dictation may be begun with, beyond the microphone. */
export interface DictationOptions {
  /**
   * Audio already heard, 16 kHz s16 — sent ahead of the live audio. Called
   * once, at the moment live audio starts being taken, so the two meet with no
   * gap: hands-free mode hands over everything said since the wake word.
   */
  backlog?: () => Int16Array
  /** The words go to Control: see `DictationApi.start`. */
  forControl?: boolean
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
  /** Counted in `useMicActivity.capturing`: sound has arrived. */
  private counted = false
  private readonly began = performance.now()
  /**
   * Resolves with the first block of sound — the moment it is safe to talk.
   * Sound, not blocks: a block of exact zeros is a dead input, not a quiet
   * room, whose noise is never exactly zero. AirPods whose microphone had gone
   * elsewhere sent zeros for minutes (October 2026), and the button showed
   * orange over a recording of nothing until it was stopped.
   */
  readonly audioArrived: Promise<void>
  private heardSound = false

  /** Blocks came, every sample in them exactly zero: an input that is there but dead. */
  sentOnlyZeros(): boolean {
    return this.stats.blocks > 0 && !this.heardSound
  }
  private arrived: () => void = () => undefined

  /** Stops this dictation hearing the capture. */
  private unlisten: () => void = () => undefined

  private constructor(
    private readonly api: DictationApi,
    /** The microphone: held open between dictations, or this one's own. See held-microphone.ts. */
    private capture: Capture,
    started: Promise<string>,
    options: DictationOptions,
    private readonly microphones: Microphones,
  ) {
    this.audioArrived = new Promise((resolve) => { this.arrived = resolve })
    Dictation.live++
    const backlog = options.backlog?.()
    if (backlog && backlog.length > 0) {
      this.queued.push(backlog)
      log(`starting with ${(backlog.length / TARGET_SAMPLE_RATE).toFixed(1)}s already heard`)
    }
    this.listenTo(capture)
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

  private listenTo(capture: Capture): void {
    const resampler = new Downsampler(capture.sampleRate)
    this.unlisten = capture.listen((block) => {
      if (this.stats.blocks === 0) {
        log(`first audio after ${Math.round(performance.now() - this.began)}ms (${capture.describe()})`)
        recordMobileEvent('dictation-audio', { afterMs: Math.round(performance.now() - this.began) })
      }
      if (!this.heardSound && block.some((v) => v !== 0)) {
        this.heardSound = true
        if (this.stats.blocks > 0) {
          log(`first sound after ${Math.round(performance.now() - this.began)}ms, ${this.stats.blocks} block(s) of exact zeros before it`)
          recordMobileEvent('dictation-sound', { afterMs: Math.round(performance.now() - this.began), zeroBlocks: this.stats.blocks })
        }
        if (!this.counted && !this.stopped) {
          this.counted = true
          bump('capturing', 1)
        }
        this.arrived()
      }
      this.stats.push(block)
      noteMicLevel(block)
      const pcm = resampler.push(block)
      if (pcm.length > 0) this.queued.push(pcm)
    })
  }

  /**
   * Its microphone has sent nothing: carry on with another, where there is
   * one to try. The server session stays as it is — it has heard nothing
   * either. False when there is none, or it would not open; the dictation is
   * then as it was, still silent.
   */
  async replaceSilentCapture(): Promise<boolean> {
    if (this.stopped) return false
    const silent = this.capture
    this.unlisten()
    let next: Capture | undefined
    try {
      next = await this.microphones.replaceSilent(silent)
    } catch (err) {
      log(`no other microphone: ${err instanceof Error ? err.message : String(err)}`)
    }
    if (!next) {
      if (!this.stopped) this.listenTo(silent)
      return false
    }
    // Abandoned while the other one was opening.
    if (this.stopped) {
      next.release()
      return false
    }
    this.capture = next
    this.listenTo(next)
    return true
  }

  /**
   * Take the microphone and open a server session, in parallel. Call inside a
   * tap: a microphone that is not held open yet is opened here.
   */
  static async begin(api: DictationApi, options: DictationOptions = {}, microphones: Microphones = REAL_MICROPHONES): Promise<Dictation> {
    // Asked for before the first await, so a microphone that must be opened
    // is opened inside the tap, as iOS requires.
    const capturing = microphones.acquire()
    const started = api.start(TARGET_SAMPLE_RATE, options.forControl)
    started.catch(() => undefined)
    let capture: Capture
    try {
      capture = await capturing
    } catch (err) {
      void started.then((id) => api.cancel(id), () => undefined)
      recordMobileEvent('dictation-begin-failed', { error: err instanceof Error ? err.message : String(err) })
      throw err
    }
    log(`capture open: ${capture.describe()}, page ${document.visibilityState}`)
    recordMobileEvent('dictation-begin', { capture: capture.describe(), backlog: options.backlog !== undefined })
    return new Dictation(api, capture, started, options, microphones)
  }

  /** For the log when sound never came: what the capture looks like now. */
  describe(): string {
    return `${this.stats.describe(this.capture.sampleRate)}; ${this.capture.describe()}`
  }

  /** Stop listening and return the transcript, or throw with the server's reason. */
  async finish(): Promise<string> {
    log(`finish: ${this.describe()}`)
    recordMobileEvent('dictation-finish', { audio: this.stats.describe(this.capture.sampleRate) })
    this.stopCapture()
    const asked = performance.now()
    bump('transcribing', 1)
    try {
      const id = await this.started
      this.flush()
      const text = await this.api.finish(id)
      // Only how much: nothing said is recorded.
      recordMobileEvent('dictation-transcribed', { chars: text.length, ms: Math.round(performance.now() - asked) })
      return text
    } catch (err) {
      recordMobileEvent('dictation-failed', { error: err instanceof Error ? err.message : String(err), ms: Math.round(performance.now() - asked) })
      throw err
    } finally {
      bump('transcribing', -1)
    }
  }

  /** Abandon the dictation. `broken`: its microphone went silent, so a held one is closed too. */
  cancel({ broken = false }: { broken?: boolean } = {}): void {
    if (!this.stopped) {
      log(`cancel: ${this.describe()}`)
      recordMobileEvent('dictation-cancel', { broken, audio: this.stats.describe(this.capture.sampleRate) })
    }
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
    if (this.counted) bump('capturing', -1)
    window.clearInterval(this.timer)
    this.unlisten()
    this.capture.release(broken)
  }
}
