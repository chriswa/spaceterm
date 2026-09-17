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

/** The speech job in a reply, if the reply carries one at all. */
export function speechStatus(response: SpeechResponse): SpeechStatus | undefined {
  const body = response?.body as SpeechStatus | undefined
  return typeof body?.id === 'string' && typeof body.state === 'string' ? body : undefined
}

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

  /** Queue text to be spoken. */
  speak(text: string, voice?: string, init?: RequestInit): Promise<SpeechResponse> {
    return this.request('/v1/speech', {
      ...init, method: 'POST', body: JSON.stringify({ text, ...(voice ? { voice } : {}) }),
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
