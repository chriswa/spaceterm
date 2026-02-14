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
  onServerStatus(callback: (connected: boolean) => void): () => void
}

interface Api {
  pty: PtyApi
  log(message: string): void
  openExternal(url: string): Promise<void>
}

declare interface Window {
  api: Api
}
