import type { DictationApi } from '../shared/api'
import { Downsampler, TARGET_SAMPLE_RATE, pcmToBase64 } from './pcm'

/**
 * One dictation: the microphone, streamed to the server as it is spoken.
 *
 * Streaming rather than recording-then-uploading is the point. Voice Operator
 * opens Wispr's stream the moment the session starts, so by the time you lift
 * your finger only the tail is left to transcribe.
 *
 * Audio captured before the server has answered `start` is held and sent once
 * it has — the first syllable is usually spoken before the round trip lands.
 */

/** How much audio to batch per message: small enough to stream, large enough not to spam. */
const SEND_INTERVAL_MS = 200

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

  private constructor(
    private readonly api: DictationApi,
    private readonly stream: MediaStream,
    private readonly context: AudioContext,
    private readonly node: AudioWorkletNode,
    started: Promise<string>
  ) {
    const resampler = new Downsampler(context.sampleRate)
    node.port.onmessage = (event: MessageEvent<Float32Array>) => {
      const pcm = resampler.push(event.data)
      if (pcm.length > 0) this.queued.push(pcm)
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
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      })
    } catch {
      void context.close()
      void started.then((id) => api.cancel(id), () => undefined)
      throw new Error(
        window.isSecureContext
          ? 'Microphone permission was refused'
          : 'The microphone needs HTTPS — open Spaceterm through its tailscale address'
      )
    }
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }))
    try {
      await context.audioWorklet.addModule(url)
    } finally {
      URL.revokeObjectURL(url)
    }
    const source = context.createMediaStreamSource(stream)
    const node = new AudioWorkletNode(context, 'spaceterm-tap')
    source.connect(node)
    return new Dictation(api, stream, context, node, started)
  }

  /** Stop listening and return the transcript, or throw with the server's reason. */
  async finish(): Promise<string> {
    this.stopCapture()
    const id = await this.started
    this.flush()
    return this.api.finish(id)
  }

  cancel(): void {
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
  }
}
