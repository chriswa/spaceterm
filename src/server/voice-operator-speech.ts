import type { ServerMessage } from '../shared/protocol'
import { CLIENT_NAME, type LineConnection } from './voice-operator-hands-free'
import type { SpeechBackend, SpeechContent, VoiceOperator } from './voice-operator'

/**
 * Speech on a phone, as Voice Operator now provides it (its DESIGN.md,
 * "Speech on a device"; it replaced `RemoteSpeech` here): the phone's page is
 * a speaker on Voice Operator's client socket, and Control's replies are
 * Voice Operator jobs addressed to it — `/v1/speech` with `client` and
 * `device` — which Control follows exactly as it follows speech on the Mac.
 *
 * This server carries each phone's speaker connection, passing its lines
 * through unread but for three things: whether Voice Operator has welcomed
 * the speaker (speech may go to it), and each sentence sent and each job
 * ended, for the phone's audio record. Which device speech goes to stays
 * here (index.ts, `updateReceptionistListener`).
 */

export interface SpeechLinksDeps {
  /** A connection to Voice Operator's client socket; undefined when it is not running. */
  connect(onLine: (line: string) => void, onClose: () => void): LineConnection | undefined
  /** Send to a connected client. */
  send(clientId: string, msg: ServerMessage): void
  /** For the phone's audio record (mobile-events.ts). */
  record?(clientId: string, kind: string, detail: Record<string, unknown>): void
  /** Bytes queued to the client and not yet sent on, where its link can say. */
  buffered?(clientId: string): number | undefined
  /** Wait `ms`: real timers unless a test supplies its own. */
  sleep?(ms: number): Promise<void>
}

/** How long a reply waits for a phone's speaker to be welcomed — just reconnected, or Voice Operator just back. */
export const SPEAKER_WAIT_MS = 3000

interface Link {
  connection: LineConnection
  ready: boolean
  waiters: Set<() => void>
}

export class SpeechLinks {
  private readonly links = new Map<string, Link>()

  constructor(private readonly deps: SpeechLinksDeps) {}

  /** The client opened its speaker connection, closing any it had. */
  open(clientId: string): void {
    this.close(clientId)
    let link: Link | undefined = undefined
    const connection = this.deps.connect(
      (line) => { if (link && this.links.get(clientId) === link) this.fromVoiceOperator(clientId, link, line) },
      () => {
        if (!link || this.links.get(clientId) !== link) return
        this.links.delete(clientId)
        this.deps.send(clientId, { type: 'speech-link', kind: 'closed' })
      },
    )
    if (!connection) {
      this.deps.send(clientId, { type: 'speech-link', kind: 'closed' })
      return
    }
    link = { connection, ready: false, waiters: new Set() }
    this.links.set(clientId, link)
  }

  line(clientId: string, line: string): void {
    this.links.get(clientId)?.connection.write(line)
  }

  /** The client closed it, or went: Voice Operator ends what it was playing, at what was heard. */
  close(clientId: string): void {
    const link = this.links.get(clientId)
    if (!link) return
    this.links.delete(clientId)
    link.connection.close()
  }

  /** Whether Voice Operator has welcomed this client's speaker: speech may go to it. */
  ready(clientId: string): boolean {
    return this.links.get(clientId)?.ready === true
  }

  /**
   * Control's voice on `device`, the phone `clientId` is, while its speaker is
   * up — waiting `SPEAKER_WAIT_MS` for one that is on its way — or `fallback`.
   * Every job is Voice Operator's, wherever it plays, so status and stops go
   * there.
   */
  backend(clientId: string, device: string, voiceOperator: VoiceOperator, fallback: SpeechBackend): SpeechBackend {
    return {
      speak: async (content, voice) => {
        if (!await this.whenReady(clientId)) return fallback.speak(content, voice)
        const response = await voiceOperator.speak(content, voice, undefined, { client: CLIENT_NAME, device })
        const id = (response?.body as { id?: unknown } | undefined)?.id
        this.deps.record?.(clientId, 'speech-job', {
          ...(typeof id === 'string' ? { id: id.slice(0, 11) } : { status: response?.status ?? 'unreachable' }),
          chars: characters(content),
        })
        return response
      },
      status: (id, opts, init, timeoutMs) => voiceOperator.status(id, opts, init, timeoutMs),
      drop: (id, heardUntil) => voiceOperator.drop(id, heardUntil),
    }
  }

  private async whenReady(clientId: string): Promise<boolean> {
    const link = this.links.get(clientId)
    if (link?.ready) return true
    if (!link) return false
    let wake: () => void = () => {}
    const welcomed = new Promise<void>((resolve) => { wake = resolve })
    link.waiters.add(wake)
    const sleep = this.deps.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
    await Promise.race([welcomed, sleep(SPEAKER_WAIT_MS)])
    link.waiters.delete(wake)
    return this.ready(clientId)
  }

  private fromVoiceOperator(clientId: string, link: Link, line: string): void {
    let message: Record<string, unknown> | undefined
    try { message = JSON.parse(line) as Record<string, unknown> } catch { /* not ours to judge */ }
    if (message?.type === 'welcome') {
      link.ready = true
      for (const wake of [...link.waiters]) wake()
    } else if (message?.type === 'replaced' || message?.type === 'refused') {
      link.ready = false
    } else if (message?.type === 'sentence' && typeof message.id === 'string') {
      // When each sentence left, and what was queued ahead of it: beside the phone's
      // `speech-audio-received`, it says where a late one waited.
      const buffered = this.deps.buffered?.(clientId)
      this.deps.record?.(clientId, 'speech-audio-sent', {
        id: message.id.slice(0, 11), index: message.index, count: message.count,
        kb: typeof message.pcm === 'string' ? Math.round(message.pcm.length / 1024) : undefined,
        synthMs: message.synthMs,
        ...(buffered !== undefined ? { bufferedKb: Math.round(buffered / 1024) } : {}),
      })
    } else if (message?.type === 'ended' && typeof message.id === 'string') {
      this.deps.record?.(clientId, 'speech-job-ended', { id: message.id.slice(0, 11), state: message.state, heardChars: message.characterOffset })
    }
    this.deps.send(clientId, { type: 'speech-link', kind: 'line', line })
  }
}

function characters(content: SpeechContent): number {
  return typeof content === 'string' ? content.length : content.reduce((n, part) => n + part.text.length, 0)
}
