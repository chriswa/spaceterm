/**
 * The contextBridge contract — the single source of truth for `window.api`.
 *
 * This shape was previously declared three times: once in `src/client/preload/index.ts`
 * (as the annotation on the object literal that implements it) and once in
 * `src/client/renderer/src/global.d.ts` (as what the renderer type-checks against),
 * with `src/shared/protocol.ts` separately owning the wire types. Nothing linked the
 * copies, because preload lives in the `tsconfig.node.json` project and the renderer
 * in `tsconfig.web.json`, and `global.d.ts` was a `.d.ts` that `skipLibCheck` skipped
 * entirely. They drifted: `directoryAdd`'s parameters were declared in the opposite
 * order from the implementation, eleven implemented members were missing from the
 * preload interface, and six were missing from the renderer's.
 *
 * Both sides now import from here, so a change to the bridge is one edit and any
 * mismatch is a compile error in the project that got it wrong.
 *
 * Rule of thumb when editing: this file describes the *IPC bridge*, not the socket
 * protocol. Wire message shapes live in `./protocol` — import them here rather than
 * restating them.
 */
import type {
  CameraBounds,
  ClaudeSessionEntry,
  CreateOptions,
  GhRateLimitData,
  SessionInfo,
  SnapshotMessage,
} from './protocol'
import type { NodeData, ServerState } from './state'
import type { UndoEntry } from './undo-types'
import type { NodeId, PtySessionId } from './ids'

export type { CameraBounds, ClaudeSessionEntry, CreateOptions, SessionInfo }

/**
 * `pty:attach` forwards exactly the fields carried by the `attached` wire message
 * (see `AttachedMessage` in ./protocol). It does NOT include shellTitleHistory,
 * cwd, or claudeSessionHistory — those reach the renderer via node-updated
 * broadcasts, not via attach.
 */
export interface AttachResult {
  scrollback: string
  claudeContextPercent?: number
  claudeSessionLineCount?: number
}

export interface PtyApi {
  create(options?: CreateOptions): Promise<SessionInfo>
  list(): Promise<SessionInfo[]>
  attach(sessionId: PtySessionId): Promise<AttachResult>
  write(sessionId: PtySessionId, data: string): void
  resize(sessionId: PtySessionId, cols: number, rows: number): void
  destroy(sessionId: PtySessionId): Promise<void>
  onData(sessionId: PtySessionId, callback: (data: string) => void): () => void
  onExit(sessionId: PtySessionId, callback: (exitCode: number) => void): () => void
  onClaudeContext(sessionId: PtySessionId, callback: (percent: number) => void): () => void
  onClaudeSessionLineCount(sessionId: PtySessionId, callback: (lineCount: number) => void): () => void
  onPlanCacheUpdate(sessionId: PtySessionId, callback: (count: number, files: string[]) => void): () => void
}

export interface NodeApi {
  syncRequest(): Promise<ServerState>
  move(nodeId: NodeId, x: number, y: number): Promise<void>
  batchMove(moves: Array<{ nodeId: NodeId; x: number; y: number }>): Promise<void>
  rename(nodeId: NodeId, name: string): Promise<void>
  setColor(nodeId: NodeId, colorPresetId: string): Promise<void>
  archive(nodeId: NodeId): Promise<void>
  unarchive(parentNodeId: NodeId, archivedNodeId: NodeId): Promise<void>
  archiveDelete(parentNodeId: NodeId, archivedNodeId: NodeId): Promise<void>
  undoPush(entry: UndoEntry): Promise<void>
  undoSetCursor(cursor: number): Promise<void>
  bringToFront(nodeId: NodeId): Promise<void>
  reparent(nodeId: NodeId, newParentId: NodeId): Promise<void>
  swapParentChild(nodeId: NodeId, childId: NodeId): Promise<void>

  terminalCreate(
    parentId: NodeId,
    options?: CreateOptions,
    initialTitleHistory?: string[],
    initialName?: string,
    x?: number,
    y?: number,
    initialInput?: string,
  ): Promise<SessionInfo>
  terminalResize(nodeId: NodeId, cols: number, rows: number): Promise<void>
  terminalReincarnate(nodeId: NodeId, options?: CreateOptions): Promise<SessionInfo>
  terminalRestart(nodeId: NodeId, extraCliArgs: string): Promise<SessionInfo>
  forkSession(nodeId: NodeId): Promise<SessionInfo>
  setTerminalMode(sessionId: PtySessionId, mode: 'live' | 'snapshot'): void
  crabReorder(order: string[]): Promise<void>

  directoryAdd(parentId: NodeId, cwd: string, x?: number, y?: number): Promise<{ nodeId: NodeId }>
  directoryCwd(nodeId: NodeId, cwd: string): Promise<void>
  directoryGitFetch(nodeId: NodeId): Promise<void>
  directoryWtSpawn(nodeId: NodeId, branchName: string): Promise<{ nodeId: NodeId }>
  validateDirectory(path: string): Promise<{ valid: boolean; error?: string }>

  fileAdd(parentId: NodeId, filePath: string, x?: number, y?: number): Promise<{ nodeId: NodeId }>
  filePath(nodeId: NodeId, filePath: string): Promise<void>
  validateFile(path: string, cwd?: string): Promise<{ valid: boolean; error?: string }>

  markdownAdd(parentId: NodeId, x?: number, y?: number): Promise<{ nodeId: NodeId }>
  markdownResize(nodeId: NodeId, width: number, height: number): Promise<void>
  markdownContent(nodeId: NodeId, content: string): Promise<void>
  markdownSetMaxWidth(nodeId: NodeId, maxWidth: number): Promise<void>

  titleAdd(parentId: NodeId, x?: number, y?: number): Promise<{ nodeId: NodeId }>
  titleText(nodeId: NodeId, text: string): Promise<void>

  setClaudeStatusUnread(sessionId: PtySessionId, unread: boolean): void
  setClaudeStatusAsleep(sessionId: PtySessionId, asleep: boolean): void
  setAlertsReadTimestamp(nodeId: NodeId, timestamp: number): void
  sendCameraBounds(bounds: CameraBounds): void
  saveViewport(slot: string, bounds: CameraBounds): void

  onSnapshot(sessionId: PtySessionId, callback: (snapshot: SnapshotMessage) => void): () => void
  onUpdated(callback: (nodeId: NodeId, fields: Partial<NodeData>) => void): () => void
  onAdded(callback: (node: NodeData) => void): () => void
  onRemoved(callback: (nodeId: NodeId) => void): () => void
  onFileContent(callback: (nodeId: NodeId, content: string) => void): () => void
  onServerError(callback: (message: string) => void): () => void
  onGhRateLimit(
    callback: (data: GhRateLimitData, usedHistory: (number | null)[], slotMinutes: number) => void,
  ): () => void
  onPlaySound(callback: (sound: string) => void): () => void
  onSpeak(callback: (text: string) => void): () => void
  onSpeakingChanged(
    callback: (nodeId: NodeId, speaking: boolean, voice: string | undefined) => void,
  ): () => void
  onSummaryChatStatus(
    callback: (nodeId: NodeId, state: SummaryChatUiState, message?: string) => void,
  ): () => void
  onPeerConnected(callback: (clientId: string) => void): () => void
  onPeerDisconnected(callback: (clientId: string) => void): () => void
  onPeerCameraBounds(callback: (clientId: string, bounds: CameraBounds) => void): () => void
  onSavedViewports(callback: (viewports: Record<string, CameraBounds>) => void): () => void
}

/** Status the toolbar renders for a surface's summary-chat session. */
export type SummaryChatUiState = 'thinking' | 'ready' | 'target' | 'error'

export interface TtsApi {
  speak(text: string): Promise<{ available: boolean }>
  stop(): void
}

export interface PerfApi {
  startTrace(): Promise<void>
  stopTrace(): Promise<string>
}

export interface WindowApi {
  isFullScreen(): Promise<boolean>
  setFullScreen(enabled: boolean): Promise<void>
  onVisibilityChanged(callback: (visible: boolean) => void): () => void
  onFocusNode(callback: (nodeId: NodeId) => void): () => void
}

/** The object exposed as `window.api` by `src/client/preload/index.ts`. */
export interface Api {
  pty: PtyApi
  node: NodeApi
  log(message: string): void
  startSummaryChat(nodeId: NodeId): void
  restartSpaceterm(): Promise<void>
  writeDebugLog(content: string): Promise<string>
  openExternal(url: string): Promise<void>
  diffFiles(fileA: string, fileB: string): Promise<void>
  tts: TtsApi
  perf: PerfApi
  window: WindowApi
}
