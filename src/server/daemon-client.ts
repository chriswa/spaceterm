import * as net from 'net'
import { resolve } from 'path'
import { existsSync } from 'fs'
import { execFileSync } from 'child_process'
import { DAEMON_SOCKET_PATH } from '../shared/protocol'
import { LineParser } from './line-parser'

const DAEMON_BIN = resolve(__dirname, '..', '..', 'pty-daemon', 'pty-daemon')

export interface DaemonMessage {
  type: string
  id?: string
  [key: string]: unknown
}

type MessageHandler = (msg: DaemonMessage) => void

/**
 * The socket-shaped surface DaemonClient needs. `net.Socket` satisfies it, and
 * so can an in-memory fake — which is the point: the daemon speaks a stable
 * JSON-lines protocol over a unix socket, so faking the transport lets the whole
 * session lifecycle be driven in-process without the Go binary.
 */
export interface DaemonConnection {
  on(event: 'connect', listener: () => void): void
  on(event: 'data', listener: (chunk: string | Buffer) => void): void
  on(event: 'close', listener: () => void): void
  on(event: 'error', listener: (err: Error) => void): void
  write(data: string): void
  destroy(): void
}

export interface DaemonTransport {
  /** Start the daemon process if it is not already listening. */
  ensureRunning(): Promise<void>
  /** Open a connection. Must already have utf8 encoding applied if applicable. */
  connect(): DaemonConnection
}

function probeDaemon(): Promise<boolean> {
  return new Promise((resolveProbe) => {
    const probeSocket = net.createConnection(DAEMON_SOCKET_PATH)
    const timer = setTimeout(() => {
      probeSocket.destroy()
      resolveProbe(false)
    }, 1000)
    probeSocket.on('connect', () => {
      clearTimeout(timer)
      probeSocket.destroy()
      resolveProbe(true)
    })
    probeSocket.on('error', () => {
      clearTimeout(timer)
      resolveProbe(false)
    })
  })
}

/** Talks to the real pty-daemon over its unix socket, starting it if needed. */
export const REAL_DAEMON_TRANSPORT: DaemonTransport = {
  async ensureRunning(): Promise<void> {
    if (await probeDaemon()) return

    if (!existsSync(DAEMON_BIN)) {
      throw new Error(
        `PTY daemon binary not found at ${DAEMON_BIN}. ` +
        `Run: (cd pty-daemon && go build -o pty-daemon .)`
      )
    }

    try {
      execFileSync(DAEMON_BIN, ['start'], { timeout: 10_000 })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(`Failed to start pty-daemon: ${msg}`)
    }
  },

  connect(): DaemonConnection {
    const socket = net.createConnection(DAEMON_SOCKET_PATH)
    socket.setEncoding('utf8')
    return socket
  },
}

export interface DaemonClientOptions {
  /** Swappable for tests; defaults to the real unix-socket transport. */
  transport?: DaemonTransport
  /** Delay before a reconnection attempt. Lowered in tests to keep them fast. */
  reconnectDelayMs?: number
}

/**
 * Client for the persistent PTY daemon.
 * Manages connection, auto-start, reconnection, and JSON-lines framing.
 */
export class DaemonClient {
  private connection: DaemonConnection | null = null
  private onMessage: MessageHandler
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private connected = false
  private onReconnect: (() => void) | null = null
  private disposed = false
  private readonly transport: DaemonTransport
  private readonly reconnectDelayMs: number

  constructor(onMessage: MessageHandler, options: DaemonClientOptions = {}) {
    this.onMessage = onMessage
    this.transport = options.transport ?? REAL_DAEMON_TRANSPORT
    this.reconnectDelayMs = options.reconnectDelayMs ?? 1000
  }

  /** Set a callback that fires after a successful reconnection. */
  setOnReconnect(fn: () => void): void {
    this.onReconnect = fn
  }

  /** Ensure daemon is running, then connect. */
  async connect(): Promise<void> {
    await this.transport.ensureRunning()
    return this.doConnect()
  }

  private doConnect(): Promise<void> {
    return new Promise((resolvePromise, reject) => {
      const connection = this.transport.connect()
      this.connection = connection

      // Framing is LineParser's job — it already handles partial lines, Buffer
      // chunks and malformed JSON, and this class used to carry a second copy.
      const parser = new LineParser((msg) => this.onMessage(msg as DaemonMessage))

      connection.on('connect', () => {
        this.connected = true
        resolvePromise()
      })

      connection.on('data', (chunk) => parser.feed(chunk))

      connection.on('close', () => {
        this.connected = false
        this.scheduleReconnect()
      })

      connection.on('error', (err) => {
        if (!this.connected) {
          reject(err)
        }
        // If already connected, the 'close' event handles reconnection.
      })
    })
  }

  private scheduleReconnect(): void {
    // dispose() closes the socket, which fires 'close'; without this guard a
    // disposed client would resurrect itself on a timer.
    if (this.disposed || this.reconnectTimer) return
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null
      if (this.disposed) return
      try {
        await this.connect()
        this.onReconnect?.()
      } catch {
        this.scheduleReconnect()
      }
    }, this.reconnectDelayMs)
  }

  /** Send a JSON-lines message to the daemon. */
  send(msg: Record<string, unknown>): void {
    if (!this.connection || !this.connected) return
    this.connection.write(JSON.stringify(msg) + '\n')
  }

  isConnected(): boolean {
    return this.connected
  }

  dispose(): void {
    this.disposed = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.connection) {
      this.connection.destroy()
      this.connection = null
    }
    this.connected = false
  }
}
