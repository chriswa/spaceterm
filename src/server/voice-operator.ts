import * as fs from 'fs'
import * as path from 'path'
import { homedir } from 'os'

/**
 * The local Voice Operator speech service, as spaceterm talks to it.
 *
 * Two features speak: Control, which runs a whole conversation and needs
 * the job lifecycle (poll, interrupt offsets, voices), and the direct path —
 * the speak-the-selection chord — which only needs "say this, stop that". Both used to own their own transport;
 * the direct one spawned a `cartesia-read` binary that no longer exists, and
 * failed silently for exactly as long as nobody pressed the chord.
 *
 * One client instead, so there is one answer to where the service lives, one
 * discovery format to keep up with, and one place that knows this service
 * answers with status codes rather than exceptions.
 */

/** Where Voice Operator publishes the port it is listening on. */
export const DISCOVERY_PATH = path.join(
  homedir(), 'Library', 'Application Support', 'VoiceOperator', 'speech-service.json',
)

/** A Voice Operator reply, or undefined when the service could not be reached. */
export type SpeechResponse = { status: number; body: unknown } | undefined

export type SpeechStatus = {
  id: string
  state: 'in_progress' | 'completed' | 'interrupted_by_user' | 'cancelled_by_client' | 'synthesis_failed'
  playback_state?: 'queued' | 'speaking' | 'waiting_for_user'
  character_offset?: number
  /**
   * Voice Operator's change cursor for this job, bumped on every observable
   * change. Absent on services predating it.
   */
  version?: number
}

/**
 * Everything this client reaches outside the process: HTTP, and the discovery
 * file. Narrow enough that a test supplies both without a network or a home
 * directory.
 */
export interface VoiceOperatorDeps {
  /** HTTP. Same shape as global `fetch`. */
  fetch: typeof fetch
  /** Voice Operator's discovery document, or undefined when it is not running. */
  readDiscovery(): { port?: unknown } | undefined
}

export const REAL_VOICE_OPERATOR_DEPS: VoiceOperatorDeps = {
  fetch: (...args) => fetch(...args),
  readDiscovery() {
    try {
      return JSON.parse(fs.readFileSync(DISCOVERY_PATH, 'utf8')) as { port?: unknown }
    } catch {
      return undefined
    }
  },
}

/** What a subscriber asks Voice Operator to send it, and where. */
export type SubscriberRegistration = {
  /** Absolute path of a Unix socket taking newline-delimited JSON. */
  socket: string
  /** Receive every command dictation as `{"type":"voice-command","text":…}`. */
  commands: boolean
  /** `dictation`: `{"type":"voice-dictation",active,launch,seq}` as each starts and ends. */
  events: 'dictation'[]
}

/** One stretch of speech in one voice. Unvoiced parts take the request's voice. */
export type SpeechPart = { text: string; voice?: string }

/**
 * What a speech job says: plain text in one voice, or parts that may each be
 * in a different voice.
 */
export type SpeechContent = string | readonly SpeechPart[]

const SPEECH_PART_SEPARATOR = ' '

/**
 * The text a speech job is made of — parts joined with a single space.
 *
 * The one statement of the convention Voice Operator's `character_offset` is
 * measured against (UTF-16 code units into this string), on both backends. A
 * caller that redacts an interrupted answer has to cut the same string the
 * offset was counted in, so nothing else should rebuild it.
 */
export function joinSpeechParts(content: SpeechContent): string {
  return typeof content === 'string' ? content : content.map(part => part.text).join(SPEECH_PART_SEPARATOR)
}

/** Where each part begins in `joinSpeechParts(parts)`. */
export function speechPartStarts(parts: readonly SpeechPart[]): number[] {
  const starts: number[] = []
  let at = 0
  for (const part of parts) {
    starts.push(at)
    at += part.text.length + SPEECH_PART_SEPARATOR.length
  }
  return starts
}

/**
 * The `POST /v1/speech` body. A string produces the single-voice body
 * unchanged, so services that predate parts keep working for everything that
 * does not use them.
 */
export function speechRequestBody(content: SpeechContent, voice?: string, device?: SpeechDevice): Record<string, unknown> {
  const target = device ? { client: device.client, device: device.device } : {}
  if (typeof content === 'string') return { text: content, ...(voice ? { voice } : {}), ...target }
  return {
    parts: content.map(part => {
      const partVoice = part.voice ?? voice
      return { text: part.text, ...(partVoice ? { voice: partVoice } : {}) }
    }),
    ...target,
  }
}

/**
 * A device that plays Voice Operator's speech itself — a phone's page, a
 * speaker on Voice Operator's client socket (voice-operator-speech.ts) — by
 * the client name and device name it said hello with.
 */
export interface SpeechDevice { client: string; device: string }

/** The speech job in a reply, if the reply carries one at all. */
export function speechStatus(response: SpeechResponse): SpeechStatus | undefined {
  const body = response?.body as SpeechStatus | undefined
  return typeof body?.id === 'string' && typeof body.state === 'string' ? body : undefined
}

/**
 * Somewhere speech jobs can be run: Voice Operator, playing on the Mac or on
 * a phone (`SpeechLinks.backend`), or nobody (`NO_LISTENER`). All answer in
 * Voice Operator's job format, so Control follows any of them the same way.
 */
export type SpeechBackend = Pick<VoiceOperator, 'speak' | 'status' | 'drop'>

export class VoiceOperator {
  constructor(private readonly deps: VoiceOperatorDeps = REAL_VOICE_OPERATOR_DEPS) {}

  /** Whether Voice Operator is publishing a port at all. */
  isRunning(): boolean {
    return this.port() !== undefined
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
  async request(endpoint: string, init?: RequestInit, timeoutMs = 3_000): Promise<SpeechResponse> {
    const port = this.port()
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

  /**
   * Queue speech. A string is one voice, exactly as it always was; parts each
   * name their own voice, falling back to `voice`. See `SpeechContent`. With
   * `device`, it plays there instead of on the Mac: `404 unknown_device` when
   * that device is not connected.
   */
  speak(content: SpeechContent, voice?: string, init?: RequestInit, device?: SpeechDevice): Promise<SpeechResponse> {
    return this.request('/v1/speech', {
      ...init, method: 'POST', body: JSON.stringify(speechRequestBody(content, voice, device)),
    })
  }

  /**
   * Drop a job, wherever it is in its lifecycle, answering with how far the
   * listener got. `heardUntil` (epoch ms): they stopped hearing it then, not
   * now — they began talking over it, and the cut was only decided later. What
   * was heard is counted up to then: by Voice Operator (`heard_until`, on the
   * Mac's clock, which it shares with this server), on the Mac or a phone. A
   * Voice Operator from before October 15 2026 ignores it, and counts up to
   * the drop.
   */
  drop(speechId: string, heardUntil?: number): Promise<SpeechResponse> {
    const query = heardUntil === undefined ? '' : `?heard_until=${Math.round(heardUntil)}`
    return this.request(`/v1/speech/${encodeURIComponent(speechId)}${query}`, { method: 'DELETE' })
  }

  /** One job's current status. `wait` parks the service until something changes. */
  status(
    speechId: string, opts: { wait?: number; since?: number } = {}, init?: RequestInit, timeoutMs?: number,
  ): Promise<SpeechResponse> {
    const wait = opts.wait ?? 0
    const since = opts.since === undefined ? '' : `&since=${opts.since}`
    return this.request(`/v1/speech/${encodeURIComponent(speechId)}?wait=${wait}${since}`, init, timeoutMs)
  }

  // ─── remote transcription ───────────────────────────────────────────────
  //
  // Voice Operator owns the Wispr session (its refresh tokens rotate, so only
  // one process may hold them) and the streaming connection. These relay audio
  // captured elsewhere — the phone — through it. See RemoteDictation.

  /** Open a transcription; Voice Operator starts streaming to Wispr at once. */
  startTranscription(sampleRate: number): Promise<SpeechResponse> {
    return this.request('/v1/transcriptions', { method: 'POST', body: JSON.stringify({ sample_rate: sampleRate }) })
  }

  /** Raw PCM, signed 16-bit little-endian mono, at the session's rate. */
  sendTranscriptionAudio(id: string, pcm: Uint8Array): Promise<SpeechResponse> {
    return this.request(`/v1/transcriptions/${encodeURIComponent(id)}/audio`, {
      method: 'POST', body: new Uint8Array(pcm), headers: { 'content-type': 'application/octet-stream' },
    }, 10_000)
  }

  /** No more audio: wait for the final text. Slow paths take seconds, hence the timeout. */
  finishTranscription(id: string): Promise<SpeechResponse> {
    return this.request(`/v1/transcriptions/${encodeURIComponent(id)}/finish`, { method: 'POST' }, 30_000)
  }

  cancelTranscription(id: string): Promise<SpeechResponse> {
    return this.request(`/v1/transcriptions/${encodeURIComponent(id)}`, { method: 'DELETE' })
  }

  /**
   * Hands-free: does this clip start with the wake word (`start`), or is it
   * the word alone (`only`)? Raw s16le mono PCM at 16 kHz. Checked by Apple's on-device model, never Wispr. The first check
   * after Voice Operator starts loads the model, about a second.
   */
  checkWakeWord(pcm: Uint8Array, word: string, match: 'start' | 'only' | 'speech'): Promise<SpeechResponse> {
    return this.request(`/v1/wake-word?word=${encodeURIComponent(word)}&match=${match}&sample_rate=16000`, {
      method: 'POST', body: new Uint8Array(pcm), headers: { 'content-type': 'application/octet-stream' },
    }, 5_000)
  }

  /** Every voice the service offers, unfiltered. */
  voices(): Promise<SpeechResponse> {
    return this.request('/v1/voices')
  }

  /**
   * Register (or refresh) this process as a Voice Operator subscriber: where
   * it should send command dictations and dictation start/end events. Voice
   * Operator saves it, so it outlives Voice Operator restarts; repeating it is
   * harmless. 404 means a Voice Operator too old to take registrations. See
   * voice-operator-subscription.ts.
   */
  subscribe(name: string, registration: SubscriberRegistration): Promise<SpeechResponse> {
    return this.request(`/v1/subscribers/${encodeURIComponent(name)}`, {
      method: 'PUT', body: JSON.stringify(registration),
    })
  }

  private port(): number | undefined {
    const discovery = this.deps.readDiscovery()
    if (!discovery) return undefined
    const port = discovery.port
    return typeof port === 'number' && port > 0 && port < 65536 ? port : undefined
  }
}
