interface SessionInfo {
  sessionId: string
  cols: number
  rows: number
}

interface CreateOptions {
  cwd?: string
  command?: string
  args?: string[]
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
  shellTitleHistory?: string[]
  cwd?: string
  claudeSessionHistory?: ClaudeSessionEntry[]
  claudeState?: string
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
  onShellTitleHistory(sessionId: string, callback: (history: string[]) => void): () => void
  onCwd(sessionId: string, callback: (cwd: string) => void): () => void
  onClaudeSessionHistory(sessionId: string, callback: (history: ClaudeSessionEntry[]) => void): () => void
  onClaudeState(sessionId: string, callback: (state: string) => void): () => void
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
  terminalCreate(parentId: string, x: number, y: number, options?: CreateOptions, initialTitleHistory?: string[]): Promise<{ sessionId: string; cols: number; rows: number }>
  terminalResize(nodeId: string, cols: number, rows: number): Promise<void>
  terminalReincarnate(nodeId: string, options?: CreateOptions): Promise<{ sessionId: string; cols: number; rows: number }>
  setTerminalMode(sessionId: string, mode: 'live' | 'snapshot'): void
  onSnapshot(sessionId: string, callback: (snapshot: import('../../../shared/protocol').SnapshotMessage) => void): () => void
  markdownAdd(parentId: string, x: number, y: number): Promise<void>
  markdownResize(nodeId: string, width: number, height: number): Promise<void>
  markdownContent(nodeId: string, content: string): Promise<void>
  onUpdated(callback: (nodeId: string, fields: Partial<import('../../../shared/state').NodeData>) => void): () => void
  onAdded(callback: (node: import('../../../shared/state').NodeData) => void): () => void
  onRemoved(callback: (nodeId: string) => void): () => void
}

interface TtsApi {
  speak(text: string): Promise<{ chunks: Array<{ samples: ArrayBuffer; sampleRate: number; pauseAfterMs: number }> }>
  stop(): void
}

interface PerfApi {
  startTrace(): Promise<void>
  stopTrace(): Promise<string>
}

interface Api {
  pty: PtyApi
  node: NodeApi
  log(message: string): void
  openExternal(url: string): Promise<void>
  tts: TtsApi
  perf: PerfApi
}

declare interface Window {
  api: Api
}
