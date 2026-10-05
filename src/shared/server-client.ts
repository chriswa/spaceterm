import { CLIENT_PROTOCOL_VERSION } from './client-protocol-version'
import type { UsageSnapshot } from './usage-report'
import type { AgentSearchMode, ClientDevice, ControlTranscriptEntry, SpeechProgressEvent } from './protocol'
import type {
  ClientMessage,
  CreateOptions,
  ServerMessage,
  SessionInfo,
  CameraBounds,
  SpeakOutcome
} from './protocol'
import type { AgentSearchResponse, CommandOutcome, SummaryChatMode, SummaryChatToggleResult } from './api'
import { unhandledVariant } from './exhaustive'
import type { NodeId, PtySessionId } from './ids'
import type { NodeStamp, ServerState } from './state'
import type { UndoEntry } from './undo-types'

/**
 * The client half of the client socket protocol: request/reply correlation,
 * event fan-out, the version handshake and reconnection.
 *
 * Every client runs this same code — the Electron renderer and the mobile web
 * app alike — and differs only in the {@link ServerTransport} underneath it.
 * That is deliberate: it used to live in Electron's main process, behind a
 * hundred IPC relays, and a second client would have needed a second copy of
 * all of it. One copy means a protocol bug shows up on both or neither.
 *
 * No Node imports. It is reachable from the renderer entry, and
 * `renderer-purity.test.ts` keeps it that way.
 */

/** Callbacks for one connection attempt. */
export interface TransportHandlers {
  /** The connection is up; `send` works from here. */
  onOpen(): void
  /**
   * Text from the server. Not necessarily whole lines — a byte-stream
   * transport delivers chunks as they arrive, and the client reassembles.
   */
  onData(chunk: string): void
  /**
   * The attempt failed, or a live connection dropped. Fires exactly once per
   * `open`, whether or not `onOpen` came first; reconnection is the client's
   * decision, not the transport's.
   */
  onClose(): void
}

/** One way of reaching the server: a Unix socket via IPC, or a WebSocket. */
export interface ServerTransport {
  /** Begin one connection attempt. */
  open(handlers: TransportHandlers): void
  send(text: string): void
  /** Abandon the current attempt or connection. No `onClose` follows. */
  close(): void
}

export interface ServerClientOptions {
  /** Named in the `client-hello` handshake, for the server's logs. */
  clientName: string
  /** The device this client runs on, named in `client-hello`: what holds Control. */
  device: ClientDevice
  log?: (message: string) => void
}

/** Messages the server sends unprompted. Everything else is a reply. */
export type ServerEventType =
  | 'mod' | 'data' | 'exit' | 'node-updated' | 'node-added' | 'node-removed'
  | 'file-content' | 'snapshot' | 'play-sound' | 'speech-active' | 'speaking-changed'
  | 'summary-chat-status' | 'peer-connected' | 'peer-disconnected' | 'peer-camera-bounds'
  | 'focus-surface' | 'saved-viewports' | 'root-cwd' | 'auto-stamps-enabled' | 'restart-required' | 'usage-report'
  | 'system-stats'
  | 'speech-audio' | 'speech-stop' | 'mobile-build-changed'
  | 'agent-meta-availability' | 'server-error'
  | 'receptionist-status' | 'receptionist-holder' | 'camera-follow' | 'agent-names' | 'receptionist-notice'
  | 'receptionist-transcript-appended'
  | 'hands-free-tuning' | 'dictation-end-phrase'

export type ServerEvent<T extends ServerEventType = ServerEventType> = Extract<ServerMessage, { type: T }>

/** Connection lifecycle, which is not a server message. */
export type LifecycleEvent = 'connect' | 'disconnect' | 'protocol-mismatch'

const INITIAL_RECONNECT_DELAY = 200
const MAX_RECONNECT_DELAY = 1000

interface PendingRequest {
  resolve: (msg: ServerMessage) => void
  reject: (err: Error) => void
}

/** Distributive `Omit`, so each union member keeps its own fields. */
type WithoutSeq<T> = T extends unknown ? Omit<T, 'seq'> : never
type RequestMessage = WithoutSeq<Extract<ClientMessage, { seq: number }>>

function unexpected(resp: ServerMessage): never {
  throw new Error(`Unexpected response: ${resp.type}`)
}

export class ServerClient {
  private seq = 0
  private pending = new Map<number, PendingRequest>()
  private connected = false
  private attempting = false
  private shouldReconnect = true
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectDelay = INITIAL_RECONNECT_DELAY
  private connectionWaiters: Array<() => void> = []
  private buffer = ''
  private readonly eventListeners = new Map<string, Set<(msg: never) => void>>()
  private readonly lifecycleListeners = new Map<LifecycleEvent, Set<(detail?: string) => void>>()
  private readonly log: (message: string) => void

  constructor(private readonly transport: ServerTransport, private readonly options: ServerClientOptions) {
    this.log = options.log ?? (() => undefined)
  }

  // ─── connection ───────────────────────────────────────────────────────────

  /**
   * Resolve once connected. Never rejects: like the socket client it replaced,
   * it retries with backoff until `disconnect()`. A caller that needs to give
   * up races it against a timer.
   */
  connect(): Promise<void> {
    if (this.connected) return Promise.resolve()
    this.shouldReconnect = true
    const waiting = new Promise<void>((resolve) => this.connectionWaiters.push(resolve))
    this.beginConnection()
    return waiting
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
    this.transport.close()
    this.attempting = false
    const wasConnected = this.connected
    this.connected = false
    this.rejectAllPending()
    if (wasConnected) this.emitLifecycle('disconnect')
  }

  private beginConnection(): void {
    // One attempt in flight at a time, so a failure's paired events cannot
    // turn into a storm of overlapping reconnects.
    if (this.connected || this.attempting) return
    this.attempting = true
    this.buffer = ''
    this.transport.open({
      onOpen: () => {
        this.attempting = false
        this.connected = true
        this.reconnectDelay = INITIAL_RECONNECT_DELAY
        this.connectionWaiters.splice(0).forEach((resolve) => resolve())
        this.emitLifecycle('connect')
        // Deliberately after the waiters: the handshake is diagnostic, and
        // blocking startup on it would make a report into a failure.
        void this.handshake()
      },
      onData: (chunk) => this.feed(chunk),
      onClose: () => {
        this.attempting = false
        const wasConnected = this.connected
        this.connected = false
        this.rejectAllPending()
        if (wasConnected) this.emitLifecycle('disconnect')
        if (this.shouldReconnect) this.scheduleReconnect()
      }
    })
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
    this.pending.forEach((req) => req.reject(new Error('Disconnected from server')))
    this.pending.clear()
  }

  /** Reassemble newline-delimited JSON from however the transport chunked it. */
  private feed(chunk: string): void {
    this.buffer += chunk
    let newline: number
    while ((newline = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newline)
      this.buffer = this.buffer.slice(newline + 1)
      if (line.trim() === '') continue
      let msg: ServerMessage
      try {
        msg = JSON.parse(line) as ServerMessage
      } catch {
        this.log(`[server-client] Dropped an unparseable line (${line.length} chars)`)
        continue
      }
      this.handleMessage(msg)
    }
  }

  // ─── events ───────────────────────────────────────────────────────────────

  /** Listen for one kind of server event. Returns the unsubscribe. */
  on<T extends ServerEventType>(type: T, listener: (msg: ServerEvent<T>) => void): () => void {
    let set = this.eventListeners.get(type)
    if (!set) {
      set = new Set()
      this.eventListeners.set(type, set)
    }
    const entry = listener as (msg: never) => void
    set.add(entry)
    return () => set.delete(entry)
  }

  onLifecycle(event: LifecycleEvent, listener: (detail?: string) => void): () => void {
    let set = this.lifecycleListeners.get(event)
    if (!set) {
      set = new Set()
      this.lifecycleListeners.set(event, set)
    }
    set.add(listener)
    return () => set.delete(listener)
  }

  private emit(msg: ServerEvent): void {
    const set = this.eventListeners.get(msg.type)
    if (!set) return
    for (const listener of set) {
      // One bad listener must not starve the rest of an event — the renderer
      // once stopped applying node updates because a sound failed to play.
      try {
        listener(msg as never)
      } catch (err) {
        this.log(`[server-client] '${msg.type}' listener threw: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  private emitLifecycle(event: LifecycleEvent, detail?: string): void {
    this.lifecycleListeners.get(event)?.forEach((listener) => listener(detail))
  }

  /**
   * Route one message. A `switch` so the `default:` branch can assert the
   * union is covered: adding a `ServerMessage` variant without deciding whether
   * it is an event or a correlated reply is a type error here.
   */
  private handleMessage(msg: ServerMessage): void {
    switch (msg.type) {
      case 'mod':
      case 'data':
      case 'exit':
      case 'node-updated':
      case 'node-added':
      case 'node-removed':
      case 'file-content':
      case 'snapshot':
      case 'play-sound':
      case 'speech-active':
      case 'speaking-changed':
      case 'summary-chat-status':
      case 'peer-connected':
      case 'peer-disconnected':
      case 'peer-camera-bounds':
      case 'focus-surface':
      case 'saved-viewports':
      case 'root-cwd':
      case 'auto-stamps-enabled':
      case 'restart-required':
      case 'usage-report':
      case 'system-stats':
      case 'speech-audio':
      case 'speech-stop':
      case 'mobile-build-changed':
      case 'agent-meta-availability':
      case 'receptionist-status':
      case 'receptionist-holder':
      case 'camera-follow':
      case 'agent-names':
      case 'receptionist-notice':
      case 'receptionist-transcript-appended':
      case 'hands-free-tuning':
      case 'dictation-end-phrase':
        this.emit(msg)
        return

      // An error is broadcast, and also rejects its request if correlated.
      case 'server-error':
        this.emit(msg)
        if (typeof msg.seq === 'number') {
          const pending = this.pending.get(msg.seq)
          if (pending) {
            this.pending.delete(msg.seq)
            pending.reject(new Error(msg.message))
          }
        }
        return

      case 'created':
      case 'server-restarted':
      case 'restart-flag-result':
      case 'usage-report-result':
      case 'mobile-app-install-result':
      case 'listed':
      case 'attached':
      case 'detached':
      case 'destroyed':
      case 'sync-state':
      case 'mutation-ack':
      case 'node-add-ack':
      case 'validate-directory-result':
      case 'directory-command-result':
      case 'validate-file-result':
      case 'client-hello-result':
      case 'summary-chat-toggle-result':
      case 'speak-toggle-result':
      case 'agent-meta-toggle-result':
      case 'agent-meta-availability-result':
      case 'agent-search-result':
      case 'dictation-started':
      case 'dictation-result':
      case 'wake-word-result':
      case 'dictation-turn-result':
      case 'agent-memory-result':
      case 'receptionist-transcript-result': {
        const pending = this.pending.get(msg.seq)
        if (!pending) return
        this.pending.delete(msg.seq)
        pending.resolve(msg)
        return
      }

      default:
        this.log(`[server-client] Unknown message type: ${unhandledVariant(msg)}`)
        return
    }
  }

  /**
   * Tell the server which protocol version this build speaks, and log a
   * mismatch. Best-effort: the symptom of a stale server without it is a
   * message that does not parse, several layers away from the cause.
   */
  private async handshake(): Promise<void> {
    try {
      const reply = await this.request({
        type: 'client-hello',
        protocolVersion: CLIENT_PROTOCOL_VERSION,
        client: this.options.clientName,
        device: this.options.device
      })
      if (reply.type !== 'client-hello-result') return
      if (reply.compatible) {
        this.log(`[server-client] Protocol v${CLIENT_PROTOCOL_VERSION} accepted`)
      } else {
        this.log(
          `[server-client] PROTOCOL MISMATCH: ${reply.error ?? 'incompatible'}. ` +
          `This client speaks v${CLIENT_PROTOCOL_VERSION}; the server serves ` +
          `v${reply.minProtocolVersion}-v${reply.protocolVersion}. ` +
          'A stale server may be running — restart Spaceterm.'
        )
        this.emitLifecycle('protocol-mismatch', reply.error ?? 'incompatible protocol version')
      }
    } catch {
      this.log('[server-client] Server did not answer the protocol handshake (pre-v1 server?)')
    }
  }

  // ─── wire ─────────────────────────────────────────────────────────────────

  private request(msg: RequestMessage): Promise<ServerMessage> {
    return new Promise((resolve, reject) => {
      if (!this.connected) {
        reject(new Error('Not connected to server'))
        return
      }
      const seq = ++this.seq
      this.pending.set(seq, { resolve, reject })
      this.transport.send(JSON.stringify({ ...msg, seq }) + '\n')
    })
  }

  private async ack(msg: RequestMessage): Promise<void> {
    await this.request(msg)
  }

  private fireAndForget(msg: ClientMessage): void {
    if (!this.connected) return
    this.transport.send(JSON.stringify(msg) + '\n')
  }

  private async session(msg: RequestMessage): Promise<SessionInfo> {
    const resp = await this.request(msg)
    if (resp.type === 'created') return { sessionId: resp.sessionId, cols: resp.cols, rows: resp.rows }
    return unexpected(resp)
  }

  private async added(msg: RequestMessage): Promise<{ nodeId: NodeId }> {
    const resp = await this.request(msg)
    // An add the server declined is acknowledged without an id; callers have
    // always received `{}` for it, and the type has always claimed otherwise.
    return (resp.type === 'node-add-ack' ? { nodeId: resp.nodeId } : {}) as { nodeId: NodeId }
  }

  private async command(msg: RequestMessage): Promise<CommandOutcome> {
    const resp = await this.request(msg)
    if (resp.type === 'directory-command-result') return { ok: resp.ok, error: resp.error }
    return unexpected(resp)
  }

  // ─── pty ──────────────────────────────────────────────────────────────────

  create(options?: CreateOptions): Promise<SessionInfo> {
    return this.session({ type: 'create', options })
  }

  async list(): Promise<SessionInfo[]> {
    const resp = await this.request({ type: 'list' })
    if (resp.type === 'listed') return resp.sessions
    return unexpected(resp)
  }

  async attach(sessionId: PtySessionId): Promise<{ scrollback: string }> {
    const resp = await this.request({ type: 'attach', sessionId })
    if (resp.type === 'attached') return { scrollback: resp.scrollback }
    return unexpected(resp)
  }

  detach(sessionId: PtySessionId): Promise<void> {
    return this.ack({ type: 'detach', sessionId })
  }

  destroy(sessionId: PtySessionId): Promise<void> {
    return this.ack({ type: 'destroy', sessionId })
  }

  write(sessionId: PtySessionId, data: string): void {
    this.fireAndForget({ type: 'write', sessionId, data })
  }

  // ─── server ───────────────────────────────────────────────────────────────

  async restartServer(): Promise<void> {
    const resp = await this.request({ type: 'server-restart' })
    if (resp.type !== 'server-restarted') unexpected(resp)
  }

  async restartFlagQuery(): Promise<{ required: boolean; reason: string }> {
    const resp = await this.request({ type: 'restart-flag-query' })
    if (resp.type === 'restart-flag-result') return { required: resp.required, reason: resp.reason }
    return unexpected(resp)
  }

  async usageReportQuery(): Promise<UsageSnapshot | null> {
    const resp = await this.request({ type: 'usage-report-query' })
    if (resp.type === 'usage-report-result') return resp.snapshot
    return unexpected(resp)
  }

  // ─── nodes ────────────────────────────────────────────────────────────────

  async syncRequest(): Promise<ServerState> {
    const resp = await this.request({ type: 'node-sync-request' })
    if (resp.type === 'sync-state') return resp.state
    return unexpected(resp)
  }

  nodeMove(nodeId: NodeId, x: number, y: number): Promise<void> {
    return this.ack({ type: 'node-move', nodeId, x, y })
  }

  nodeBatchMove(moves: Array<{ nodeId: NodeId; x: number; y: number }>): Promise<void> {
    return this.ack({ type: 'node-batch-move', moves })
  }

  nodeRename(nodeId: NodeId, name: string): Promise<void> {
    return this.ack({ type: 'node-rename', nodeId, name })
  }

  nodeSetColor(nodeId: NodeId, colorPresetId: string): Promise<void> {
    return this.ack({ type: 'node-set-color', nodeId, colorPresetId })
  }

  nodeSetStamp(nodeId: NodeId, stamp: NodeStamp): Promise<void> {
    return this.ack({ type: 'node-set-stamp', nodeId, stamp })
  }

  nodeRegenerateAutoStamp(nodeId: NodeId): Promise<void> {
    return this.ack({ type: 'node-regenerate-auto-stamp', nodeId })
  }

  nodeArchive(nodeId: NodeId): Promise<void> {
    return this.ack({ type: 'node-archive', nodeId })
  }

  nodeUnarchive(parentNodeId: NodeId, path: NodeId[]): Promise<void> {
    return this.ack({ type: 'node-unarchive', parentNodeId, path })
  }

  nodeArchiveDelete(parentNodeId: NodeId, path: NodeId[]): Promise<void> {
    return this.ack({ type: 'node-archive-delete', parentNodeId, path })
  }

  undoPush(entry: UndoEntry): Promise<void> {
    return this.ack({ type: 'undo-buffer-push', entry })
  }

  undoSetCursor(cursor: number): Promise<void> {
    return this.ack({ type: 'undo-buffer-set-cursor', cursor })
  }

  nodeBringToFront(nodeId: NodeId): Promise<void> {
    return this.ack({ type: 'node-bring-to-front', nodeId })
  }

  nodeReparent(nodeId: NodeId, newParentId: NodeId): Promise<void> {
    return this.ack({ type: 'node-reparent', nodeId, newParentId })
  }

  nodeSwapParentChild(nodeId: NodeId, childId: NodeId): Promise<void> {
    return this.ack({ type: 'node-swap-parent-child', nodeId, childId })
  }

  terminalCreate(
    parentId: NodeId, options?: CreateOptions, initialTitleHistory?: string[],
    initialName?: string, x?: number, y?: number, initialInput?: string
  ): Promise<SessionInfo> {
    return this.session({ type: 'terminal-create', parentId, options, initialTitleHistory, initialName, x, y, initialInput })
  }

  terminalResize(nodeId: NodeId, cols: number, rows: number): Promise<void> {
    return this.ack({ type: 'terminal-resize', nodeId, cols, rows })
  }

  terminalBorrowSize(nodeId: NodeId, cols: number, rows: number): Promise<void> {
    return this.ack({ type: 'terminal-borrow-size', nodeId, cols, rows })
  }

  terminalReturnSize(nodeId: NodeId): Promise<void> {
    return this.ack({ type: 'terminal-return-size', nodeId })
  }

  terminalReincarnate(nodeId: NodeId, options?: CreateOptions): Promise<SessionInfo> {
    return this.session({ type: 'terminal-reincarnate', nodeId, options })
  }

  async terminalRestart(nodeId: NodeId, extraCliArgs: string): Promise<SessionInfo> {
    this.log(`[terminal-restart] Restart requested for node=${nodeId.slice(0, 8)} extraCliArgs=${JSON.stringify(extraCliArgs)}`)
    try {
      const info = await this.session({ type: 'terminal-restart', nodeId, extraCliArgs })
      this.log(`[terminal-restart] Success node=${nodeId.slice(0, 8)} → session=${info.sessionId.slice(0, 8)}`)
      return info
    } catch (err: unknown) {
      this.log(`[terminal-restart] Failed node=${nodeId.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`)
      throw err
    }
  }

  forkSession(nodeId: NodeId): Promise<SessionInfo> {
    return this.session({ type: 'fork-session', nodeId })
  }

  /**
   * Paste `text` into a terminal surface as one bracketed paste, then submit
   * it. The server owns the timing and the newline handling, so every caller —
   * a markdown card's button, the phone's composer, a script — ships the same
   * way.
   */
  shipIt(nodeId: NodeId, text: string): Promise<void> {
    return this.ack({ type: 'ship-it', nodeId, text })
  }

  crabReorder(order: string[]): Promise<void> {
    // The Api has always typed this as plain strings; they are node ids.
    return this.ack({ type: 'crab-reorder', order: order as NodeId[] })
  }

  directoryAdd(parentId: NodeId, cwd: string, x?: number, y?: number): Promise<{ nodeId: NodeId }> {
    return this.added({ type: 'directory-add', parentId, cwd, x, y })
  }

  directoryCwd(nodeId: NodeId, cwd: string): Promise<void> {
    return this.ack({ type: 'directory-cwd', nodeId, cwd })
  }

  /** Set the root node's working directory; an empty string clears it. */
  setRootCwd(cwd: string): Promise<void> {
    return this.ack({ type: 'set-root-cwd', cwd })
  }

  setAutoStampsEnabled(enabled: boolean): Promise<void> {
    return this.ack({ type: 'set-auto-stamps-enabled', enabled })
  }

  directoryGitFetch(nodeId: NodeId): Promise<void> {
    return this.ack({ type: 'directory-git-fetch', nodeId })
  }

  directoryGitRun(nodeId: NodeId, command: 'pull' | 'push'): Promise<CommandOutcome> {
    return this.command({ type: 'directory-git-run', nodeId, command })
  }

  directoryOpenGitHubDesktop(nodeId: NodeId): Promise<CommandOutcome> {
    return this.command({ type: 'directory-open-github-desktop', nodeId })
  }

  async validateDirectory(path: string): Promise<{ valid: boolean; error?: string }> {
    const resp = await this.request({ type: 'validate-directory', path })
    if (resp.type === 'validate-directory-result') return { valid: resp.valid, error: resp.error }
    return unexpected(resp)
  }

  fileAdd(parentId: NodeId, filePath: string, x?: number, y?: number): Promise<{ nodeId: NodeId }> {
    return this.added({ type: 'file-add', parentId, filePath, x, y })
  }

  filePath(nodeId: NodeId, filePath: string): Promise<void> {
    return this.ack({ type: 'file-path', nodeId, filePath })
  }

  async validateFile(path: string, cwd?: string): Promise<{ valid: boolean; error?: string }> {
    const resp = await this.request({ type: 'validate-file', path, cwd })
    if (resp.type === 'validate-file-result') return { valid: resp.valid, error: resp.error }
    return unexpected(resp)
  }

  markdownAdd(parentId: NodeId, x?: number, y?: number): Promise<{ nodeId: NodeId }> {
    return this.added({ type: 'markdown-add', parentId, x, y })
  }

  markdownResize(nodeId: NodeId, width: number, height: number): Promise<void> {
    return this.ack({ type: 'markdown-resize', nodeId, width, height })
  }

  markdownContent(nodeId: NodeId, content: string): Promise<void> {
    return this.ack({ type: 'markdown-content', nodeId, content })
  }

  markdownSetMaxWidth(nodeId: NodeId, maxWidth: number): Promise<void> {
    return this.ack({ type: 'markdown-set-max-width', nodeId, maxWidth })
  }

  async agentSearch(query: string, mode: AgentSearchMode): Promise<AgentSearchResponse> {
    const resp = await this.request({ type: 'agent-search', query, mode })
    if (resp.type !== 'agent-search-result') return unexpected(resp)
    const { type: _type, seq: _seq, ...result } = resp
    return result
  }

  async agentMetaAvailabilityStatus(): Promise<Array<{ nodeId: NodeId; available: boolean }>> {
    const resp = await this.request({ type: 'agent-meta-availability-query' })
    return resp.type === 'agent-meta-availability-result' ? resp.entries : []
  }

  async agentMetaToggle(nodeId: NodeId): Promise<boolean> {
    const resp = await this.request({ type: 'agent-meta-toggle', nodeId })
    return resp.type === 'agent-meta-toggle-result' ? resp.open : false
  }

  agentMetaRescan(nodeId: NodeId): Promise<void> {
    return this.ack({ type: 'agent-meta-rescan', nodeId })
  }

  metaDocResize(nodeId: NodeId, width: number, height: number): Promise<void> {
    return this.ack({ type: 'meta-doc-resize', nodeId, width, height })
  }

  metaDocContent(nodeId: NodeId, content: string): Promise<void> {
    return this.ack({ type: 'meta-doc-content', nodeId, content })
  }

  titleAdd(parentId: NodeId, x?: number, y?: number): Promise<{ nodeId: NodeId }> {
    return this.added({ type: 'title-add', parentId, x, y })
  }

  titleText(nodeId: NodeId, text: string): Promise<void> {
    return this.ack({ type: 'title-text', nodeId, text })
  }

  cacheTimerMute(nodeId: NodeId, muted: boolean): Promise<void> {
    return this.ack({ type: 'cache-timer-mute', nodeId, muted })
  }

  // ─── fire-and-forget ──────────────────────────────────────────────────────

  recordInteraction(nodeId: NodeId): void {
    this.fireAndForget({ type: 'node-interaction', nodeId })
  }

  setTerminalMode(sessionId: PtySessionId, mode: 'live' | 'snapshot'): void {
    this.fireAndForget({ type: 'set-terminal-mode', sessionId, mode })
  }

  setClaudeStatusUnread(sessionId: PtySessionId, unread: boolean): void {
    this.fireAndForget({ type: 'set-claude-status-unread', sessionId, unread })
  }

  setClaudeStatusBackground(sessionId: PtySessionId, background: boolean): void {
    this.fireAndForget({ type: 'set-claude-status-background', sessionId, background })
  }

  setClaudeStatusAsleep(sessionId: PtySessionId, asleep: boolean): void {
    this.fireAndForget({ type: 'set-claude-status-asleep', sessionId, asleep })
  }

  setAlertsReadTimestamp(nodeId: NodeId, timestamp: number): void {
    this.fireAndForget({ type: 'set-alerts-read-timestamp', nodeId, timestamp })
  }

  /** Not remembered across a reconnect: the caller sends it again on 'connect'. */
  watchSystemStats(watching: boolean): void {
    this.fireAndForget({ type: 'system-stats-watch', watching })
  }

  sendCameraBounds(bounds: CameraBounds): void {
    this.fireAndForget({ type: 'camera-bounds', bounds })
  }

  saveViewport(slot: string, bounds: CameraBounds): void {
    this.fireAndForget({ type: 'save-viewport', slot, bounds })
  }

  /**
   * Raise whichever surface `id` names. Opaque because the deep link it comes
   * from does not say whether it holds a surface id or an agent session id;
   * the server resolves that against node state.
   */
  requestFocusById(id: string): void {
    this.fireAndForget({ type: 'focus-id-request', id })
  }

  /**
   * Put one mod envelope on the wire. Fire-and-forget by design: a
   * request/reply would mean the base correlating messages it cannot read.
   */
  sendMod(modId: string, event: string, payload: unknown): void {
    this.fireAndForget({ type: 'mod', modId, event, payload })
  }

  /** Put a line in the server's log, for a client that has nowhere else to write. */
  clientLog(message: string): void {
    this.fireAndForget({ type: 'client-log', message })
  }

  /** Memory of every process under the PTY daemon, measured on the server. */
  async agentMemory(): Promise<number | null> {
    const resp = await this.request({ type: 'agent-memory-query' })
    if (resp.type === 'agent-memory-result') return resp.bytes
    return unexpected(resp)
  }

  // ─── dictation ────────────────────────────────────────────────────────────
  //
  // For a client that captures audio but cannot transcribe it: the server
  // relays the PCM through Voice Operator. See src/server/remote-dictation.ts.

  async dictationStart(sampleRate: number, endPhrase?: string): Promise<string> {
    const resp = await this.request({ type: 'dictation-start', sampleRate, ...(endPhrase ? { endPhrase } : {}) })
    if (resp.type === 'dictation-started') return resp.id
    return unexpected(resp)
  }

  /** Base64 PCM, s16le mono. Dropped silently when disconnected; finish will fail. */
  dictationAudio(id: string, pcmBase64: string): void {
    this.fireAndForget({ type: 'dictation-audio', id, pcm: pcmBase64 })
  }

  async dictationFinish(id: string): Promise<string> {
    const resp = await this.request({ type: 'dictation-finish', id })
    if (resp.type === 'dictation-result') return resp.text
    return unexpected(resp)
  }

  dictationCancel(id: string): void {
    this.fireAndForget({ type: 'dictation-cancel', id })
  }

  /** Whether the speaker sounds finished, 0..1; null without a turn model. */
  async dictationTurnCheck(id: string): Promise<number | null> {
    const resp = await this.request({ type: 'dictation-turn-check', id })
    if (resp.type === 'dictation-turn-result') return resp.probability
    return unexpected(resp)
  }

  // ─── hands-free ───────────────────────────────────────────────────────────

  /** Whether a clip (16 kHz s16le mono, base64) is the wake word alone; `error` when it could not be checked. */
  async checkWakeWord(pcmBase64: string): Promise<{ match: boolean; error?: string }> {
    const resp = await this.request({ type: 'wake-word-check', pcm: pcmBase64 })
    if (resp.type === 'wake-word-result') return { match: resp.match, error: resp.error }
    return unexpected(resp)
  }

  /** Words said hands-free, for Control. */
  receptionistHandsFree(text: string): void {
    this.log(`[hands-free] ${text.length} chars to Control`)
    this.fireAndForget({ type: 'receptionist-hands-free', text })
  }

  /** Build and install the iPhone app from the Mac. Resolves when it fails, or — rarely seen — succeeds. */
  async installMobileApp(): Promise<{ ok: boolean; message?: string }> {
    this.log('[mobile-install] asking the Mac to build and install the app')
    const resp = await this.request({ type: 'mobile-app-install' })
    if (resp.type !== 'mobile-app-install-result') return unexpected(resp)
    return { ok: resp.ok, message: resp.message }
  }

  speechProgress(id: string, index: number, event: SpeechProgressEvent): void {
    this.fireAndForget({ type: 'speech-progress', id, index, event })
  }

  // ─── speech ───────────────────────────────────────────────────────────────

  /** Speak a selection, or stop what is already being said — the server rules on which. */
  async toggleSpeak(text: string): Promise<SpeakOutcome> {
    const resp = await this.request({ type: 'speak-toggle', text })
    if (resp.type === 'speak-toggle-result') return resp.outcome
    return unexpected(resp)
  }

  stopSpeak(): void {
    this.fireAndForget({ type: 'speak-stop' })
  }

  /**
   * One press of the Summary Chat chord. Request/reply because only the server
   * can say whether a press started an answer or cut one off.
   */
  async toggleSummaryChat(nodeId: NodeId | undefined, mode: SummaryChatMode, playHere = false): Promise<SummaryChatToggleResult> {
    this.log(`[summary-chat] ${mode} chord pressed, focused node=${nodeId ? nodeId.slice(0, 8) : 'none'}${playHere ? ', speaking here' : ''}`)
    const resp = await this.request({ type: 'summary-chat-toggle', mode, ...(nodeId ? { nodeId } : {}), ...(playHere ? { playHere } : {}) })
    if (resp.type !== 'summary-chat-toggle-result') return unexpected(resp)
    this.log(`[summary-chat] chord ${resp.outcome}${resp.message ? `: ${resp.message}` : ''}`)
    return { outcome: resp.outcome, message: resp.message }
  }

  summaryChatFollowUp(text: string): void {
    this.log(`[summary-chat] follow-up from this client (${text.length} chars)`)
    this.fireAndForget({ type: 'summary-chat-follow-up', text })
  }

  endSummaryChat(): void {
    this.log('[summary-chat] abandoned from this client')
    this.fireAndForget({ type: 'summary-chat-end' })
  }

  /**
   * Press Control: make the receptionist the voice target, or stop it if it is
   * producing speech. The server decides which; the outcome comes back as a
   * `receptionist-status` broadcast.
   */
  selectReceptionist(): void {
    this.log('[receptionist] selected from this client')
    this.fireAndForget({ type: 'receptionist-select' })
  }

  /** The device this client runs on. */
  get device(): ClientDevice { return this.options.device }

  stopReceptionist(): void {
    this.fireAndForget({ type: 'receptionist-stop' })
  }

  /** Typed in Control's transcript view. */
  sayToReceptionist(text: string): void {
    this.log(`[receptionist] ${text.length} chars typed to Control`)
    this.fireAndForget({ type: 'receptionist-say', text })
  }

  async receptionistTranscript(before: number | undefined, count: number): Promise<{ entries: ControlTranscriptEntry[]; more: boolean }> {
    const resp = await this.request({ type: 'receptionist-transcript', count, ...(before === undefined ? {} : { before }) })
    if (resp.type === 'receptionist-transcript-result') return { entries: resp.entries, more: resp.more }
    return unexpected(resp)
  }
}
