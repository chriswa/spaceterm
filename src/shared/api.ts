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
  attach(sessionId: string): Promise<AttachResult>
  write(sessionId: string, data: string): void
  resize(sessionId: string, cols: number, rows: number): void
  destroy(sessionId: string): Promise<void>
  onData(sessionId: string, callback: (data: string) => void): () => void
  onExit(sessionId: string, callback: (exitCode: number) => void): () => void
  onClaudeContext(sessionId: string, callback: (percent: number) => void): () => void
  onClaudeSessionLineCount(sessionId: string, callback: (lineCount: number) => void): () => void
  onPlanCacheUpdate(sessionId: string, callback: (count: number, files: string[]) => void): () => void
}

export interface NodeApi {
  syncRequest(): Promise<ServerState>
  move(nodeId: string, x: number, y: number): Promise<void>
  batchMove(moves: Array<{ nodeId: string; x: number; y: number }>): Promise<void>
  rename(nodeId: string, name: string): Promise<void>
  setColor(nodeId: string, colorPresetId: string): Promise<void>
  archive(nodeId: string): Promise<void>
  unarchive(parentNodeId: string, archivedNodeId: string): Promise<void>
  archiveDelete(parentNodeId: string, archivedNodeId: string): Promise<void>
  undoPush(entry: UndoEntry): Promise<void>
  undoSetCursor(cursor: number): Promise<void>
  bringToFront(nodeId: string): Promise<void>
  reparent(nodeId: string, newParentId: string): Promise<void>
  swapParentChild(nodeId: string, childId: string): Promise<void>

  terminalCreate(
    parentId: string,
    options?: CreateOptions,
    initialTitleHistory?: string[],
    initialName?: string,
    x?: number,
    y?: number,
    initialInput?: string,
  ): Promise<SessionInfo>
  terminalResize(nodeId: string, cols: number, rows: number): Promise<void>
  terminalReincarnate(nodeId: string, options?: CreateOptions): Promise<SessionInfo>
  terminalRestart(nodeId: string, extraCliArgs: string): Promise<SessionInfo>
  forkSession(nodeId: string): Promise<SessionInfo>
  setTerminalMode(sessionId: string, mode: 'live' | 'snapshot'): void
  crabReorder(order: string[]): Promise<void>

  directoryAdd(parentId: string, cwd: string, x?: number, y?: number): Promise<{ nodeId: string }>
  directoryCwd(nodeId: string, cwd: string): Promise<void>
  directoryGitFetch(nodeId: string): Promise<void>
  directoryWtSpawn(nodeId: string, branchName: string): Promise<{ nodeId: string }>
  validateDirectory(path: string): Promise<{ valid: boolean; error?: string }>

  fileAdd(parentId: string, filePath: string, x?: number, y?: number): Promise<{ nodeId: string }>
  filePath(nodeId: string, filePath: string): Promise<void>
  validateFile(path: string, cwd?: string): Promise<{ valid: boolean; error?: string }>

  markdownAdd(parentId: string, x?: number, y?: number): Promise<{ nodeId: string }>
  markdownResize(nodeId: string, width: number, height: number): Promise<void>
  markdownContent(nodeId: string, content: string): Promise<void>
  markdownSetMaxWidth(nodeId: string, maxWidth: number): Promise<void>

  titleAdd(parentId: string, x?: number, y?: number): Promise<{ nodeId: string }>
  titleText(nodeId: string, text: string): Promise<void>

  setClaudeStatusUnread(sessionId: string, unread: boolean): void
  setClaudeStatusAsleep(sessionId: string, asleep: boolean): void
  setAlertsReadTimestamp(nodeId: string, timestamp: number): void
  sendCameraBounds(bounds: CameraBounds): void
  saveViewport(slot: string, bounds: CameraBounds): void

  onSnapshot(sessionId: string, callback: (snapshot: SnapshotMessage) => void): () => void
  onUpdated(callback: (nodeId: string, fields: Partial<NodeData>) => void): () => void
  onAdded(callback: (node: NodeData) => void): () => void
  onRemoved(callback: (nodeId: string) => void): () => void
  onFileContent(callback: (nodeId: string, content: string) => void): () => void
  onServerError(callback: (message: string) => void): () => void
  onGhRateLimit(
    callback: (data: GhRateLimitData, usedHistory: (number | null)[], slotMinutes: number) => void,
  ): () => void
  onPlaySound(callback: (sound: string) => void): () => void
  onSpeak(callback: (text: string) => void): () => void
  onSpeakingChanged(
    callback: (nodeId: string, speaking: boolean, voice: string | undefined) => void,
  ): () => void
  onSummaryChatStatus(
    callback: (nodeId: string, state: SummaryChatUiState, message?: string) => void,
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
  onFocusNode(callback: (nodeId: string) => void): () => void
}

/** The object exposed as `window.api` by `src/client/preload/index.ts`. */
export interface Api {
  pty: PtyApi
  node: NodeApi
  log(message: string): void
  startSummaryChat(nodeId: string): void
  restartSpaceterm(): Promise<void>
  writeDebugLog(content: string): Promise<string>
  openExternal(url: string): Promise<void>
  diffFiles(fileA: string, fileB: string): Promise<void>
  tts: TtsApi
  perf: PerfApi
  window: WindowApi
}
