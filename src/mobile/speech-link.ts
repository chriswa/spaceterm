import type { SpeechLinkApi } from '../shared/api'
import { recordMobileEvent } from './mobile-events'

/**
 * This phone as a speaker of Voice Operator's: Control's replies, while this
 * phone holds Control, are Voice Operator jobs addressed to it (`client` and
 * `device` on `/v1/speech`), and Voice Operator keeps each job — its status,
 * how far the listener got, a stop dated back to when they began talking
 * (its DESIGN.md, "Speech on a device"). This page says hello as the device
 * on a speaker connection the server relays unread, hands each sentence to
 * the player (speech-player.ts) and reports back when each starts and
 * finishes.
 *
 * The page speaks the protocol itself rather than through the app's Voice
 * Operator SDK, because it chooses per job whether the app or the page plays
 * it, and because it also runs in a browser. The connection is opened again
 * whenever the server connection comes back, and shortly after Voice
 * Operator closes it (it is restarting). A dropped connection ends whatever
 * was playing, at what had been heard: Voice Operator says so in `ended`.
 */

export const CLIENT_NAME = 'spaceterm'
export const SPEECH_LINK_PROTOCOL = 1
/** How long after Voice Operator closes the connection to open it again. */
const RETRY_MS = 2000

/** What a player reports of a sentence: it began, ended, or could not be played. */
export type SpeechProgressEvent = 'started' | 'finished' | 'failed'

/** One sentence to play after any before it: signed 16-bit mono PCM, base64. */
export interface SpeechSentence {
  id: string
  index: number
  /** Sentences in the whole job; the last is `count - 1`. */
  count: number
  sampleRate: number
  pcm: string
  /** When Voice Operator sent it, epoch ms on the Mac's clock: how late it arrived, for the record. */
  sentAt?: number
}

/** What the player follows: sentences in, stops, and its account of each sentence back. */
export interface SpeechFeed {
  onAudio(callback: (sentence: SpeechSentence) => void): () => void
  onStop(callback: (id: string) => void): () => void
  progress(id: string, index: number, event: SpeechProgressEvent): void
}

export function speechLink(
  api: SpeechLinkApi,
  device: () => string,
  connection: { isConnected(): boolean; onConnect(fn: () => void): () => void },
  log: (message: string) => void,
): SpeechFeed & { dispose(): void } {
  const audio = new Set<(sentence: SpeechSentence) => void>()
  const stops = new Set<(id: string) => void>()
  let open = false
  let retry: ReturnType<typeof setTimeout> | undefined
  const send = (message: Record<string, unknown>) => { if (open) api.line(JSON.stringify(message)) }

  const openLink = () => {
    clearTimeout(retry)
    open = true
    api.open()
    send({ type: 'hello', protocol: SPEECH_LINK_PROTOCOL, client: CLIENT_NAME, role: 'speaker', device: device() })
  }

  const offLink = api.onLink((message) => {
    if (message.kind === 'closed') {
      if (!open) return
      open = false
      // Voice Operator went away (or is restarting): try again shortly.
      clearTimeout(retry)
      retry = setTimeout(() => { if (connection.isConnected()) openLink() }, RETRY_MS)
      return
    }
    let parsed: Record<string, unknown>
    try { parsed = JSON.parse(message.line) as Record<string, unknown> } catch { return }
    fromVoiceOperator(parsed)
  })

  function fromVoiceOperator(message: Record<string, unknown>): void {
    switch (message.type) {
      case 'sentence': {
        const { id, index, count, sampleRate, pcm, sentAt } = message
        if (typeof id !== 'string' || typeof index !== 'number' || typeof count !== 'number'
          || typeof sampleRate !== 'number' || typeof pcm !== 'string') return
        const sentence: SpeechSentence = { id, index, count, sampleRate, pcm, ...(typeof sentAt === 'number' ? { sentAt } : {}) }
        for (const fn of audio) fn(sentence)
        return
      }
      case 'ended':
        // Cut off, superseded or failed: what is left of it stops. A completed job has played out already.
        if (typeof message.id === 'string' && message.state !== 'completed') for (const fn of stops) fn(message.id)
        return
      case 'refused':
      case 'error':
        log(`[speech] Voice Operator: ${String(message.type)} ${String(message.error)} ${String(message.detail ?? '')}`)
        return
      case 'replaced':
        recordMobileEvent('speech-link-replaced', {})
        return
    }
  }

  // The server came back: a fresh connection, and a fresh hello on it.
  const offConnect = connection.onConnect(openLink)
  if (connection.isConnected()) openLink()

  return {
    onAudio(fn) {
      audio.add(fn)
      return () => { audio.delete(fn) }
    },
    onStop(fn) {
      stops.add(fn)
      return () => { stops.delete(fn) }
    },
    progress(id, index, event) {
      send({ type: 'progress', id, index, event })
    },
    dispose() {
      clearTimeout(retry)
      offLink()
      offConnect()
      if (open) {
        open = false
        api.close()
      }
    },
  }
}
