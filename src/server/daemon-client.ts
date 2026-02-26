import * as net from 'net'
import { resolve } from 'path'
import { existsSync } from 'fs'
import { execFileSync } from 'child_process'
import { DAEMON_SOCKET_PATH } from '../shared/protocol'

const DAEMON_BIN = resolve(__dirname, '..', '..', 'pty-daemon', 'pty-daemon')

export interface DaemonMessage {
  type: string
  id?: string
  [key: string]: unknown
}

type MessageHandler = (msg: DaemonMessage) => void

/**
 * Client for the persistent PTY daemon.
 * Manages connection, auto-start, reconnection, and JSON-lines protocol.
 */
export class DaemonClient {
  private socket: net.Socket | null = null
  private buffer = ''
  private onMessage: MessageHandler
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private connected = false
  private onReconnect: (() => void) | null = null

  constructor(onMessage: MessageHandler) {
    this.onMessage = onMessage
  }

  /** Set a callback that fires after a successful reconnection. */
  setOnReconnect(fn: () => void): void {
    this.onReconnect = fn
  }

  /** Ensure daemon is running, then connect. */
  async connect(): Promise<void> {
    await this.ensureDaemonRunning()
    return this.doConnect()
  }

  private async ensureDaemonRunning(): Promise<void> {
    const alive = await this.probe()
    if (alive) return

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
  }

  private probe(): Promise<boolean> {
    return new Promise((resolve) => {
      const probeSocket = net.createConnection(DAEMON_SOCKET_PATH)
      const timer = setTimeout(() => {
        probeSocket.destroy()
        resolve(false)
      }, 1000)
      probeSocket.on('connect', () => {
        clearTimeout(timer)
        probeSocket.destroy()
        resolve(true)
      })
      probeSocket.on('error', () => {
        clearTimeout(timer)
        resolve(false)
      })
    })
  }

  private doConnect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket = net.createConnection(DAEMON_SOCKET_PATH)
      this.socket.setEncoding('utf8')

      this.socket.on('connect', () => {
        this.connected = true
        resolve()
      })

      this.socket.on('data', (chunk: string) => {
        this.buffer += chunk
        const lines = this.buffer.split('\n')
        this.buffer = lines.pop()!
        for (const line of lines) {
          if (!line) continue
          try {
            this.onMessage(JSON.parse(line) as DaemonMessage)
          } catch { /* malformed JSON — skip */ }
        }
      })

      this.socket.on('close', () => {
        this.connected = false
        this.scheduleReconnect()
      })

      this.socket.on('error', (err) => {
        if (!this.connected) {
          reject(err)
        }
        // If already connected, the 'close' event handles reconnection.
      })
    })
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null
      try {
        await this.connect()
        this.onReconnect?.()
      } catch {
        this.scheduleReconnect()
      }
    }, 1000)
  }

  /** Send a JSON-lines message to the daemon. */
  send(msg: Record<string, unknown>): void {
    if (!this.socket || !this.connected) return
    this.socket.write(JSON.stringify(msg) + '\n')
  }

  isConnected(): boolean {
    return this.connected
  }

  dispose(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.socket) {
      this.socket.destroy()
      this.socket = null
    }
    this.connected = false
  }
}
