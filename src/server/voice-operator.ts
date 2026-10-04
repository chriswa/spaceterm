import * as fs from 'fs'
import * as path from 'path'
import { homedir } from 'os'

/**
 * The local Voice Operator speech service, as spaceterm talks to it.
 *
 * Two features speak: Summary Chat, which runs a whole conversation and needs
 * the job lifecycle (poll, interrupt offsets, voices), and the direct path —
 * the MCP `TTS` tool, `spaceterm-speak`, and the speak-the-selection chord —
 * which only needs "say this, stop that". Both used to own their own transport;
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
export function speechRequestBody(content: SpeechContent, voice?: string): Record<string, unknown> {
  if (typeof content === 'string') return { text: content, ...(voice ? { voice } : {}) }
  return {
    parts: content.map(part => {
      const partVoice = part.voice ?? voice
      return { text: part.text, ...(partVoice ? { voice: partVoice } : {}) }
    }),
  }
}

/** The speech job in a reply, if the reply carries one at all. */
export function speechStatus(response: SpeechResponse): SpeechStatus | undefined {
  const body = response?.body as SpeechStatus | undefined
  return typeof body?.id === 'string' && typeof body.state === 'string' ? body : undefined
}

/**
 * Somewhere speech jobs can be run: Voice Operator itself, which plays on the
 * Mac, or `RemoteSpeech`, which plays on a phone. Both answer in Voice
 * Operator's job format, so Summary Chat follows either the same way.
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
   * name their own voice, falling back to `voice`. See `SpeechContent`.
   */
  speak(content: SpeechContent, voice?: string, init?: RequestInit): Promise<SpeechResponse> {
    return this.request('/v1/speech', {
      ...init, method: 'POST', body: JSON.stringify(speechRequestBody(content, voice)),
    })
  }

  /** Ask Voice Operator to drop a job, wherever it is in its lifecycle. */
  drop(speechId: string): Promise<SpeechResponse> {
    return this.request(`/v1/speech/${encodeURIComponent(speechId)}`, { method: 'DELETE' })
  }

  /** One job's current status. `wait` parks the service until something changes. */
  status(
    speechId: string, opts: { wait?: number; since?: number } = {}, init?: RequestInit, timeoutMs?: number,
  ): Promise<SpeechResponse> {
    const wait = opts.wait ?? 0
    const since = opts.since === undefined ? '' : `&since=${opts.since}`
    return this.request(`/v1/speech/${encodeURIComponent(speechId)}?wait=${wait}${since}`, init, timeoutMs)
  }

  /**
   * The audio for one piece of text, handed back rather than played: signed
   * 16-bit mono PCM and its rate, and where each word falls in it. Undefined
   * when Voice Operator could not be reached or could not synthesize. See
   * RemoteSpeech.
   */
  async synthesize(text: string, voice?: string, signal?: AbortSignal): Promise<SynthesizedSpeech | undefined> {
    const port = this.port()
    if (port === undefined) return undefined
    try {
      const response = await this.deps.fetch(`http://127.0.0.1:${port}/v1/synthesize`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, ...(voice ? { voice } : {}), word_timings: true }),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000),
      })
      if (response.status !== 200) return undefined
      // An older Voice Operator ignores `word_timings` and answers with the bare WAV.
      if (!response.headers.get('content-type')?.includes('json')) {
        return parseWav(new Uint8Array(await response.arrayBuffer()))
      }
      return parseTimedSynthesis(await response.json())
    } catch {
      return undefined
    }
  }

  // ─── remote transcription ───────────────────────────────────────────────
  //
  // Voice Operator owns the Wispr session (its refresh tokens rotate, so only
  // one process may hold them) and the streaming connection. These relay audio
  // captured elsewhere — the phone — through it. See RemoteDictation.

  /**
   * Open a transcription; Voice Operator starts streaming to Wispr at once.
   * `watch`: a phrase it listens for alongside, on-device; the audio post
   * that follows its being heard answers 200 `{ heard: true }`.
   */
  startTranscription(sampleRate: number, watch?: string): Promise<SpeechResponse> {
    return this.request('/v1/transcriptions', { method: 'POST', body: JSON.stringify({ sample_rate: sampleRate, ...(watch ? { watch } : {}) }) })
  }

  /** Raw PCM, signed 16-bit little-endian mono, at the session's rate. 204, or 200 once a watched-for phrase is heard. */
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
  checkWakeWord(pcm: Uint8Array, word: string, match: 'start' | 'only'): Promise<SpeechResponse> {
    return this.request(`/v1/wake-word?word=${encodeURIComponent(word)}&match=${match}&sample_rate=16000`, {
      method: 'POST', body: new Uint8Array(pcm), headers: { 'content-type': 'application/octet-stream' },
    }, 5_000)
  }

  /** Every voice the service offers, unfiltered. */
  voices(): Promise<SpeechResponse> {
    return this.request('/v1/voices')
  }

  private port(): number | undefined {
    const discovery = this.deps.readDiscovery()
    if (!discovery) return undefined
    const port = discovery.port
    return typeof port === 'number' && port > 0 && port < 65536 ? port : undefined
  }
}

/** One word of synthesized speech: when it sounds, and where it ends in the text. */
export interface TimedWord {
  /** Seconds from the start of the audio. */
  start: number
  /** UTF-16 offset in the synthesized text just past the word. */
  characterEnd: number
}

export interface SynthesizedSpeech {
  pcm: Uint8Array
  sampleRate: number
  /** Absent when Voice Operator could not time the words, or is too old to. */
  words?: TimedWord[]
}

/**
 * A timed `/v1/synthesize` answer: the WAV as base64 `audio`, and `words` with
 * `start` seconds and `character_end`. Malformed words are dropped as a set —
 * a partial list would misplace every word after the gap.
 */
export function parseTimedSynthesis(body: unknown): SynthesizedSpeech | undefined {
  if (!body || typeof body !== 'object') return undefined
  const { audio, words } = body as { audio?: unknown; words?: unknown }
  if (typeof audio !== 'string') return undefined
  const wav = parseWav(new Uint8Array(Buffer.from(audio, 'base64')))
  if (!wav) return undefined
  if (!Array.isArray(words)) return wav
  const timed = words.map((word: { start?: unknown; character_end?: unknown }) =>
    typeof word?.start === 'number' && typeof word.character_end === 'number'
      ? { start: word.start, characterEnd: word.character_end }
      : undefined)
  return timed.every((word) => word !== undefined) ? { ...wav, words: timed as TimedWord[] } : wav
}

/**
 * The samples and rate of a PCM WAV — 16-bit mono, which is what Voice
 * Operator's synthesizer returns. Walks the chunks rather than assuming a
 * 44-byte header.
 */
export function parseWav(bytes: Uint8Array): { pcm: Uint8Array; sampleRate: number } | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const tag = (at: number) => String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3])
  if (bytes.length < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return undefined
  let sampleRate = 0
  for (let at = 12; at + 8 <= bytes.length;) {
    const size = view.getUint32(at + 4, true)
    if (tag(at) === 'fmt ') {
      if (view.getUint16(at + 8 + 2, true) !== 1 || view.getUint16(at + 8 + 14, true) !== 16) return undefined
      sampleRate = view.getUint32(at + 8 + 4, true)
    } else if (tag(at) === 'data') {
      if (!sampleRate) return undefined
      const end = Math.min(bytes.length, at + 8 + size)
      return { pcm: bytes.slice(at + 8, end - ((end - at - 8) % 2)), sampleRate }
    }
    at += 8 + size + (size % 2)
  }
  return undefined
}
