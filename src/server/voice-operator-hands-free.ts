import * as net from 'net'
import { cleanHandsFreeText } from '../shared/hands-free-words'

/**
 * Hands-free mode, as Voice Operator now provides it: Spaceterm is a client
 * that registers its trigger word, "control", and turns hands-free on and off.
 * Everything that listens and decides — the speech detector, the trigger-word
 * check, the conversation window, Smart Turn, the transcription — runs in
 * Voice Operator (its DESIGN.md, "Hands-free"). This is the server's half of
 * being its client:
 *
 * - The **control connection**: held open to Voice Operator's hands-free
 *   socket while it runs, saying `hello` with the trigger word. Registration
 *   lasts exactly as long as the connection, so Voice Operator listens for
 *   "control" only while this server is up. Hands-free on the Mac's
 *   microphone (the desktop toolbar's button) is `start`/`stop` on it, and
 *   what Voice Operator says back is handed to `onEvent`, once. The
 *   connection is held only while a desktop or phone client is connected.
 * - **Stream relays**: a phone's hands-free runs in Voice Operator's iOS SDK,
 *   which carries the phone's audio as lines of Voice Operator's protocol. The
 *   phone reaches the Mac only through this server, so each phone stream is a
 *   connection to the same socket, its lines passed through.
 *
 * Either way the server reads what Voice Operator says before any client
 * does, and acts on it itself, once (`handsFreeAction`): the words go to
 * Control, and a cut-in stops Control. Clients only show it and play its
 * sounds, so no number of open windows can say anything twice.
 *
 * Only the operator's own Spaceterm registers (`claim`): a test run claiming
 * "control" would take it from them.
 */

export const TRIGGER_WORD = 'control'
export const CLIENT_NAME = 'spaceterm'
export const HANDS_FREE_PROTOCOL = 1

/** One line-oriented connection; `net.Socket` in production, a fake in tests. */
export interface LineConnection {
  write(line: string): void
  close(): void
}

export interface VoiceOperatorHandsFreeDeps {
  /** Voice Operator's discovery document, or undefined when it is not running. */
  readDiscovery(): { pid?: unknown; hands_free_socket?: unknown } | undefined
  /** Connect to a Unix socket: `onLine` for each line it sends, `onClose` once, when it goes. */
  connect(path: string, onLine: (line: string) => void, onClose: () => void): LineConnection
  log(message: string): void
}

export const REAL_CONNECT: VoiceOperatorHandsFreeDeps['connect'] = (path, onLine, onClose) => {
  const socket = net.createConnection(path)
  let buffer = ''
  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    onClose()
  }
  socket.setEncoding('utf8')
  socket.on('data', (chunk: string) => {
    buffer += chunk
    let newline: number
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (line) onLine(line)
    }
  })
  socket.on('error', close)
  socket.on('close', close)
  return {
    write: (line) => { if (!closed) socket.write(`${line}\n`) },
    close: () => { socket.destroy(); close() },
  }
}

/** A message from Voice Operator, as it sent it. */
export type VoiceOperatorEvent = Record<string, unknown> & { type?: string }

export class VoiceOperatorHandsFree {
  private control: LineConnection | undefined
  /** The Voice Operator process the control connection is to. */
  private connectedTo: number | undefined
  private welcomed = false
  /** Whether a desktop or phone client is connected: registered only while one is. */
  private clientsPresent = false
  /** Whether the desktop asked for hands-free on the Mac's microphone. */
  private macWanted = false
  private reportedRefusal: string | undefined

  constructor(
    private readonly deps: VoiceOperatorHandsFreeDeps,
    /** What Voice Operator says about the Mac session, once, as it said it. */
    private readonly onEvent: (event: VoiceOperatorEvent) => void,
    /** Whether this server may claim the trigger word (`isOperatorHome()`). */
    private readonly claim: boolean,
  ) {}

  /**
   * Connect if a client is here, Voice Operator is up and this server is not
   * connected to it. Called on a timer.
   */
  check(): void {
    if (!this.claim || !this.clientsPresent) return
    const discovery = this.deps.readDiscovery()
    const pid = discovery?.pid
    const path = discovery?.hands_free_socket
    if (typeof pid !== 'number' || typeof path !== 'string') return
    if (this.control && this.connectedTo === pid) return
    this.control?.close()
    this.connectedTo = pid
    this.welcomed = false
    const connection = this.deps.connect(path, (line) => this.fromControl(line), () => {
      if (this.control !== connection) return
      this.control = undefined
      this.welcomed = false
      this.deps.log('[hands-free] Voice Operator connection closed')
      if (this.macWanted) this.onEvent({ type: 'session-ended', why: 'disconnected' })
    })
    this.control = connection
    connection.write(JSON.stringify({ type: 'hello', protocol: HANDS_FREE_PROTOCOL, client: CLIENT_NAME, trigger: TRIGGER_WORD }))
  }

  /**
   * Whether any client that could use hands-free is connected. With none,
   * "control" is let go, so Voice Operator does not hear for nobody; it is
   * registered again when one comes back, and the Mac's hands-free with it
   * if it was on.
   */
  setClientsPresent(present: boolean): void {
    if (present === this.clientsPresent) return
    this.clientsPresent = present
    if (present) {
      this.check()
      return
    }
    const connection = this.control
    this.control = undefined
    this.connectedTo = undefined
    this.welcomed = false
    if (!connection) return
    this.deps.log(`[hands-free] no client connected: let "${TRIGGER_WORD}" go`)
    connection.close()
  }

  /** Whether hands-free is available: Voice Operator is connected and took the trigger word. */
  get ready(): boolean { return this.welcomed }

  /** Hands-free on the Mac's microphone, on or off. */
  setMac(on: boolean): void {
    this.macWanted = on
    if (!this.welcomed) {
      // Not registered yet — this server just started, or Voice Operator is restarting: it is
      // started as soon as it is (`fromControl`). Only a home that will never register says no.
      if (on && !this.claim) this.onEvent({ type: 'session-ended', why: 'not-operator-home' })
      return
    }
    this.control?.write(JSON.stringify(on ? { type: 'start', source: 'mac' } : { type: 'stop' }))
  }

  /**
   * A phone's stream: a connection of its own to the same socket, its lines
   * passed through both ways. Undefined when Voice Operator is not running.
   */
  openStream(onLine: (line: string) => void, onClose: () => void): LineConnection | undefined {
    const path = this.deps.readDiscovery()?.hands_free_socket
    if (typeof path !== 'string') return undefined
    return this.deps.connect(path, onLine, onClose)
  }

  private fromControl(line: string): void {
    let message: VoiceOperatorEvent
    try { message = JSON.parse(line) as VoiceOperatorEvent } catch { return }
    if (message.type === 'welcome') {
      this.welcomed = true
      this.reportedRefusal = undefined
      this.deps.log(`[hands-free] registered "${TRIGGER_WORD}" with Voice Operator (pid ${this.connectedTo})`)
      if (this.macWanted) this.control?.write(JSON.stringify({ type: 'start', source: 'mac' }))
      return
    }
    if (message.type === 'refused') {
      const why = `${String(message.error)}: ${String(message.detail ?? '')}`
      if (why !== this.reportedRefusal) this.deps.log(`[hands-free] Voice Operator refused the registration (${why})`)
      this.reportedRefusal = why
      return
    }
    // Voice Operator quitting to restart is not the user turning it off: started again when it is back.
    if (message.type === 'session-ended' && message.why !== 'restarting') this.macWanted = false
    this.onEvent(message)
  }
}

/** What the server does with one of Voice Operator's messages, for Control. */
export type HandsFreeAction =
  /** The words said, the wake word off; empty when nothing was caught for Control. */
  | { kind: 'words'; text: string; interrupted: boolean }
  /** The user began talking over Control `msAgo` ago, and it was for Control. */
  | { kind: 'cut-in'; msAgo: number }

/** What Control is owed for `event`, if anything: its words, or being cut off. */
export function handsFreeAction(event: VoiceOperatorEvent): HandsFreeAction | undefined {
  if (event.type === 'transcript') {
    const trigger = typeof event.trigger === 'string' ? event.trigger : TRIGGER_WORD
    return { kind: 'words', text: cleanHandsFreeText(String(event.text ?? ''), trigger), interrupted: event.interrupted === true }
  }
  if (event.type === 'cut-in') return { kind: 'cut-in', msAgo: typeof event.msAgo === 'number' ? Math.round(event.msAgo) : 0 }
  return undefined
}

/**
 * Whether the user is talking to Control hands-free, from Voice Operator's
 * `state` and `transcript` messages, per session: from the first syllable
 * (`hearing`) until the words are handed over — which the server does before
 * this sees the `transcript` — or turn out to be none. Control holds its
 * voice meanwhile (dictation-presence.ts).
 */
export class HandsFreePresence {
  private readonly talking = new Set<string>()

  constructor(private readonly onChange: (speaking: boolean) => void) {}

  get speaking(): boolean { return this.talking.size > 0 }

  /** One message from Voice Operator about session `key`. */
  see(key: string, event: VoiceOperatorEvent): void {
    if (event.type === 'transcript' || event.type === 'session-ended') this.set(key, false)
    else if (event.type === 'state') this.set(key, event.phase === 'hearing' || event.phase === 'sending')
  }

  private set(key: string, on: boolean): void {
    const before = this.speaking
    if (on) this.talking.add(key)
    else this.talking.delete(key)
    if (this.speaking !== before) this.onChange(this.speaking)
  }
}
