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
  SessionInfo,
  SnapshotMessage,
  SummaryChatToggleOutcome,
  SummaryChatUiState,
} from './protocol'
import type { LaunchPrefs } from './launch-prefs'
import type { NodeData, ServerState } from './state'
import type { SystemMetricsSample } from './system-metrics'
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
export type { SummaryChatPhase, SummaryChatUiState, SummaryChatToggleOutcome } from './protocol'

/**
 * What one press of the Summary Chat chord did.
 *
 * The press is a toggle whose meaning the server decides, so the outcome is the
 * only way the renderer knows which feedback to give: a confirming chirp, an
 * abort chirp, or a shake and a toast carrying `message`.
 */
export interface SummaryChatToggleResult {
  outcome: SummaryChatToggleOutcome
  message?: string
}

export interface TtsApi {
  speak(text: string): Promise<{ available: boolean }>
  stop(): void
}

export interface PerfApi {
  startTrace(): Promise<void>
  stopTrace(): Promise<string>
}

/**
 * A mod's own wire, in both directions.
 *
 * Two methods rather than two per mod: `modId` namespaces the traffic and
 * `payload` is opaque, so the bridge does not widen when a mod is added. See
 * `ModMessage` in `./protocol` for why that is the whole design.
 */
export interface ModsApi {
  /** Send one envelope toward the server and any listening mod process. */
  send(modId: string, event: string, payload: unknown): void
  /**
   * Listen for envelopes belonging to one mod. Other mods' traffic is filtered
   * out here rather than delivered and ignored, so a mod cannot accidentally
   * come to depend on another's messages.
   */
  onMessage(modId: string, callback: (event: string, payload: unknown) => void): () => void
}

/**
 * The power monitor's feed.
 *
 * Sampling is opt-in rather than always-on: reading GPU and battery state
 * means spawning `ioreg` twice a second, and a measuring instrument that runs
 * unasked would show up in its own readings. `setMetricsEnabled(false)` stops
 * the timer outright.
 */
export interface SystemApi {
  setMetricsEnabled(enabled: boolean): void
  onMetrics(callback: (sample: SystemMetricsSample) => void): () => void
  /** What the *next* launch will use. */
  getLaunchPrefs(): Promise<LaunchPrefs>
  /** Merge a patch into the stored prefs. Returns what is now stored. */
  setLaunchPrefs(patch: Partial<LaunchPrefs>): Promise<LaunchPrefs>
  /** What the *running* process launched with, so unapplied changes are visible. */
  getActiveLaunchPrefs(): Promise<LaunchPrefs>
}

export interface WindowApi {
  /** Resize the window to fill the current display's work area (screen minus menu bar and dock). */
  fitToWorkArea(): Promise<void>
  onVisibilityChanged(callback: (visible: boolean) => void): () => void
  /**
   * Keyboard focus, which is *not* visibility: an unfocused window is still on
   * screen and may be the one being watched. Consumed by `frame-policy` to pick
   * a frame rate, never to decide whether to draw at all.
   */
  onFocusChanged(callback: (focused: boolean) => void): () => void
  /**
   * An external focus request (a `spaceterm-surface://` deep link) reached this
   * window. `null` means the id it carried matched nothing — no live surface, no
   * agent session, and nothing in the archive the server could restore: the
   * renderer zooms out to the whole canvas so the miss is visible, rather than
   * silently leaving the camera where it was.
   */
  onFocusNode(callback: (nodeId: NodeId | null) => void): () => void
}

/** The object exposed as `window.api` by `src/client/preload/index.ts`. */
export interface Api {
  pty: PtyApi
  node: NodeApi
  log(message: string): void
  /**
   * Press the Summary Chat chord. Pass the focused terminal surface, or
   * undefined when nothing eligible is focused — a press with nothing focused
   * still cancels whatever is speaking.
   */
  toggleSummaryChat(nodeId: NodeId | undefined): Promise<SummaryChatToggleResult>
  restartSpaceterm(): Promise<void>
  writeDebugLog(content: string): Promise<string>
  openExternal(url: string): Promise<void>
  diffFiles(fileA: string, fileB: string): Promise<void>
  tts: TtsApi
  perf: PerfApi
  window: WindowApi
  system: SystemApi
  mods: ModsApi
}
