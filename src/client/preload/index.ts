import { contextBridge, ipcRenderer } from 'electron'
// The bridge contract lives in src/shared/api.ts so the renderer type-checks
// against the same declaration this file implements. Do not restate it here.
import type { Api, NodeApi, PtyApi } from '../../shared/api'
import type { NodeId, PtySessionId } from '../../shared/ids'

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

const nodeApi: NodeApi = {
  syncRequest: () => ipcRenderer.invoke('node:sync-request'),
  move: (nodeId, x, y) => ipcRenderer.invoke('node:move', nodeId, x, y),
  batchMove: (moves) => ipcRenderer.invoke('node:batch-move', moves),
  rename: (nodeId, name) => ipcRenderer.invoke('node:rename', nodeId, name),
  setColor: (nodeId, colorPresetId) => ipcRenderer.invoke('node:set-color', nodeId, colorPresetId),
  archive: (nodeId) => ipcRenderer.invoke('node:archive', nodeId),
  unarchive: (parentNodeId, archivedNodeId) => ipcRenderer.invoke('node:unarchive', parentNodeId, archivedNodeId),
  archiveDelete: (parentNodeId, archivedNodeId) => ipcRenderer.invoke('node:archive-delete', parentNodeId, archivedNodeId),
  undoPush: (entry) => ipcRenderer.invoke('node:undo-push', entry),
  undoSetCursor: (cursor: number) => ipcRenderer.invoke('node:undo-set-cursor', cursor),
  bringToFront: (nodeId) => ipcRenderer.invoke('node:bring-to-front', nodeId),
  reparent: (nodeId, newParentId) => ipcRenderer.invoke('node:reparent', nodeId, newParentId),
  swapParentChild: (nodeId, childId) => ipcRenderer.invoke('node:swap-parent-child', nodeId, childId),
  terminalCreate: (parentId, options?, initialTitleHistory?, initialName?, x?, y?, initialInput?) => ipcRenderer.invoke('node:terminal-create', parentId, options, initialTitleHistory, initialName, x, y, initialInput),
  terminalResize: (nodeId, cols, rows) => ipcRenderer.invoke('node:terminal-resize', nodeId, cols, rows),
  terminalReincarnate: (nodeId, options?) => ipcRenderer.invoke('node:terminal-reincarnate', nodeId, options),
  forkSession: (nodeId) => ipcRenderer.invoke('node:fork-session', nodeId),
  terminalRestart: (nodeId: NodeId, extraCliArgs: string) => ipcRenderer.invoke('node:terminal-restart', nodeId, extraCliArgs),
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
  setClaudeStatusUnread: (sessionId: PtySessionId, unread: boolean) => ipcRenderer.send('node:set-claude-status-unread', sessionId, unread),
  setClaudeStatusAsleep: (sessionId: PtySessionId, asleep: boolean) => ipcRenderer.send('node:set-claude-status-asleep', sessionId, asleep),
  setAlertsReadTimestamp: (nodeId: NodeId, timestamp: number) => ipcRenderer.send('node:set-alerts-read-timestamp', nodeId, timestamp),
  sendCameraBounds: (bounds: { x: number; y: number; width: number; height: number }) => ipcRenderer.send('node:camera-bounds', bounds),
  saveViewport: (slot: string, bounds: { x: number; y: number; width: number; height: number }) => ipcRenderer.send('node:save-viewport', slot, bounds),
  onSnapshot: (sessionId, callback) => {
    const channel = `snapshot:${sessionId}`
    const listener = (_event: Electron.IpcRendererEvent, snapshot: any) => callback(snapshot)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  },
  onUpdated: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, nodeId: NodeId, fields: any) => callback(nodeId, fields)
    ipcRenderer.on('node:updated', listener)
    return () => ipcRenderer.removeListener('node:updated', listener)
  },
  onAdded: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, node: any) => callback(node)
    ipcRenderer.on('node:added', listener)
    return () => ipcRenderer.removeListener('node:added', listener)
  },
  onRemoved: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, nodeId: NodeId) => callback(nodeId)
    ipcRenderer.on('node:removed', listener)
    return () => ipcRenderer.removeListener('node:removed', listener)
  },
  onFileContent: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, nodeId: NodeId, content: string) => callback(nodeId, content)
    ipcRenderer.on('node:file-content', listener)
    return () => ipcRenderer.removeListener('node:file-content', listener)
  },
  onServerError: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, message: string) => callback(message)
    ipcRenderer.on('server:error', listener)
    return () => ipcRenderer.removeListener('server:error', listener)
  },
  onGhRateLimit: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, data: any, usedHistory: (number | null)[], slotMinutes: number) => callback(data, usedHistory, slotMinutes)
    ipcRenderer.on('gh-rate-limit', listener)
    return () => ipcRenderer.removeListener('gh-rate-limit', listener)
  },
  onPlaySound: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, sound: string) => callback(sound)
    ipcRenderer.on('play-sound', listener)
    return () => ipcRenderer.removeListener('play-sound', listener)
  },
  onSpeak: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, text: string) => callback(text)
    ipcRenderer.on('speak', listener)
    return () => ipcRenderer.removeListener('speak', listener)
  },
  onSpeakingChanged: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, nodeId: NodeId, speaking: boolean, voice: string | undefined) => callback(nodeId, speaking, voice)
    ipcRenderer.on('speaking-changed', listener)
    return () => ipcRenderer.removeListener('speaking-changed', listener)
  },
  onSummaryChatStatus: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, nodeId: NodeId, state: 'thinking' | 'ready' | 'target' | 'error', message?: string) => callback(nodeId, state, message)
    ipcRenderer.on('summary-chat-status', listener)
    return () => ipcRenderer.removeListener('summary-chat-status', listener)
  },
  onPeerConnected: (callback: (clientId: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, clientId: string) => callback(clientId)
    ipcRenderer.on('peer:connected', listener)
    return () => ipcRenderer.removeListener('peer:connected', listener)
  },
  onPeerDisconnected: (callback: (clientId: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, clientId: string) => callback(clientId)
    ipcRenderer.on('peer:disconnected', listener)
    return () => ipcRenderer.removeListener('peer:disconnected', listener)
  },
  onPeerCameraBounds: (callback: (clientId: string, bounds: { x: number; y: number; width: number; height: number }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, clientId: string, bounds: { x: number; y: number; width: number; height: number }) => callback(clientId, bounds)
    ipcRenderer.on('peer:camera-bounds', listener)
    return () => ipcRenderer.removeListener('peer:camera-bounds', listener)
  },
  onSavedViewports: (callback: (viewports: Record<string, { x: number; y: number; width: number; height: number }>) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, viewports: Record<string, { x: number; y: number; width: number; height: number }>) => callback(viewports)
    ipcRenderer.on('viewports:saved', listener)
    return () => ipcRenderer.removeListener('viewports:saved', listener)
  }
}

// Annotated rather than passed inline so the object literal is checked against
// the contract: a missing member and an unknown member are both compile errors.
const api: Api = {
  pty: ptyApi,
  node: nodeApi,
  log: (message: string) => ipcRenderer.send('log', message),
  startSummaryChat: (nodeId: NodeId) => ipcRenderer.send('summary-chat:start', nodeId),
  restartSpaceterm: (): Promise<void> => ipcRenderer.invoke('app:restart-spaceterm'),
  writeDebugLog: (content: string): Promise<string> => ipcRenderer.invoke('debug:write-log', content),
  openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url),
  diffFiles: (fileA: string, fileB: string) => ipcRenderer.invoke('shell:diffFiles', fileA, fileB),
  window: {
    isFullScreen: (): Promise<boolean> => ipcRenderer.invoke('window:is-fullscreen'),
    setFullScreen: (enabled: boolean) => ipcRenderer.invoke('window:set-fullscreen', enabled),
    onVisibilityChanged: (callback: (visible: boolean) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, visible: boolean) => callback(visible)
      ipcRenderer.on('window:visibility-changed', listener)
      return () => ipcRenderer.removeListener('window:visibility-changed', listener)
    },
    onFocusNode: (callback: (nodeId: NodeId) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, nodeId: NodeId) => callback(nodeId)
      ipcRenderer.on('window:focus-node', listener)
      return () => ipcRenderer.removeListener('window:focus-node', listener)
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
}

contextBridge.exposeInMainWorld('api', api)
