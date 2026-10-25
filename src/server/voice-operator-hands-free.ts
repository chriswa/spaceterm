import * as net from 'net'

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
 *   what Voice Operator says back is handed to `onEvent` for the desktop
 *   clients.
 * - **Stream relays**: a phone's hands-free runs in Voice Operator's iOS SDK,
 *   which carries the phone's audio as lines of Voice Operator's protocol. The
 *   phone reaches the Mac only through this server, so each phone stream is a
 *   connection to the same socket, its lines passed through unread — except
 *   `state`, peeked at for whether the user is talking to Control.
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
  /** Whether the desktop asked for hands-free on the Mac's microphone. */
  private macWanted = false
  private reportedRefusal: string | undefined

  constructor(
    private readonly deps: VoiceOperatorHandsFreeDeps,
    /** What Voice Operator says about the Mac session, for the desktop clients. */
    private readonly onEvent: (event: VoiceOperatorEvent) => void,
    /** Whether this server may claim the trigger word (`isOperatorHome()`). */
    private readonly claim: boolean,
  ) {}

  /** Connect if Voice Operator is up and this server is not connected to it. Called on a timer. */
  check(): void {
    if (!this.claim) return
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

  /** Whether hands-free is available: Voice Operator is connected and took the trigger word. */
  get ready(): boolean { return this.welcomed }

  /** Hands-free on the Mac's microphone, on or off. */
  setMac(on: boolean): void {
    this.macWanted = on
    if (!this.welcomed) {
      if (on) this.onEvent({ type: 'session-ended', why: this.claim ? 'unavailable' : 'not-operator-home' })
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
    if (message.type === 'session-ended') this.macWanted = false
    this.onEvent(message)
  }
}

/**
 * Whether the user is talking to Control hands-free, from Voice Operator's
 * `state` and `transcript` messages, per session: from the first syllable
 * (`hearing`) until the words are delivered — the client hands them to Control
 * (`delivered`) — or turn out to be none. Control holds its voice meanwhile
 * (dictation-presence.ts).
 */
export class HandsFreePresence {
  private readonly talking = new Set<string>()
  /** Sessions whose words are on their way to Control, and when to stop waiting. */
  private readonly awaiting = new Map<string, () => void>()

  constructor(
    private readonly onChange: (speaking: boolean) => void,
    private readonly schedule: (ms: number, fn: () => void) => () => void = (ms, fn) => {
      const timer = setTimeout(fn, ms)
      return () => clearTimeout(timer)
    },
    /** How long words on their way to Control hold it, at most. */
    private readonly wordsLimitMs = 10_000,
  ) {}

  get speaking(): boolean { return this.talking.size > 0 }

  /** One message from Voice Operator about session `key`. */
  see(key: string, event: VoiceOperatorEvent): void {
    if (event.type === 'transcript') {
      if (typeof event.text === 'string' && event.text.trim()) {
        this.awaiting.get(key)?.()
        this.awaiting.set(key, this.schedule(this.wordsLimitMs, () => this.release(key)))
      }
      return
    }
    if (event.type === 'session-ended') {
      this.release(key)
      return
    }
    if (event.type !== 'state') return
    if (event.phase === 'hearing' || event.phase === 'sending') this.set(key, true)
    else if (!this.awaiting.has(key)) this.set(key, false)
  }

  /** The client handed Control what it made of its dictation: nothing waits on it now. */
  delivered(): void {
    for (const key of [...this.awaiting.keys()]) this.release(key)
  }

  private release(key: string): void {
    this.awaiting.get(key)?.()
    this.awaiting.delete(key)
    this.set(key, false)
  }

  private set(key: string, on: boolean): void {
    const before = this.speaking
    if (on) this.talking.add(key)
    else this.talking.delete(key)
    if (this.speaking !== before) this.onChange(this.speaking)
  }
}
