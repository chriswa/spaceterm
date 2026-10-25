import { create } from 'zustand'
import type { DictationApi } from '../shared/api'
import { DICTATION_RESUME_GRACE_MS } from '../shared/dictation-resume'
import { ConnectionLostError } from '../shared/server-client'
import { reloadGuard } from '@/lib/reload-guard'
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
 *
 * A dropped connection does not end it. Every sample is kept until it ends,
 * each chunk sent says where it starts, and on every reconnect the server
 * says how much it has (`resume`) and the rest is sent from there. A finish
 * asked while the connection is down waits for it — up to the server's grace,
 * {@link DICTATION_RESUME_GRACE_MS} — and only then fails. Wi-Fi coming back
 * once dropped the socket mid-dictation and the stop that followed failed at
 * once, "Not connected to server" (October 2026).
 */

/** How much audio to batch per message: small enough to stream, large enough not to spam. */
const SEND_INTERVAL_MS = 200

/** The most one message carries: what a reconnect resends goes in pieces this size. */
const MAX_SEND_SAMPLES = TARGET_SAMPLE_RATE * 5

/** Why a finish gave up waiting for the connection. */
export const CONNECTION_GONE = `Lost the connection to the Mac, and it did not come back within ${DICTATION_RESUME_GRACE_MS / 1000} s, so this dictation could not be sent.`

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
  /**
   * Every sample of the dictation, 16 kHz s16, kept until it ends: a reconnect
   * resends from wherever the server got to. Grown by doubling; 32 kB a second.
   */
  private pcm = new Int16Array(TARGET_SAMPLE_RATE * 10)
  private pcmLength = 0
  /** Samples sent on this connection: where the next chunk starts. */
  private sent = 0
  /** Reconnected since the server last said how much it has: nothing is sent until it has. */
  private stale = false
  private resuming: Promise<void> | null = null
  /** Why the server's session is gone, for finish to say. */
  private lost: Error | null = null
  private readonly offConnect: () => void
  /** Holds off the page's own reload until the dictation is over: see reload-guard.ts. */
  private readonly releaseReload = reloadGuard.hold()
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
      this.keep(backlog)
      log(`starting with ${(backlog.length / TARGET_SAMPLE_RATE).toFixed(1)}s already heard`)
    }
    this.listenTo(capture)
    this.timer = window.setInterval(() => this.flush(), SEND_INTERVAL_MS)
    this.offConnect = api.onConnect(() => {
      this.stale = true
      void this.resync()
    })
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
      if (pcm.length > 0) this.keep(pcm)
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
      const text = await this.finishWhenConnected(id)
      // Only how much: nothing said is recorded.
      recordMobileEvent('dictation-transcribed', { chars: text.length, ms: Math.round(performance.now() - asked) })
      return text
    } catch (err) {
      recordMobileEvent('dictation-failed', { error: err instanceof Error ? err.message : String(err), ms: Math.round(performance.now() - asked) })
      throw err
    } finally {
      bump('transcribing', -1)
      this.offConnect()
      this.releaseReload()
    }
  }

  /**
   * Send what the server lacks and finish — once connected, and caught up
   * after a reconnect. A finish lost with the connection is asked again (the
   * server answers a repeat with the same words). Gives up when the
   * connection has not come back within the grace.
   */
  private async finishWhenConnected(id: string): Promise<string> {
    const deadline = performance.now() + DICTATION_RESUME_GRACE_MS
    for (;;) {
      if (!this.api.isConnected()) {
        log('finish: not connected; waiting for the connection to come back')
        recordMobileEvent('dictation-finish-waiting', {})
        if (!await this.connectedWithin(deadline - performance.now())) throw new Error(CONNECTION_GONE)
      }
      if (this.stale || this.resuming) await this.resync()
      if (this.lost) throw this.lost
      // The resume itself lost the connection: wait for the next one.
      if (this.stale) continue
      this.flush()
      try {
        return await this.api.finish(id)
      } catch (err) {
        if (!(err instanceof ConnectionLostError) || performance.now() >= deadline) throw err
        log(`finish: ${err.message}; asking again once reconnected`)
      }
    }
  }

  private connectedWithin(ms: number): Promise<boolean> {
    if (ms <= 0) return Promise.resolve(false)
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const off = this.api.onConnect(() => { clearTimeout(timer); off(); resolve(true) })
      timer = setTimeout(() => { off(); resolve(false) }, ms)
    })
  }

  /** Back after a drop: ask the server how much it has, and send the rest from there. */
  private resync(): Promise<void> {
    if (this.resuming) return this.resuming
    this.stale = false
    const id = this.id
    // No session yet: the start was lost with the connection, and finish says so.
    if (!id || this.lost || this.cancelled) return Promise.resolve()
    this.resuming = this.api.resume(id).then(
      (received) => {
        const seconds = (n: number) => (n / TARGET_SAMPLE_RATE).toFixed(1)
        log(`resumed after a reconnect: the server has ${seconds(received)}s of ${seconds(this.pcmLength)}s`)
        recordMobileEvent('dictation-resumed', { serverMs: Math.round(received / TARGET_SAMPLE_RATE * 1000), heldMs: Math.round(this.pcmLength / TARGET_SAMPLE_RATE * 1000) })
        this.sent = Math.min(received, this.pcmLength)
      },
      (err: unknown) => {
        // Dropped again before the answer: the next connect asks again.
        if (err instanceof ConnectionLostError) {
          this.stale = true
          return
        }
        this.lost = err instanceof Error ? err : new Error(String(err))
        log(`resume failed: ${this.lost.message}`)
        recordMobileEvent('dictation-resume-failed', { error: this.lost.message })
      },
    ).finally(() => {
      this.resuming = null
      this.flush()
    })
    return this.resuming
  }

  /** Abandon the dictation. `broken`: its microphone went silent, so a held one is closed too. */
  cancel({ broken = false }: { broken?: boolean } = {}): void {
    if (!this.stopped) {
      log(`cancel: ${this.describe()}`)
      recordMobileEvent('dictation-cancel', { broken, audio: this.stats.describe(this.capture.sampleRate) })
    }
    this.cancelled = true
    this.stopCapture(broken)
    this.offConnect()
    this.releaseReload()
    if (this.id) this.api.cancel(this.id)
  }

  private keep(block: Int16Array): void {
    const needed = this.pcmLength + block.length
    if (needed > this.pcm.length) {
      const grown = new Int16Array(Math.max(needed, this.pcm.length * 2))
      grown.set(this.pcm.subarray(0, this.pcmLength))
      this.pcm = grown
    }
    this.pcm.set(block, this.pcmLength)
    this.pcmLength = needed
  }

  /** Send what has not been sent on this connection, unless it is down or not yet caught up. */
  private flush(): void {
    const id = this.id
    if (!id || this.cancelled || this.stale || this.resuming || this.lost || !this.api.isConnected()) return
    while (this.sent < this.pcmLength) {
      const end = Math.min(this.pcmLength, this.sent + MAX_SEND_SAMPLES)
      this.api.audio(id, pcmToBase64(this.pcm.subarray(this.sent, end)), this.sent)
      this.sent = end
    }
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
