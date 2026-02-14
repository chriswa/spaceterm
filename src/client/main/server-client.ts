import * as net from 'net'
import { EventEmitter } from 'events'
import { SOCKET_PATH } from '../../shared/protocol'
import type {
  ClientMessage,
  CreateOptions,
  ServerMessage,
  SessionInfo
} from '../../shared/protocol'
import { LineParser } from '../../server/line-parser'

const RECONNECT_DELAY = 2000

interface PendingRequest {
  resolve: (msg: ServerMessage) => void
  reject: (err: Error) => void
}

export class ServerClient extends EventEmitter {
  private socket: net.Socket | null = null
  private parser: LineParser | null = null
  private seq = 0
  private pending = new Map<number, PendingRequest>()
  private connected = false
  private shouldReconnect = true
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.connected) {
        resolve()
        return
      }

      const socket = net.createConnection(SOCKET_PATH)
      this.socket = socket

      this.parser = new LineParser((msg) => {
        this.handleMessage(msg as ServerMessage)
      })

      socket.on('connect', () => {
        this.connected = true
        this.emit('connect')
        resolve()
      })

      socket.on('data', (data) => {
        this.parser!.feed(data.toString())
      })

      socket.on('close', () => {
        const wasConnected = this.connected
        this.connected = false
        this.rejectAllPending()

        if (wasConnected) {
          this.emit('disconnect')
        }

        if (this.shouldReconnect) {
          this.scheduleReconnect()
        }
      })

      socket.on('error', (err) => {
        if (!this.connected) {
          reject(err)
        }
      })
    })
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect().catch(() => {
        // Will retry via close handler
      })
    }, RECONNECT_DELAY)
  }

  private rejectAllPending(): void {
    this.pending.forEach((req) => {
      req.reject(new Error('Disconnected from server'))
    })
    this.pending.clear()
  }

  private handleMessage(msg: ServerMessage): void {
    // Events (no seq) — broadcast to listeners
    if (msg.type === 'data') {
      this.emit('data', msg.sessionId, msg.data)
      return
    }

    if (msg.type === 'exit') {
      this.emit('exit', msg.sessionId, msg.exitCode)
      return
    }

    if (msg.type === 'shell-title-history') {
      this.emit('shell-title-history', msg.sessionId, msg.history)
      return
    }

    if (msg.type === 'cwd') {
      this.emit('cwd', msg.sessionId, msg.cwd)
      return
    }

    if (msg.type === 'claude-session-history') {
      this.emit('claude-session-history', msg.sessionId, msg.history)
      return
    }

    // Request/response correlation
    if ('seq' in msg) {
      const pending = this.pending.get(msg.seq)
      if (pending) {
        this.pending.delete(msg.seq)
        pending.resolve(msg)
      }
    }
  }

  private sendRequest(msg: Record<string, unknown>): Promise<ServerMessage> {
    return new Promise((resolve, reject) => {
      if (!this.connected || !this.socket) {
        reject(new Error('Not connected to server'))
        return
      }

      const seqNum = ++this.seq
      const fullMsg = { ...msg, seq: seqNum }
      this.pending.set(seqNum, { resolve, reject })
      this.socket.write(JSON.stringify(fullMsg) + '\n')
    })
  }

  private sendFireAndForget(msg: ClientMessage): void {
    if (!this.connected || !this.socket) return
    this.socket.write(JSON.stringify(msg) + '\n')
  }

  async create(options?: CreateOptions): Promise<SessionInfo> {
    const resp = await this.sendRequest({ type: 'create', options })
    if (resp.type === 'created') return { sessionId: resp.sessionId, cols: resp.cols, rows: resp.rows }
    throw new Error('Unexpected response')
  }

  async list(): Promise<SessionInfo[]> {
    const resp = await this.sendRequest({ type: 'list' })
    if (resp.type === 'listed') return resp.sessions
    throw new Error('Unexpected response')
  }

  async attach(sessionId: string): Promise<{ scrollback: string; shellTitleHistory?: string[]; cwd?: string; claudeSessionHistory?: Array<{ claudeSessionId: string; reason: string; timestamp: string }> }> {
    const resp = await this.sendRequest({ type: 'attach', sessionId })
    if (resp.type === 'attached') return { scrollback: resp.scrollback, shellTitleHistory: resp.shellTitleHistory, cwd: resp.cwd, claudeSessionHistory: resp.claudeSessionHistory }
    throw new Error('Unexpected response')
  }

  async detach(sessionId: string): Promise<void> {
    await this.sendRequest({ type: 'detach', sessionId })
  }

  async destroy(sessionId: string): Promise<void> {
    await this.sendRequest({ type: 'destroy', sessionId })
  }

  write(sessionId: string, data: string): void {
    this.sendFireAndForget({ type: 'write', sessionId, data })
  }

  resize(sessionId: string, cols: number, rows: number): void {
    this.sendFireAndForget({ type: 'resize', sessionId, cols, rows })
  }

  isConnected(): boolean {
    return this.connected
  }

  disconnect(): void {
    this.shouldReconnect = false
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
