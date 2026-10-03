import type { DictationApi } from '../shared/api'
import { Downsampler, TARGET_SAMPLE_RATE, pcmToBase64 } from './pcm'
import { beginRecordingSession } from './audio-session'

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
  dictation.cancel()
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

/** The state of everything between the microphone and the worklet, for the log. */
function describeCapture(stream: MediaStream, context: AudioContext): string {
  const tracks = stream.getAudioTracks().map((t) => `${t.readyState}${t.muted ? ' muted' : ''}${t.enabled ? '' : ' disabled'} "${t.label}"`)
  return `context ${context.state} @${context.sampleRate}Hz, track ${tracks.join(', ') || 'none'}`
}

const WORKLET = `
class Tap extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0]
    if (channel) this.port.postMessage(channel.slice(0))
    return true
  }
}
registerProcessor('spaceterm-tap', Tap)
`

export class Dictation {
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

  private constructor(
    private readonly api: DictationApi,
    private readonly stream: MediaStream,
    private readonly context: AudioContext,
    private readonly node: AudioWorkletNode,
    started: Promise<string>,
    /** Hands the audio session back to playback; see audio-session.ts. */
    private readonly releaseSession: () => void
  ) {
    const resampler = new Downsampler(context.sampleRate)
    let arrived: () => void = () => undefined
    this.audioArrived = new Promise((resolve) => { arrived = resolve })
    node.port.onmessage = (event: MessageEvent<Float32Array>) => {
      if (this.stats.blocks === 0) {
        log(`first audio after ${Math.round(performance.now() - this.began)}ms (${describeCapture(stream, context)})`)
        arrived()
      }
      this.stats.push(event.data)
      const pcm = resampler.push(event.data)
      if (pcm.length > 0) this.queued.push(pcm)
    }
    context.onstatechange = () => log(`context now ${context.state}`)
    for (const track of stream.getAudioTracks()) {
      track.onmute = () => log('track muted')
      track.onunmute = () => log('track unmuted')
      track.onended = () => { if (!this.stopped) log('track ended while listening') }
    }
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

  /** Ask for the microphone and open a server session, in parallel. */
  static async begin(api: DictationApi): Promise<Dictation> {
    // Created before the first await: iOS only lets audio start inside the
    // tap that asked for it, and an await ends the tap.
    const context = new AudioContext()
    void context.resume()
    const started = api.start(TARGET_SAMPLE_RATE)
    started.catch(() => undefined)
    // Earpiece-default play-and-record only while the microphone is open.
    const releaseSession = beginRecordingSession()
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      })
    } catch (err) {
      releaseSession()
      void context.close()
      void started.then((id) => api.cancel(id), () => undefined)
      log(`getUserMedia refused: ${err instanceof Error ? `${err.name} ${err.message}` : String(err)} (secure ${window.isSecureContext}, page ${document.visibilityState})`)
      throw new Error(
        window.isSecureContext
          ? 'Microphone permission was refused'
          : 'The microphone needs HTTPS — open Spaceterm through its tailscale address'
      )
    }
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }))
    try {
      await context.audioWorklet.addModule(url)
      const source = context.createMediaStreamSource(stream)
      const node = new AudioWorkletNode(context, 'spaceterm-tap')
      source.connect(node)
      log(`capture open: ${describeCapture(stream, context)}, page ${document.visibilityState}`)
      return new Dictation(api, stream, context, node, started, releaseSession)
    } catch (err) {
      stream.getTracks().forEach((t) => t.stop())
      releaseSession()
      void context.close()
      void started.then((id) => api.cancel(id), () => undefined)
      throw err
    } finally {
      URL.revokeObjectURL(url)
    }
  }

  /** For the log when sound never came: what the capture looks like now. */
  describe(): string {
    return `${this.stats.describe(this.context.sampleRate)}; ${describeCapture(this.stream, this.context)}`
  }

  /** Stop listening and return the transcript, or throw with the server's reason. */
  async finish(): Promise<string> {
    log(`finish: ${this.describe()}`)
    this.stopCapture()
    const id = await this.started
    this.flush()
    return this.api.finish(id)
  }

  cancel(): void {
    if (!this.stopped) log(`cancel: ${this.describe()}`)
    this.cancelled = true
    this.stopCapture()
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

  private stopCapture(): void {
    if (this.stopped) return
    this.stopped = true
    window.clearInterval(this.timer)
    this.node.port.onmessage = null
    this.node.disconnect()
    this.stream.getTracks().forEach((t) => t.stop())
    void this.context.close()
    this.releaseSession()
  }
}
