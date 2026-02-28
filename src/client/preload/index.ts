import { contextBridge, ipcRenderer } from 'electron'

export interface SessionInfo {
  sessionId: string
  cols: number
  rows: number
}

export interface CreateOptions {
  cwd?: string
  command?: string
  args?: string[]
  claude?: { prompt?: string; resumeSessionId?: string; appendSystemPrompt?: boolean }
}

export interface CreateResult extends SessionInfo {
  cwd?: string
}

export interface ClaudeSessionEntry {
  claudeSessionId: string
  reason: 'startup' | 'fork' | 'clear' | 'compact' | 'resume'
  timestamp: string
}

export interface AttachResult {
  scrollback: string
  shellTitleHistory?: string[]
  cwd?: string
  claudeSessionHistory?: ClaudeSessionEntry[]
  claudeState?: string
  claudeContextPercent?: number
  claudeSessionLineCount?: number
}

export interface PtyApi {
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

const ptyApi: PtyApi = {
  create: (options?) => ipcRenderer.invoke('pty:create', options),

  list: () => ipcRenderer.invoke('pty:list'),

  attach: (sessionId) => ipcRenderer.invoke('pty:attach', sessionId),

  write: (sessionId, data) => ipcRenderer.send('pty:write', sessionId, data),

  resize: (sessionId, cols, rows) => ipcRenderer.send('pty:resize', sessionId, cols, rows),

  destroy: (sessionId) => ipcRenderer.invoke('pty:destroy', sessionId),

  onData: (sessionId, callback) => {
    const channel = `pty:data:${sessionId}`
    const listener = (_event: Electron.IpcRendererEvent, data: string) => callback(data)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  },

  onExit: (sessionId, callback) => {
    const channel = `pty:exit:${sessionId}`
    const listener = (_event: Electron.IpcRendererEvent, exitCode: number) => callback(exitCode)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  },

  onClaudeContext: (sessionId, callback) => {
    const channel = `pty:claude-context:${sessionId}`
    const listener = (_event: Electron.IpcRendererEvent, percent: number) => callback(percent)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  },

  onClaudeSessionLineCount: (sessionId, callback) => {
    const channel = `pty:claude-session-line-count:${sessionId}`
    const listener = (_event: Electron.IpcRendererEvent, lineCount: number) => callback(lineCount)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  },

  onPlanCacheUpdate: (sessionId, callback) => {
    const channel = `pty:plan-cache-update:${sessionId}`
    const listener = (_event: Electron.IpcRendererEvent, count: number, files: string[]) => callback(count, files)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  },

}

interface NodeApi {
  syncRequest(): Promise<any>
  move(nodeId: string, x: number, y: number): Promise<void>
  batchMove(moves: Array<{ nodeId: string; x: number; y: number }>): Promise<void>
  rename(nodeId: string, name: string): Promise<void>
  setColor(nodeId: string, colorPresetId: string): Promise<void>
  archive(nodeId: string): Promise<void>
  unarchive(parentNodeId: string, archivedNodeId: string): Promise<void>
  archiveDelete(parentNodeId: string, archivedNodeId: string): Promise<void>
  bringToFront(nodeId: string): Promise<void>
  reparent(nodeId: string, newParentId: string): Promise<void>
  terminalCreate(parentId: string, options?: CreateOptions, initialTitleHistory?: string[], initialName?: string, x?: number, y?: number, initialInput?: string): Promise<{ sessionId: string; cols: number; rows: number }>
  terminalResize(nodeId: string, cols: number, rows: number): Promise<void>
  terminalReincarnate(nodeId: string, options?: CreateOptions): Promise<{ sessionId: string; cols: number; rows: number }>
  terminalRestart(nodeId: string, extraCliArgs: string): Promise<{ sessionId: string; cols: number; rows: number }>
  crabReorder(order: string[]): Promise<void>
  setTerminalMode(sessionId: string, mode: 'live' | 'snapshot'): void
  onSnapshot(sessionId: string, callback: (snapshot: any) => void): () => void
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
  onUpdated(callback: (nodeId: string, fields: any) => void): () => void
  onAdded(callback: (node: any) => void): () => void
  onRemoved(callback: (nodeId: string) => void): () => void
  onFileContent(callback: (nodeId: string, content: string) => void): () => void
  onServerError(callback: (message: string) => void): () => void
}

const nodeApi: NodeApi = {
  syncRequest: () => ipcRenderer.invoke('node:sync-request'),
  move: (nodeId, x, y) => ipcRenderer.invoke('node:move', nodeId, x, y),
  batchMove: (moves) => ipcRenderer.invoke('node:batch-move', moves),
  rename: (nodeId, name) => ipcRenderer.invoke('node:rename', nodeId, name),
  setColor: (nodeId, colorPresetId) => ipcRenderer.invoke('node:set-color', nodeId, colorPresetId),
  archive: (nodeId) => ipcRenderer.invoke('node:archive', nodeId),
  unarchive: (parentNodeId, archivedNodeId) => ipcRenderer.invoke('node:unarchive', parentNodeId, archivedNodeId),
  archiveDelete: (parentNodeId, archivedNodeId) => ipcRenderer.invoke('node:archive-delete', parentNodeId, archivedNodeId),
  bringToFront: (nodeId) => ipcRenderer.invoke('node:bring-to-front', nodeId),
  reparent: (nodeId, newParentId) => ipcRenderer.invoke('node:reparent', nodeId, newParentId),
  terminalCreate: (parentId, options?, initialTitleHistory?, initialName?, x?, y?, initialInput?) => ipcRenderer.invoke('node:terminal-create', parentId, options, initialTitleHistory, initialName, x, y, initialInput),
  terminalResize: (nodeId, cols, rows) => ipcRenderer.invoke('node:terminal-resize', nodeId, cols, rows),
  terminalReincarnate: (nodeId, options?) => ipcRenderer.invoke('node:terminal-reincarnate', nodeId, options),
  forkSession: (nodeId) => ipcRenderer.invoke('node:fork-session', nodeId),
  terminalRestart: (nodeId: string, extraCliArgs: string) => ipcRenderer.invoke('node:terminal-restart', nodeId, extraCliArgs),
  crabReorder: (order: string[]) => ipcRenderer.invoke('node:crab-reorder', order),
  directoryAdd: (parentId, cwd, x?, y?) => ipcRenderer.invoke('node:directory-add', parentId, cwd, x, y),
  directoryCwd: (nodeId, cwd) => ipcRenderer.invoke('node:directory-cwd', nodeId, cwd),
  directoryGitFetch: (nodeId) => ipcRenderer.invoke('node:directory-git-fetch', nodeId),
  directoryWtSpawn: (nodeId, branchName) => ipcRenderer.invoke('node:directory-wt-spawn', nodeId, branchName),
  validateDirectory: (path) => ipcRenderer.invoke('node:validate-directory', path),
  fileAdd: (parentId, filePath, x?, y?) => ipcRenderer.invoke('node:file-add', parentId, filePath, x, y),
  filePath: (nodeId, filePath) => ipcRenderer.invoke('node:file-path', nodeId, filePath),
  validateFile: (path, cwd) => ipcRenderer.invoke('node:validate-file', path, cwd),
  markdownAdd: (parentId, x?, y?) => ipcRenderer.invoke('node:markdown-add', parentId, x, y),
  markdownResize: (nodeId, width, height) => ipcRenderer.invoke('node:markdown-resize', nodeId, width, height),
  markdownContent: (nodeId, content) => ipcRenderer.invoke('node:markdown-content', nodeId, content),
  markdownSetMaxWidth: (nodeId, maxWidth) => ipcRenderer.invoke('node:markdown-set-max-width', nodeId, maxWidth),
  titleAdd: (parentId, x?, y?) => ipcRenderer.invoke('node:title-add', parentId, x, y),
  titleText: (nodeId, text) => ipcRenderer.invoke('node:title-text', nodeId, text),

  setTerminalMode: (sessionId, mode) => ipcRenderer.send('node:set-terminal-mode', sessionId, mode),
  setClaudeStatusUnread: (sessionId: string, unread: boolean) => ipcRenderer.send('node:set-claude-status-unread', sessionId, unread),
  setClaudeStatusAsleep: (sessionId: string, asleep: boolean) => ipcRenderer.send('node:set-claude-status-asleep', sessionId, asleep),
  setAlertsReadTimestamp: (nodeId: string, timestamp: number) => ipcRenderer.send('node:set-alerts-read-timestamp', nodeId, timestamp),
  onSnapshot: (sessionId, callback) => {
    const channel = `snapshot:${sessionId}`
    const listener = (_event: Electron.IpcRendererEvent, snapshot: any) => callback(snapshot)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  },
  onUpdated: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, nodeId: string, fields: any) => callback(nodeId, fields)
    ipcRenderer.on('node:updated', listener)
    return () => ipcRenderer.removeListener('node:updated', listener)
  },
  onAdded: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, node: any) => callback(node)
    ipcRenderer.on('node:added', listener)
    return () => ipcRenderer.removeListener('node:added', listener)
  },
  onRemoved: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, nodeId: string) => callback(nodeId)
    ipcRenderer.on('node:removed', listener)
    return () => ipcRenderer.removeListener('node:removed', listener)
  },
  onFileContent: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, nodeId: string, content: string) => callback(nodeId, content)
    ipcRenderer.on('node:file-content', listener)
    return () => ipcRenderer.removeListener('node:file-content', listener)
  },
  onServerError: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, message: string) => callback(message)
    ipcRenderer.on('server:error', listener)
    return () => ipcRenderer.removeListener('server:error', listener)
  },
  onClaudeUsage: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, usage: any, subscriptionType: string, rateLimitTier: string, creditHistory: (number | null)[]) => callback(usage, subscriptionType, rateLimitTier, creditHistory)
    ipcRenderer.on('claude-usage', listener)
    return () => ipcRenderer.removeListener('claude-usage', listener)
  },
  onGhRateLimit: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, data: any, usedHistory: (number | null)[]) => callback(data, usedHistory)
    ipcRenderer.on('gh-rate-limit', listener)
    return () => ipcRenderer.removeListener('gh-rate-limit', listener)
  }
}

contextBridge.exposeInMainWorld('api', {
  pty: ptyApi,
  node: nodeApi,
  log: (message: string) => ipcRenderer.send('log', message),
  openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url),
  diffFiles: (fileA: string, fileB: string) => ipcRenderer.invoke('shell:diffFiles', fileA, fileB),
  window: {
    isFullScreen: (): Promise<boolean> => ipcRenderer.invoke('window:is-fullscreen'),
    setFullScreen: (enabled: boolean) => ipcRenderer.invoke('window:set-fullscreen', enabled),
    onVisibilityChanged: (callback: (visible: boolean) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, visible: boolean) => callback(visible)
      ipcRenderer.on('window:visibility-changed', listener)
      return () => ipcRenderer.removeListener('window:visibility-changed', listener)
    }
  },
  tts: {
    speak: (text: string) => ipcRenderer.invoke('tts:speak', text),
    stop: () => ipcRenderer.send('tts:stop')
  },
  perf: {
    startTrace: () => ipcRenderer.invoke('perf:trace-start'),
    stopTrace: (): Promise<string> => ipcRenderer.invoke('perf:trace-stop')
  },
  audio: {
    onBeat: (callback: (data: { energy: number; beat: boolean; onset: boolean; bpm: number; phase: number; confidence: number; hasSignal: boolean }) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, data: { energy: number; beat: boolean; onset: boolean; bpm: number; phase: number; confidence: number; hasSignal: boolean }) => callback(data)
      ipcRenderer.on('audio:beat', listener)
      return () => ipcRenderer.removeListener('audio:beat', listener)
    },
    start: () => ipcRenderer.invoke('audio:start'),
    stop: () => ipcRenderer.invoke('audio:stop')
  }
})
