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

export interface AttachResult {
  scrollback: string
  shellTitleHistory?: string[]
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
  onShellTitleHistory(sessionId: string, callback: (history: string[]) => void): () => void
  onServerStatus(callback: (connected: boolean) => void): () => void
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

  onServerStatus: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, connected: boolean) => callback(connected)
    ipcRenderer.on('server:status', listener)
    return () => ipcRenderer.removeListener('server:status', listener)
  }
}

contextBridge.exposeInMainWorld('api', {
  pty: ptyApi,
  log: (message: string) => ipcRenderer.send('log', message),
  openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url)
})
