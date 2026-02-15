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
  onShellTitleHistory(sessionId: string, callback: (history: string[]) => void): () => void
  onCwd(sessionId: string, callback: (cwd: string) => void): () => void
  onClaudeSessionHistory(sessionId: string, callback: (history: ClaudeSessionEntry[]) => void): () => void
  onClaudeState(sessionId: string, callback: (state: string) => void): () => void
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

  onShellTitleHistory: (sessionId, callback) => {
    const channel = `pty:shell-title-history:${sessionId}`
    const listener = (_event: Electron.IpcRendererEvent, history: string[]) => callback(history)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  },

  onCwd: (sessionId, callback) => {
    const channel = `pty:cwd:${sessionId}`
    const listener = (_event: Electron.IpcRendererEvent, cwd: string) => callback(cwd)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  },

  onClaudeSessionHistory: (sessionId, callback) => {
    const channel = `pty:claude-session-history:${sessionId}`
    const listener = (_event: Electron.IpcRendererEvent, history: ClaudeSessionEntry[]) => callback(history)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  },

  onClaudeState: (sessionId, callback) => {
    const channel = `pty:claude-state:${sessionId}`
    const listener = (_event: Electron.IpcRendererEvent, state: string) => callback(state)
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
  terminalCreate(parentId: string, x: number, y: number, options?: CreateOptions, initialTitleHistory?: string[]): Promise<{ sessionId: string; cols: number; rows: number }>
  terminalResize(nodeId: string, cols: number, rows: number): Promise<void>
  terminalReincarnate(nodeId: string, options?: CreateOptions): Promise<{ sessionId: string; cols: number; rows: number }>
  setTerminalMode(sessionId: string, mode: 'live' | 'snapshot'): void
  onSnapshot(sessionId: string, callback: (snapshot: any) => void): () => void
  markdownAdd(parentId: string, x: number, y: number): Promise<void>
  markdownResize(nodeId: string, width: number, height: number): Promise<void>
  markdownContent(nodeId: string, content: string): Promise<void>
  onUpdated(callback: (nodeId: string, fields: any) => void): () => void
  onAdded(callback: (node: any) => void): () => void
  onRemoved(callback: (nodeId: string) => void): () => void
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
  terminalCreate: (parentId, x, y, options?, initialTitleHistory?) => ipcRenderer.invoke('node:terminal-create', parentId, x, y, options, initialTitleHistory),
  terminalResize: (nodeId, cols, rows) => ipcRenderer.invoke('node:terminal-resize', nodeId, cols, rows),
  terminalReincarnate: (nodeId, options?) => ipcRenderer.invoke('node:terminal-reincarnate', nodeId, options),
  markdownAdd: (parentId, x, y) => ipcRenderer.invoke('node:markdown-add', parentId, x, y),
  markdownResize: (nodeId, width, height) => ipcRenderer.invoke('node:markdown-resize', nodeId, width, height),
  markdownContent: (nodeId, content) => ipcRenderer.invoke('node:markdown-content', nodeId, content),

  setTerminalMode: (sessionId, mode) => ipcRenderer.send('node:set-terminal-mode', sessionId, mode),
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
  }
}

contextBridge.exposeInMainWorld('api', {
  pty: ptyApi,
  node: nodeApi,
  log: (message: string) => ipcRenderer.send('log', message),
  openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url),
  tts: {
    speak: (text: string) => ipcRenderer.invoke('tts:speak', text),
    stop: () => ipcRenderer.send('tts:stop')
  }
})
