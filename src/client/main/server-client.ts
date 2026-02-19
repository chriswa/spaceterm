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
      socket.setEncoding('utf8')
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
        this.parser!.feed(data as string)
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

    if (msg.type === 'claude-state') {
      this.emit('claude-state', msg.sessionId, msg.state)
      return
    }

    if (msg.type === 'claude-context') {
      this.emit('claude-context', msg.sessionId, msg.contextRemainingPercent)
      return
    }

    if (msg.type === 'claude-session-line-count') {
      this.emit('claude-session-line-count', msg.sessionId, msg.lineCount)
      return
    }

    // Node state events (broadcast, no seq)
    if (msg.type === 'node-updated') {
      this.emit('node-updated', msg.nodeId, msg.fields)
      return
    }

    if (msg.type === 'node-added') {
      this.emit('node-added', msg.node)
      return
    }

    if (msg.type === 'node-removed') {
      this.emit('node-removed', msg.nodeId)
      return
    }

    if (msg.type === 'file-content') {
      this.emit('file-content', msg.nodeId, msg.content)
      return
    }

    if (msg.type === 'snapshot') {
      this.emit('snapshot', msg.sessionId, msg)
      return
    }

    if (msg.type === 'plan-cache-update') {
      this.emit('plan-cache-update', msg.sessionId, msg.count, msg.files)
      return
    }

    if (msg.type === 'server-error') {
      this.emit('server-error', msg.message)
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

  async attach(sessionId: string): Promise<{ scrollback: string; shellTitleHistory?: string[]; cwd?: string; claudeSessionHistory?: Array<{ claudeSessionId: string; reason: string; timestamp: string }>; claudeState?: string; claudeContextPercent?: number; claudeSessionLineCount?: number }> {
    const resp = await this.sendRequest({ type: 'attach', sessionId })
    if (resp.type === 'attached') return { scrollback: resp.scrollback, shellTitleHistory: resp.shellTitleHistory, cwd: resp.cwd, claudeSessionHistory: resp.claudeSessionHistory, claudeState: resp.claudeState, claudeContextPercent: resp.claudeContextPercent, claudeSessionLineCount: resp.claudeSessionLineCount }
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

  // --- Node state mutations ---

  async nodeSyncRequest(): Promise<ServerMessage> {
    return this.sendRequest({ type: 'node-sync-request' })
  }

  async nodeMove(nodeId: string, x: number, y: number): Promise<ServerMessage> {
    return this.sendRequest({ type: 'node-move', nodeId, x, y })
  }

  async nodeBatchMove(moves: Array<{ nodeId: string; x: number; y: number }>): Promise<ServerMessage> {
    return this.sendRequest({ type: 'node-batch-move', moves })
  }

  async nodeRename(nodeId: string, name: string): Promise<ServerMessage> {
    return this.sendRequest({ type: 'node-rename', nodeId, name })
  }

  async nodeSetColor(nodeId: string, colorPresetId: string): Promise<ServerMessage> {
    return this.sendRequest({ type: 'node-set-color', nodeId, colorPresetId })
  }

  async nodeArchive(nodeId: string): Promise<ServerMessage> {
    return this.sendRequest({ type: 'node-archive', nodeId })
  }

  async nodeUnarchive(parentNodeId: string, archivedNodeId: string): Promise<ServerMessage> {
    return this.sendRequest({ type: 'node-unarchive', parentNodeId, archivedNodeId })
  }

  async nodeArchiveDelete(parentNodeId: string, archivedNodeId: string): Promise<ServerMessage> {
    return this.sendRequest({ type: 'node-archive-delete', parentNodeId, archivedNodeId })
  }

  async nodeBringToFront(nodeId: string): Promise<ServerMessage> {
    return this.sendRequest({ type: 'node-bring-to-front', nodeId })
  }

  async nodeReparent(nodeId: string, newParentId: string): Promise<ServerMessage> {
    return this.sendRequest({ type: 'node-reparent', nodeId, newParentId })
  }

  async terminalCreate(parentId: string, options?: CreateOptions, initialTitleHistory?: string[], initialName?: string, x?: number, y?: number, initialInput?: string): Promise<ServerMessage> {
    return this.sendRequest({ type: 'terminal-create', parentId, options, initialTitleHistory, initialName, x, y, initialInput })
  }

  async terminalResize(nodeId: string, cols: number, rows: number): Promise<ServerMessage> {
    return this.sendRequest({ type: 'terminal-resize', nodeId, cols, rows })
  }

  async terminalReincarnate(nodeId: string, options?: CreateOptions): Promise<ServerMessage> {
    return this.sendRequest({ type: 'terminal-reincarnate', nodeId, options })
  }

  async directoryAdd(parentId: string, cwd: string): Promise<ServerMessage> {
    return this.sendRequest({ type: 'directory-add', parentId, cwd })
  }

  async directoryCwd(nodeId: string, cwd: string): Promise<ServerMessage> {
    return this.sendRequest({ type: 'directory-cwd', nodeId, cwd })
  }

  async directoryGitFetch(nodeId: string): Promise<ServerMessage> {
    return this.sendRequest({ type: 'directory-git-fetch', nodeId })
  }

  async validateDirectory(path: string): Promise<ServerMessage> {
    return this.sendRequest({ type: 'validate-directory', path })
  }

  async fileAdd(parentId: string, filePath: string): Promise<ServerMessage> {
    return this.sendRequest({ type: 'file-add', parentId, filePath })
  }

  async filePath(nodeId: string, filePath: string): Promise<ServerMessage> {
    return this.sendRequest({ type: 'file-path', nodeId, filePath })
  }

  async validateFile(path: string, cwd?: string): Promise<ServerMessage> {
    return this.sendRequest({ type: 'validate-file', path, cwd })
  }

  async markdownAdd(parentId: string, x?: number, y?: number): Promise<ServerMessage> {
    return this.sendRequest({ type: 'markdown-add', parentId, x, y })
  }

  async markdownResize(nodeId: string, width: number, height: number): Promise<ServerMessage> {
    return this.sendRequest({ type: 'markdown-resize', nodeId, width, height })
  }

  async markdownContent(nodeId: string, content: string): Promise<ServerMessage> {
    return this.sendRequest({ type: 'markdown-content', nodeId, content })
  }

  async markdownSetMaxWidth(nodeId: string, maxWidth: number): Promise<ServerMessage> {
    return this.sendRequest({ type: 'markdown-set-max-width', nodeId, maxWidth })
  }

  async titleAdd(parentId: string): Promise<ServerMessage> {
    return this.sendRequest({ type: 'title-add', parentId })
  }

  async titleText(nodeId: string, text: string): Promise<ServerMessage> {
    return this.sendRequest({ type: 'title-text', nodeId, text })
  }

  async forkSession(nodeId: string): Promise<ServerMessage> {
    return this.sendRequest({ type: 'fork-session', nodeId })
  }

  setTerminalMode(sessionId: string, mode: 'live' | 'snapshot'): void {
    this.sendFireAndForget({ type: 'set-terminal-mode', sessionId, mode })
  }

  setClaudeStatusUnread(sessionId: string, unread: boolean): void {
    this.sendFireAndForget({ type: 'set-claude-status-unread', sessionId, unread } as ClientMessage)
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
