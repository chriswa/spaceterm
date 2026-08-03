import * as net from 'net'
import { EventEmitter } from 'events'
import { SOCKET_PATH, CLIENT_PROTOCOL_VERSION } from '../../shared/protocol'
import type {
  ClientMessage,
  CreateOptions,
  ServerMessage,
  SessionInfo,
  CameraBounds
} from '../../shared/protocol'
import { LineParser } from '../../server/line-parser'
import { unhandledVariant } from '../../shared/exhaustive'
import type { NodeId, PtySessionId } from '../../shared/ids'
import { log } from './logger'

const INITIAL_RECONNECT_DELAY = 200
const MAX_RECONNECT_DELAY = 1000

interface PendingRequest {
  resolve: (msg: ServerMessage) => void
  reject: (err: Error) => void
}

export class ServerClient extends EventEmitter {
  private socket: net.Socket | null = null
  private seq = 0
  private pending = new Map<number, PendingRequest>()
  private connected = false
  private shouldReconnect = true
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectDelay = INITIAL_RECONNECT_DELAY
  private connectionWaiters: Array<{ resolve: () => void; reject: (err: Error) => void }> = []

  connect(): Promise<void> {
    if (this.connected) return Promise.resolve()
    this.shouldReconnect = true
    this.beginConnection()
    return new Promise((resolve, reject) => {
      this.connectionWaiters.push({ resolve, reject })
    })
  }

  private beginConnection(): void {
    // A failed Unix-socket connection fires both error and close. Keeping one
    // attempt in flight prevents those paired events from becoming a storm of
    // overlapping reconnects during server startup.
    if (this.connected || this.socket) return

    const socket = net.createConnection(SOCKET_PATH)
    socket.setEncoding('utf8')
    this.socket = socket
    const parser = new LineParser((msg) => this.handleMessage(msg as ServerMessage))

    socket.on('connect', () => {
      if (this.socket !== socket) return
      this.connected = true
      this.reconnectDelay = INITIAL_RECONNECT_DELAY
      const waiters = this.connectionWaiters.splice(0)
      waiters.forEach(({ resolve }) => resolve())
      this.emit('connect')
      // Announce our protocol version. Deliberately after resolving the
      // waiters: the handshake is diagnostic, and blocking startup on it would
      // turn a reporting mechanism into a new way to fail to start.
      void this.handshake()
    })

    socket.on('data', (data) => parser.feed(data))

    socket.on('close', () => {
      if (this.socket !== socket) return
      const wasConnected = this.connected
      this.socket = null
      this.connected = false
      this.rejectAllPending()

      if (wasConnected) this.emit('disconnect')
      if (this.shouldReconnect) this.scheduleReconnect()
    })

    // `close` owns retry scheduling. An early connection refusal is expected
    // while the server is settling, so deliberately do not log it here.
    socket.on('error', () => undefined)
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.beginConnection()
    }, this.reconnectDelay)
    this.reconnectDelay = Math.min(MAX_RECONNECT_DELAY, Math.ceil(this.reconnectDelay * 1.5))
  }

  private rejectAllPending(): void {
    this.pending.forEach((req) => {
      req.reject(new Error('Disconnected from server'))
    })
    this.pending.clear()
  }

  /**
   * Route one message from the server.
   *
   * A `switch` rather than an if-chain so the `default:` branch can assert the
   * union is fully covered: adding a `ServerMessage` variant without deciding
   * whether it is an event or a correlated reply is now a type error here.
   * Correlated replies are listed explicitly for the same reason — falling back
   * on `'seq' in msg` would let a new event silently take the response path and
   * be dropped.
   */
  private handleMessage(msg: ServerMessage): void {
    switch (msg.type) {
      // --- Events: unsolicited broadcasts, no seq ---
      // Relayed, not interpreted. `payload` is whatever the owning mod put
      // there; this process is a wire, not a participant.
      case 'mod':
        this.emit('mod', msg.modId, msg.event, msg.payload)
        return
      case 'data':
        this.emit('data', msg.sessionId, msg.data)
        return
      case 'exit':
        this.emit('exit', msg.sessionId, msg.exitCode)
        return
      case 'claude-context':
        this.emit('claude-context', msg.sessionId, msg.contextRemainingPercent)
        return
      case 'claude-session-line-count':
        this.emit('claude-session-line-count', msg.sessionId, msg.lineCount)
        return
      case 'node-updated':
        this.emit('node-updated', msg.nodeId, msg.fields)
        return
      case 'node-added':
        this.emit('node-added', msg.node)
        return
      case 'node-removed':
        this.emit('node-removed', msg.nodeId)
        return
      case 'file-content':
        this.emit('file-content', msg.nodeId, msg.content)
        return
      case 'snapshot':
        this.emit('snapshot', msg.sessionId, msg)
        return
      case 'plan-cache-update':
        this.emit('plan-cache-update', msg.sessionId, msg.count, msg.files)
        return
      case 'gh-rate-limit':
        this.emit('gh-rate-limit', msg.data, msg.usedHistory, msg.slotMinutes)
        return
      case 'play-sound':
        this.emit('play-sound', msg.sound)
        return
      case 'speak':
        this.emit('speak', msg.text)
        return
      case 'speaking-changed':
        this.emit('speaking-changed', msg.nodeId, msg.speaking, msg.voice)
        return
      case 'summary-chat-status':
        this.emit('summary-chat-status', msg.nodeId, msg.state, msg.message)
        return
      case 'peer-connected':
        this.emit('peer-connected', msg.clientId)
        return
      case 'peer-disconnected':
        this.emit('peer-disconnected', msg.clientId)
        return
      case 'peer-camera-bounds':
        this.emit('peer-camera-bounds', msg.clientId, msg.bounds)
        return
      case 'focus-surface':
        this.emit('focus-surface', msg.nodeId)
        return
      case 'saved-viewports':
        this.emit('saved-viewports', msg.viewports)
        return

      // --- Both: an error is broadcast, and also rejects its request if correlated ---
      case 'server-error':
        this.emit('server-error', msg.message)
        if (typeof msg.seq === 'number') {
          const pending = this.pending.get(msg.seq)
          if (pending) {
            this.pending.delete(msg.seq)
            pending.reject(new Error(msg.message))
          }
        }
        return

      // --- Replies: correlated to a request by seq ---
      case 'created':
      case 'server-restarted':
      case 'listed':
      case 'attached':
      case 'detached':
      case 'destroyed':
      case 'sync-state':
      case 'mutation-ack':
      case 'node-add-ack':
      case 'validate-directory-result':
      case 'validate-file-result':
      case 'client-hello-result':
        this.resolvePending(msg.seq, msg)
        return

      default:
        console.error(`[server-client] Unknown message type: ${unhandledVariant(msg)}`)
        return
    }
  }

  private resolvePending(seq: number, msg: ServerMessage): void {
    const pending = this.pending.get(seq)
    if (!pending) return
    this.pending.delete(seq)
    pending.resolve(msg)
  }

  /**
   * Tell the server which protocol version this build speaks, and report a
   * mismatch to `~/.spaceterm/electron.log`.
   *
   * Best-effort by design. The Electron client normally ships with its server,
   * so this is silent in the ordinary case — it exists for the cases where
   * that assumption fails: a stale server left running from a previous build,
   * or a socket in `~/.spaceterm/` owned by another checkout. Without it, the
   * symptom is a message that does not parse, several layers away from the
   * cause.
   */
  private async handshake(): Promise<void> {
    try {
      const reply = await this.sendRequest({
        type: 'client-hello',
        protocolVersion: CLIENT_PROTOCOL_VERSION,
        client: 'spaceterm-electron'
      })
      if (reply.type !== 'client-hello-result') return
      if (reply.compatible) {
        log(`[server-client] Protocol v${CLIENT_PROTOCOL_VERSION} accepted`)
      } else {
        log(
          `[server-client] PROTOCOL MISMATCH: ${reply.error ?? 'incompatible'}. ` +
          `This client speaks v${CLIENT_PROTOCOL_VERSION}; the server serves ` +
          `v${reply.minProtocolVersion}-v${reply.protocolVersion}. ` +
          'A stale server may be running — restart Spaceterm.'
        )
        this.emit('protocol-mismatch', reply.error ?? 'incompatible protocol version')
      }
    } catch {
      // A server old enough not to know `client-hello` replies with nothing and
      // the request rejects on disconnect. That is exactly the case this is for,
      // but there is nobody to tell — and taking the connection down over a
      // diagnostic would be worse than the mismatch it reports.
      log('[server-client] Server did not answer the protocol handshake (pre-v1 server?)')
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

  /**
   * Put one mod envelope on the wire.
   *
   * Fire-and-forget by design: a request/reply here would mean the base
   * correlating messages it cannot read. A mod that wants an answer defines
   * one in its own vocabulary.
   */
  sendMod(modId: string, event: string, payload: unknown): void {
    this.sendFireAndForget({ type: 'mod', modId, event, payload })
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

  async restartServer(): Promise<void> {
    const resp = await this.sendRequest({ type: 'server-restart' })
    if (resp.type !== 'server-restarted') throw new Error('Unexpected response')
  }

  async attach(sessionId: PtySessionId): Promise<{ scrollback: string; claudeContextPercent?: number; claudeSessionLineCount?: number }> {
    const resp = await this.sendRequest({ type: 'attach', sessionId })
    if (resp.type === 'attached') return { scrollback: resp.scrollback, claudeContextPercent: resp.claudeContextPercent, claudeSessionLineCount: resp.claudeSessionLineCount }
    throw new Error('Unexpected response')
  }

  async detach(sessionId: PtySessionId): Promise<void> {
    await this.sendRequest({ type: 'detach', sessionId })
  }

  async destroy(sessionId: PtySessionId): Promise<void> {
    await this.sendRequest({ type: 'destroy', sessionId })
  }

  write(sessionId: PtySessionId, data: string): void {
    this.sendFireAndForget({ type: 'write', sessionId, data })
  }

  // --- Node state mutations ---

  async nodeSyncRequest(): Promise<ServerMessage> {
    return this.sendRequest({ type: 'node-sync-request' })
  }

  async nodeMove(nodeId: NodeId, x: number, y: number): Promise<ServerMessage> {
    return this.sendRequest({ type: 'node-move', nodeId, x, y })
  }

  async nodeBatchMove(moves: Array<{ nodeId: NodeId; x: number; y: number }>): Promise<ServerMessage> {
    return this.sendRequest({ type: 'node-batch-move', moves })
  }

  async nodeRename(nodeId: NodeId, name: string): Promise<ServerMessage> {
    return this.sendRequest({ type: 'node-rename', nodeId, name })
  }

  async nodeSetColor(nodeId: NodeId, colorPresetId: string): Promise<ServerMessage> {
    return this.sendRequest({ type: 'node-set-color', nodeId, colorPresetId })
  }

  async nodeArchive(nodeId: NodeId): Promise<ServerMessage> {
    return this.sendRequest({ type: 'node-archive', nodeId })
  }

  async nodeUnarchive(parentNodeId: NodeId, archivedNodeId: NodeId): Promise<ServerMessage> {
    return this.sendRequest({ type: 'node-unarchive', parentNodeId, archivedNodeId })
  }

  async nodeArchiveDelete(parentNodeId: NodeId, archivedNodeId: NodeId): Promise<ServerMessage> {
    return this.sendRequest({ type: 'node-archive-delete', parentNodeId, archivedNodeId })
  }

  async undoPush(entry: import('../../shared/undo-types').UndoEntry): Promise<ServerMessage> {
    return this.sendRequest({ type: 'undo-buffer-push', entry })
  }

  async undoSetCursor(cursor: number): Promise<ServerMessage> {
    return this.sendRequest({ type: 'undo-buffer-set-cursor', cursor })
  }

  async nodeBringToFront(nodeId: NodeId): Promise<ServerMessage> {
    return this.sendRequest({ type: 'node-bring-to-front', nodeId })
  }

  async nodeReparent(nodeId: NodeId, newParentId: NodeId): Promise<ServerMessage> {
    return this.sendRequest({ type: 'node-reparent', nodeId, newParentId })
  }

  async nodeSwapParentChild(nodeId: NodeId, childId: NodeId): Promise<ServerMessage> {
    return this.sendRequest({ type: 'node-swap-parent-child', nodeId, childId })
  }

  async terminalCreate(parentId: NodeId, options?: CreateOptions, initialTitleHistory?: string[], initialName?: string, x?: number, y?: number, initialInput?: string): Promise<ServerMessage> {
    return this.sendRequest({ type: 'terminal-create', parentId, options, initialTitleHistory, initialName, x, y, initialInput })
  }

  async terminalResize(nodeId: NodeId, cols: number, rows: number): Promise<ServerMessage> {
    return this.sendRequest({ type: 'terminal-resize', nodeId, cols, rows })
  }

  async terminalReincarnate(nodeId: NodeId, options?: CreateOptions): Promise<ServerMessage> {
    return this.sendRequest({ type: 'terminal-reincarnate', nodeId, options })
  }

  async directoryAdd(parentId: NodeId, cwd: string, x?: number, y?: number): Promise<ServerMessage> {
    return this.sendRequest({ type: 'directory-add', parentId, cwd, x, y })
  }

  async directoryCwd(nodeId: NodeId, cwd: string): Promise<ServerMessage> {
    return this.sendRequest({ type: 'directory-cwd', nodeId, cwd })
  }

  async directoryGitFetch(nodeId: NodeId): Promise<ServerMessage> {
    return this.sendRequest({ type: 'directory-git-fetch', nodeId })
  }

  async directoryWtSpawn(nodeId: NodeId, branchName: string): Promise<ServerMessage> {
    return this.sendRequest({ type: 'directory-wt-spawn', nodeId, branchName })
  }

  async validateDirectory(path: string): Promise<ServerMessage> {
    return this.sendRequest({ type: 'validate-directory', path })
  }

  async fileAdd(parentId: NodeId, filePath: string, x?: number, y?: number): Promise<ServerMessage> {
    return this.sendRequest({ type: 'file-add', parentId, filePath, x, y })
  }

  async filePath(nodeId: NodeId, filePath: string): Promise<ServerMessage> {
    return this.sendRequest({ type: 'file-path', nodeId, filePath })
  }

  async validateFile(path: string, cwd?: string): Promise<ServerMessage> {
    return this.sendRequest({ type: 'validate-file', path, cwd })
  }

  async markdownAdd(parentId: NodeId, x?: number, y?: number): Promise<ServerMessage> {
    return this.sendRequest({ type: 'markdown-add', parentId, x, y })
  }

  async markdownResize(nodeId: NodeId, width: number, height: number): Promise<ServerMessage> {
    return this.sendRequest({ type: 'markdown-resize', nodeId, width, height })
  }

  async markdownContent(nodeId: NodeId, content: string): Promise<ServerMessage> {
    return this.sendRequest({ type: 'markdown-content', nodeId, content })
  }

  async markdownSetMaxWidth(nodeId: NodeId, maxWidth: number): Promise<ServerMessage> {
    return this.sendRequest({ type: 'markdown-set-max-width', nodeId, maxWidth })
  }

  async titleAdd(parentId: NodeId, x?: number, y?: number): Promise<ServerMessage> {
    return this.sendRequest({ type: 'title-add', parentId, x, y })
  }

  async titleText(nodeId: NodeId, text: string): Promise<ServerMessage> {
    return this.sendRequest({ type: 'title-text', nodeId, text })
  }

  async forkSession(nodeId: NodeId): Promise<ServerMessage> {
    return this.sendRequest({ type: 'fork-session', nodeId })
  }

  async terminalRestart(nodeId: NodeId, extraCliArgs: string): Promise<ServerMessage> {
    return this.sendRequest({ type: 'terminal-restart', nodeId, extraCliArgs })
  }

  async crabReorder(order: string[]): Promise<ServerMessage> {
    return this.sendRequest({ type: 'crab-reorder', order })
  }

  setTerminalMode(sessionId: PtySessionId, mode: 'live' | 'snapshot'): void {
    this.sendFireAndForget({ type: 'set-terminal-mode', sessionId, mode })
  }

  setClaudeStatusUnread(sessionId: PtySessionId, unread: boolean): void {
    this.sendFireAndForget({ type: 'set-claude-status-unread', sessionId, unread } as ClientMessage)
  }

  setClaudeStatusAsleep(sessionId: PtySessionId, asleep: boolean): void {
    this.sendFireAndForget({ type: 'set-claude-status-asleep', sessionId, asleep } as ClientMessage)
  }

  setAlertsReadTimestamp(nodeId: NodeId, timestamp: number): void {
    this.sendFireAndForget({ type: 'set-alerts-read-timestamp', nodeId, timestamp } as ClientMessage)
  }

  sendCameraBounds(bounds: CameraBounds): void {
    this.sendFireAndForget({ type: 'camera-bounds', bounds })
  }

  saveViewport(slot: string, bounds: CameraBounds): void {
    this.sendFireAndForget({ type: 'save-viewport', slot, bounds })
  }

  focusSurface(surfaceId: PtySessionId): void {
    this.sendFireAndForget({ type: 'focus-surface-request', surfaceId })
  }

  startSummaryChat(nodeId: NodeId): void {
    this.sendFireAndForget({ type: 'summary-chat-start', nodeId })
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
    const waiters = this.connectionWaiters.splice(0)
    waiters.forEach(({ reject }) => reject(new Error('Server connection stopped')))
  }
}
