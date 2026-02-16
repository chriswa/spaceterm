import { app, BrowserWindow, clipboard, contentTracing, ipcMain, shell } from 'electron'
import { mkdirSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { ServerClient } from './server-client'
import * as logger from './logger'
import { setupTTSHandlers } from './tts'
import { setupAudio } from './audio'

let mainWindow: BrowserWindow | null = null
let client: ServerClient | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false
    }
  })

  // Load the renderer
  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

function setupIPC(): void {
  ipcMain.handle('pty:create', async (_event, options?: Record<string, unknown>) => {
    const session = await client!.create(options as any)
    // Auto-attach so we receive data events for this session
    const { shellTitleHistory, cwd, claudeSessionHistory } = await client!.attach(session.sessionId)
    return { ...session, shellTitleHistory, cwd, claudeSessionHistory }
  })

  ipcMain.handle('pty:list', async () => {
    return client!.list()
  })

  ipcMain.handle('pty:attach', async (_event, sessionId: string) => {
    const { scrollback, shellTitleHistory, cwd, claudeSessionHistory, claudeState, claudeContextPercent } = await client!.attach(sessionId)
    return { scrollback, shellTitleHistory, cwd, claudeSessionHistory, claudeState, claudeContextPercent }
  })

  ipcMain.on('pty:write', (_event, sessionId: string, data: string) => {
    client!.write(sessionId, data)
  })

  ipcMain.on('pty:resize', (_event, sessionId: string, cols: number, rows: number) => {
    client!.resize(sessionId, cols, rows)
  })

  ipcMain.on('log', (_event, message: string) => {
    logger.log(message)
  })

  ipcMain.handle('shell:openExternal', (_event, url: string) => {
    if (url.startsWith('http://') || url.startsWith('https://') || url.startsWith('file://')) {
      shell.openExternal(url)
    }
  })

  ipcMain.handle('pty:destroy', async (_event, sessionId: string) => {
    await client!.destroy(sessionId)
  })

  ipcMain.handle('server:status', () => {
    return client!.isConnected()
  })

  // --- Node state mutations ---

  ipcMain.handle('node:sync-request', async () => {
    const resp = await client!.nodeSyncRequest()
    if (resp.type === 'sync-state') return resp.state
    throw new Error('Unexpected response')
  })

  ipcMain.handle('node:move', async (_event, nodeId: string, x: number, y: number) => {
    await client!.nodeMove(nodeId, x, y)
  })

  ipcMain.handle('node:batch-move', async (_event, moves: Array<{ nodeId: string; x: number; y: number }>) => {
    await client!.nodeBatchMove(moves)
  })

  ipcMain.handle('node:rename', async (_event, nodeId: string, name: string) => {
    await client!.nodeRename(nodeId, name)
  })

  ipcMain.handle('node:set-color', async (_event, nodeId: string, colorPresetId: string) => {
    await client!.nodeSetColor(nodeId, colorPresetId)
  })

  ipcMain.handle('node:archive', async (_event, nodeId: string) => {
    await client!.nodeArchive(nodeId)
  })

  ipcMain.handle('node:unarchive', async (_event, parentNodeId: string, archivedNodeId: string) => {
    await client!.nodeUnarchive(parentNodeId, archivedNodeId)
  })

  ipcMain.handle('node:archive-delete', async (_event, parentNodeId: string, archivedNodeId: string) => {
    await client!.nodeArchiveDelete(parentNodeId, archivedNodeId)
  })

  ipcMain.handle('node:bring-to-front', async (_event, nodeId: string) => {
    await client!.nodeBringToFront(nodeId)
  })

  ipcMain.handle('node:reparent', async (_event, nodeId: string, newParentId: string) => {
    await client!.nodeReparent(nodeId, newParentId)
  })

  ipcMain.handle('node:terminal-create', async (_event, parentId: string, x: number, y: number, options?: Record<string, unknown>, initialTitleHistory?: string[]) => {
    const resp = await client!.terminalCreate(parentId, x, y, options as any, initialTitleHistory)
    if (resp.type === 'created') {
      // Auto-attach so we receive data events for this session
      await client!.attach(resp.sessionId)
      return { sessionId: resp.sessionId, cols: resp.cols, rows: resp.rows }
    }
    throw new Error('Unexpected response')
  })

  ipcMain.handle('node:terminal-resize', async (_event, nodeId: string, cols: number, rows: number) => {
    await client!.terminalResize(nodeId, cols, rows)
  })

  ipcMain.handle('node:terminal-reincarnate', async (_event, nodeId: string, options?: Record<string, unknown>) => {
    const resp = await client!.terminalReincarnate(nodeId, options as any)
    if (resp.type === 'created') {
      // Auto-attach so we receive data events for the new session
      await client!.attach(resp.sessionId)
      return { sessionId: resp.sessionId, cols: resp.cols, rows: resp.rows }
    }
    throw new Error('Unexpected response')
  })

  ipcMain.handle('node:directory-add', async (_event, parentId: string, x: number, y: number, cwd: string) => {
    const resp = await client!.directoryAdd(parentId, x, y, cwd)
    if (resp.type === 'node-add-ack') return { nodeId: resp.nodeId }
    return {}
  })

  ipcMain.handle('node:directory-cwd', async (_event, nodeId: string, cwd: string) => {
    await client!.directoryCwd(nodeId, cwd)
  })

  ipcMain.handle('node:validate-directory', async (_event, path: string) => {
    const resp = await client!.validateDirectory(path)
    if (resp.type === 'validate-directory-result') return { valid: resp.valid, error: resp.error }
    throw new Error('Unexpected response')
  })

  ipcMain.handle('node:markdown-add', async (_event, parentId: string, x: number, y: number) => {
    const resp = await client!.markdownAdd(parentId, x, y)
    if (resp.type === 'node-add-ack') return { nodeId: resp.nodeId }
    return {}
  })

  ipcMain.handle('node:markdown-resize', async (_event, nodeId: string, width: number, height: number) => {
    await client!.markdownResize(nodeId, width, height)
  })

  ipcMain.handle('node:markdown-content', async (_event, nodeId: string, content: string) => {
    await client!.markdownContent(nodeId, content)
  })

  ipcMain.on('node:set-terminal-mode', (_event, sessionId: string, mode: 'live' | 'snapshot') => {
    client!.setTerminalMode(sessionId, mode)
  })

  // --- Perf capture ---

  const perfDir = join(homedir(), '.spaceterm', 'perf-captures')

  ipcMain.handle('perf:trace-start', async () => {
    await contentTracing.startRecording({
      included_categories: ['devtools.timeline', 'v8.execute', 'blink.user_timing', 'gpu', 'cc', 'viz']
    })
    logger.log('Content tracing started')
  })

  ipcMain.handle('perf:trace-stop', async () => {
    const resultPath = await contentTracing.stopRecording()
    mkdirSync(perfDir, { recursive: true })
    const ts = new Date().toISOString().replace(/[:.]/g, '-')
    const dest = join(perfDir, `trace-${ts}.json`)
    // contentTracing writes to a temp file; copy to our directory
    const { copyFileSync } = await import('fs')
    copyFileSync(resultPath, dest)
    clipboard.writeText(dest)
    logger.log(`Content trace saved: ${dest}`)
    return dest
  })

}

function wireClientEvents(): void {
  client!.on('data', (sessionId: string, data: string) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(`pty:data:${sessionId}`, data)
    }
  })

  client!.on('exit', (sessionId: string, exitCode: number) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(`pty:exit:${sessionId}`, exitCode)
    }
  })

  client!.on('shell-title-history', (sessionId: string, history: string[]) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(`pty:shell-title-history:${sessionId}`, history)
    }
  })

  client!.on('cwd', (sessionId: string, cwd: string) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(`pty:cwd:${sessionId}`, cwd)
    }
  })

  client!.on('claude-session-history', (sessionId: string, history: unknown[]) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(`pty:claude-session-history:${sessionId}`, history)
    }
  })

  client!.on('claude-state', (sessionId: string, state: string) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(`pty:claude-state:${sessionId}`, state)
    }
  })

  client!.on('claude-context', (sessionId: string, contextRemainingPercent: number) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(`pty:claude-context:${sessionId}`, contextRemainingPercent)
    }
  })

  client!.on('node-updated', (nodeId: string, fields: Record<string, unknown>) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('node:updated', nodeId, fields)
    }
  })

  client!.on('node-added', (node: Record<string, unknown>) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('node:added', node)
    }
  })

  client!.on('node-removed', (nodeId: string) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('node:removed', nodeId)
    }
  })

  client!.on('snapshot', (sessionId: string, snapshot: Record<string, unknown>) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(`snapshot:${sessionId}`, snapshot)
    }
  })

  client!.on('server-error', (message: string) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('server:error', message)
    }
  })

  client!.on('connect', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('server:status', true)
    }
  })

  client!.on('disconnect', () => {
    console.error('Lost connection to the spaceterm server. Exiting.')
    client!.disconnect() // stop auto-reconnect
    app.quit()
  })
}

app.setName('Spaceterm')

// Strategy 6: Chromium GPU flags to increase tile memory headroom
app.commandLine.appendSwitch('force-gpu-mem-available-mb', '4096')
app.commandLine.appendSwitch('enable-gpu-rasterization')
app.commandLine.appendSwitch('enable-zero-copy')
app.commandLine.appendSwitch('ignore-gpu-blocklist')

app.whenReady().then(async () => {
  logger.init()
  logger.log('Electron app starting')

  client = new ServerClient()
  setupIPC()
  setupTTSHandlers()
  wireClientEvents()

  try {
    await client.connect()
    logger.log('Server connection established')
  } catch {
    console.error('Failed to connect to terminal server. Is it running? (npm run server)')
    app.quit()
    return
  }

  createWindow()
  mainWindow!.setFullScreen(true)
  setupAudio(mainWindow!)
  logger.log('Window created')
})

app.on('window-all-closed', () => {
  // Don't destroy sessions — they persist on the server
  client?.disconnect()
  app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})
