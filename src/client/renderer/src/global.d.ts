interface SessionInfo {
  sessionId: string
  cols: number
  rows: number
}

interface PtyApi {
  create(): Promise<SessionInfo>
  list(): Promise<SessionInfo[]>
  attach(sessionId: string): Promise<string>
  write(sessionId: string, data: string): void
  resize(sessionId: string, cols: number, rows: number): void
  destroy(sessionId: string): Promise<void>
  onData(sessionId: string, callback: (data: string) => void): () => void
  onExit(sessionId: string, callback: (exitCode: number) => void): () => void
  onServerStatus(callback: (connected: boolean) => void): () => void
}

interface Api {
  pty: PtyApi
  log(message: string): void
}

declare interface Window {
  api: Api
}
