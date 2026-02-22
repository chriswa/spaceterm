interface SessionInfo {
  sessionId: string
  cols: number
  rows: number
}

interface CreateOptions {
  cwd?: string
  command?: string
  args?: string[]
  claude?: { prompt?: string; resumeSessionId?: string; appendSystemPrompt?: boolean }
}

interface CreateResult extends SessionInfo {
  cwd?: string
  claudeSessionHistory?: ClaudeSessionEntry[]
}

interface ClaudeSessionEntry {
  claudeSessionId: string
  reason: 'startup' | 'fork' | 'clear' | 'compact' | 'resume'
  timestamp: string
}

interface AttachResult {
  scrollback: string
  claudeContextPercent?: number
  claudeSessionLineCount?: number
}

interface PtyApi {
  create(options?: CreateOptions): Promise<CreateResult>
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

interface NodeApi {
  syncRequest(): Promise<import('../../../shared/state').ServerState>
  move(nodeId: string, x: number, y: number): Promise<void>
  batchMove(moves: Array<{ nodeId: string; x: number; y: number }>): Promise<void>
  rename(nodeId: string, name: string): Promise<void>
  setColor(nodeId: string, colorPresetId: string): Promise<void>
  archive(nodeId: string): Promise<void>
  unarchive(parentNodeId: string, archivedNodeId: string): Promise<void>
  archiveDelete(parentNodeId: string, archivedNodeId: string): Promise<void>
  bringToFront(nodeId: string): Promise<void>
  reparent(nodeId: string, newParentId: string): Promise<void>
  terminalCreate(parentId: string, options?: CreateOptions, initialTitleHistory?: string[], initialName?: string): Promise<{ sessionId: string; cols: number; rows: number }>
  terminalResize(nodeId: string, cols: number, rows: number): Promise<void>
  terminalReincarnate(nodeId: string, options?: CreateOptions): Promise<{ sessionId: string; cols: number; rows: number }>
  terminalRestart(nodeId: string, extraCliArgs: string): Promise<{ sessionId: string; cols: number; rows: number }>
  forkSession(nodeId: string): Promise<{ sessionId: string; cols: number; rows: number }>
  setTerminalMode(sessionId: string, mode: 'live' | 'snapshot'): void
  setClaudeStatusUnread(sessionId: string, unread: boolean): void
  onSnapshot(sessionId: string, callback: (snapshot: import('../../../shared/protocol').SnapshotMessage) => void): () => void
  directoryAdd(parentId: string, x: number, y: number, cwd: string): Promise<{ nodeId: string }>
  directoryCwd(nodeId: string, cwd: string): Promise<void>
  directoryGitFetch(nodeId: string): Promise<void>
  validateDirectory(path: string): Promise<{ valid: boolean; error?: string }>
  fileAdd(parentId: string, filePath: string): Promise<{ nodeId: string }>
  filePath(nodeId: string, filePath: string): Promise<void>
  validateFile(path: string, cwd?: string): Promise<{ valid: boolean; error?: string }>
  markdownAdd(parentId: string, x: number, y: number): Promise<{ nodeId: string }>
  markdownResize(nodeId: string, width: number, height: number): Promise<void>
  markdownContent(nodeId: string, content: string): Promise<void>
  onFileContent(callback: (nodeId: string, content: string) => void): () => void
  onUpdated(callback: (nodeId: string, fields: Partial<import('../../../shared/state').NodeData>) => void): () => void
  onAdded(callback: (node: import('../../../shared/state').NodeData) => void): () => void
  onRemoved(callback: (nodeId: string) => void): () => void
  onServerError(callback: (message: string) => void): () => void
}

interface TtsApi {
  speak(text: string): Promise<{ chunks: Array<{ samples: ArrayBuffer; sampleRate: number; pauseAfterMs: number }>; available: boolean }>
  stop(): void
}

interface PerfApi {
  startTrace(): Promise<void>
  stopTrace(): Promise<string>
}

interface AudioApi {
  onBeat(callback: (data: { energy: number; beat: boolean; onset: boolean; bpm: number; phase: number; confidence: number; hasSignal: boolean }) => void): () => void
  start(): Promise<void>
  stop(): Promise<void>
}

interface WindowApi {
  isFullScreen(): Promise<boolean>
  setFullScreen(enabled: boolean): Promise<void>
  onVisibilityChanged(callback: (visible: boolean) => void): () => void
}

interface Api {
  pty: PtyApi
  node: NodeApi
  log(message: string): void
  openExternal(url: string): Promise<void>
  diffFiles(fileA: string, fileB: string): Promise<void>
  tts: TtsApi
  perf: PerfApi
  audio: AudioApi
  window: WindowApi
}

declare interface Window {
  api: Api
}
