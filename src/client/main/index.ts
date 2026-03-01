import { app, BrowserWindow, clipboard, contentTracing, ipcMain, net, protocol, screen, shell } from 'electron'
import * as path from 'path'
import { pathToFileURL } from 'url'
import { mkdirSync } from 'fs'
import { execFile } from 'child_process'
import { join } from 'path'
import { SOCKET_DIR } from '../../shared/protocol'
import { ServerClient } from './server-client'
import * as logger from './logger'
import { setupTTSHandlers } from './tts'
import { setupAudio } from './audio'
import * as audioTap from './audio/audio-tap'
import { loadWindowState, saveWindowState, findTargetDisplay } from './window-state'

let mainWindow: BrowserWindow | null = null
let client: ServerClient | null = null

function createWindow(): void {
  // Determine which display to open on based on saved state
  const saved = loadWindowState()
  const targetDisplay = saved ? findTargetDisplay(saved.displayBounds) : screen.getPrimaryDisplay()
  const { x, y, width, height } = targetDisplay.bounds

  mainWindow = new BrowserWindow({
    x,
    y,
    width,
    height,
    show: false,
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

  mainWindow.setFullScreen(true)
  mainWindow.show()

  // Save display on move (debounced) — handles user dragging to a different monitor
  let moveTimer: ReturnType<typeof setTimeout> | null = null
  mainWindow.on('move', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (moveTimer !== null) clearTimeout(moveTimer)
    moveTimer = setTimeout(() => {
      moveTimer = null
      if (!mainWindow || mainWindow.isDestroyed()) return
      const bounds = mainWindow.getBounds()
      const display = screen.getDisplayNearestPoint({ x: bounds.x, y: bounds.y })
      saveWindowState(display.bounds)
    }, 1000)
  })

  mainWindow.on('closed', () => {
    if (moveTimer !== null) clearTimeout(moveTimer)
    mainWindow = null
  })
}

function setupVisibilityTracking(): void {
  if (!mainWindow) return

  let isHidden = false
  let isMinimized = false
  let isOccluded = false
  let wasVisible = true

  const update = () => {
    const visible = !isHidden && !isMinimized && !isOccluded
    if (visible === wasVisible) return
    wasVisible = visible
    const ts = new Date().toISOString()
    const reason = isHidden ? 'hidden' : isMinimized ? 'minimized' : isOccluded ? 'occluded' : 'restored'
    console.log(`[${ts}] visibility ${visible ? 'ON' : 'OFF'} (${reason})`)
    logger.log(`[visibility] visible=${visible} (hidden=${isHidden} minimized=${isMinimized} occluded=${isOccluded})`)

    if (visible) {
      audioTap.start().catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err)
        logger.log(`[visibility] audio restart failed: ${msg}`)
      })
    } else {
      audioTap.stop().catch(() => {})
    }

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('window:visibility-changed', visible)
    }
  }

  mainWindow.on('hide', () => { isHidden = true; update() })
  mainWindow.on('show', () => { isHidden = false; update() })
  mainWindow.on('minimize', () => { isMinimized = true; update() })
  mainWindow.on('restore', () => { isMinimized = false; update() })

  // macOS: fires when window is obscured by another window or on a non-visible Space
  if (process.platform === 'darwin') {
    mainWindow.on('occluded' as any, () => { isOccluded = true; update() })
    mainWindow.on('unoccluded' as any, () => { isOccluded = false; update() })
  }
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
    const { scrollback, claudeContextPercent, claudeSessionLineCount } = await client!.attach(sessionId)
    return { scrollback, claudeContextPercent, claudeSessionLineCount }
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
    logger.log(`[openExternal] requested url=${url}`)
    if (url.startsWith('http://') || url.startsWith('https://') || url.startsWith('file://')) {
      logger.log(`[openExternal] opening url=${url}`)
      shell.openExternal(url)
    } else {
      logger.log(`[openExternal] blocked url=${url} (unsupported protocol)`)
    }
  })

  ipcMain.handle('shell:diffFiles', (_event, fileA: string, fileB: string) => {
    logger.log(`[diffFiles] cursor --diff '${fileA}' '${fileB}'`)
    execFile('cursor', ['--diff', fileA, fileB], (err) => {
      if (err) logger.log(`[diffFiles] error: ${err.message}`)
    })
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

  ipcMain.handle('node:undo-push', async (_event, entry: import('../../shared/undo-types').UndoEntry) => {
    await client!.undoPush(entry)
  })

  ipcMain.handle('node:undo-pop', async () => {
    const resp = await client!.undoPop()
    if (resp && 'entry' in resp) return (resp as any).entry
    return null
  })

  ipcMain.handle('node:bring-to-front', async (_event, nodeId: string) => {
    await client!.nodeBringToFront(nodeId)
  })

  ipcMain.handle('node:reparent', async (_event, nodeId: string, newParentId: string) => {
    await client!.nodeReparent(nodeId, newParentId)
  })

  ipcMain.handle('node:terminal-create', async (_event, parentId: string, options?: Record<string, unknown>, initialTitleHistory?: string[], initialName?: string, x?: number, y?: number, initialInput?: string) => {
    const resp = await client!.terminalCreate(parentId, options as any, initialTitleHistory, initialName, x, y, initialInput)
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

  ipcMain.handle('node:directory-add', async (_event, parentId: string, cwd: string, x?: number, y?: number) => {
    const resp = await client!.directoryAdd(parentId, cwd, x, y)
    if (resp.type === 'node-add-ack') return { nodeId: resp.nodeId }
    return {}
  })

  ipcMain.handle('node:directory-cwd', async (_event, nodeId: string, cwd: string) => {
    await client!.directoryCwd(nodeId, cwd)
  })

  ipcMain.handle('node:directory-git-fetch', async (_event, nodeId: string) => {
    await client!.directoryGitFetch(nodeId)
  })

  ipcMain.handle('node:directory-wt-spawn', async (_event, nodeId: string, branchName: string) => {
    const resp = await client!.directoryWtSpawn(nodeId, branchName)
    if (resp.type === 'node-add-ack') return { nodeId: resp.nodeId }
    throw new Error('wt-spawn failed')
  })

  ipcMain.handle('node:validate-directory', async (_event, path: string) => {
    const resp = await client!.validateDirectory(path)
    if (resp.type === 'validate-directory-result') return { valid: resp.valid, error: resp.error }
    throw new Error('Unexpected response')
  })

  ipcMain.handle('node:file-add', async (_event, parentId: string, filePath: string, x?: number, y?: number) => {
    const resp = await client!.fileAdd(parentId, filePath, x, y)
    if (resp.type === 'node-add-ack') return { nodeId: resp.nodeId }
    return {}
  })

  ipcMain.handle('node:file-path', async (_event, nodeId: string, filePath: string) => {
    await client!.filePath(nodeId, filePath)
  })

  ipcMain.handle('node:validate-file', async (_event, path: string, cwd?: string) => {
    const resp = await client!.validateFile(path, cwd)
    if (resp.type === 'validate-file-result') return { valid: resp.valid, error: resp.error }
    throw new Error('Unexpected response')
  })

  ipcMain.handle('node:markdown-add', async (_event, parentId: string, x?: number, y?: number) => {
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

  ipcMain.handle('node:markdown-set-max-width', async (_event, nodeId: string, maxWidth: number) => {
    await client!.markdownSetMaxWidth(nodeId, maxWidth)
  })

  ipcMain.handle('node:title-add', async (_event, parentId: string, x?: number, y?: number) => {
    const resp = await client!.titleAdd(parentId, x, y)
    if (resp.type === 'node-add-ack') return { nodeId: resp.nodeId }
    return {}
  })

  ipcMain.handle('node:title-text', async (_event, nodeId: string, text: string) => {
    await client!.titleText(nodeId, text)
  })

  ipcMain.handle('node:fork-session', async (_event, nodeId: string) => {
    const resp = await client!.forkSession(nodeId)
    if (resp.type === 'created') {
      await client!.attach(resp.sessionId)
      return { sessionId: resp.sessionId, cols: resp.cols, rows: resp.rows }
    }
    throw new Error('Unexpected response')
  })

  ipcMain.handle('node:terminal-restart', async (_event, nodeId: string, extraCliArgs: string) => {
    logger.log(`[terminal-restart] Restart requested for node=${nodeId.slice(0, 8)} extraCliArgs=${JSON.stringify(extraCliArgs)}`)
    try {
      const resp = await client!.terminalRestart(nodeId, extraCliArgs)
      if (resp.type === 'created') {
        await client!.attach(resp.sessionId)
        logger.log(`[terminal-restart] Success node=${nodeId.slice(0, 8)} → session=${resp.sessionId.slice(0, 8)}`)
        return { sessionId: resp.sessionId, cols: resp.cols, rows: resp.rows }
      }
      throw new Error('Unexpected response')
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.log(`[terminal-restart] Failed node=${nodeId.slice(0, 8)}: ${msg}`)
      throw err
    }
  })

  ipcMain.handle('node:crab-reorder', async (_event, order: string[]) => {
    await client!.crabReorder(order)
  })

  ipcMain.on('node:set-terminal-mode', (_event, sessionId: string, mode: 'live' | 'snapshot') => {
    client!.setTerminalMode(sessionId, mode)
  })

  ipcMain.on('node:set-claude-status-unread', (_event, sessionId: string, unread: boolean) => {
    client!.setClaudeStatusUnread(sessionId, unread)
  })

  ipcMain.on('node:set-claude-status-asleep', (_event, sessionId: string, asleep: boolean) => {
    client!.setClaudeStatusAsleep(sessionId, asleep)
  })

  ipcMain.on('node:set-alerts-read-timestamp', (_event, nodeId: string, timestamp: number) => {
    client!.setAlertsReadTimestamp(nodeId, timestamp)
  })

  // --- Window mode ---

  ipcMain.handle('window:is-fullscreen', () => {
    return mainWindow?.isFullScreen() ?? false
  })

  ipcMain.handle('window:set-fullscreen', (_event, enabled: boolean) => {
    if (!mainWindow) return
    mainWindow.setFullScreen(enabled)
  })

  // --- Perf capture ---

  const perfDir = join(SOCKET_DIR, 'perf-captures')

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

  client!.on('claude-context', (sessionId: string, contextRemainingPercent: number) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(`pty:claude-context:${sessionId}`, contextRemainingPercent)
    }
  })

  client!.on('claude-session-line-count', (sessionId: string, lineCount: number) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(`pty:claude-session-line-count:${sessionId}`, lineCount)
    }
  })

  client!.on('file-content', (nodeId: string, content: string) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('node:file-content', nodeId, content)
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

  client!.on('plan-cache-update', (sessionId: string, count: number, files: string[]) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(`pty:plan-cache-update:${sessionId}`, count, files)
    }
  })

  client!.on('server-error', (message: string) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('server:error', message)
    }
  })

  client!.on('claude-usage', (usage: Record<string, unknown>, subscriptionType: string, rateLimitTier: string, creditHistory: (number | null)[], fiveHourHistory: (number | null)[], sevenDayHistory: (number | null)[]) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('claude-usage', usage, subscriptionType, rateLimitTier, creditHistory, fiveHourHistory, sevenDayHistory)
    }
  })

  client!.on('gh-rate-limit', (data: Record<string, unknown>, usedHistory: (number | null)[]) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('gh-rate-limit', data, usedHistory)
    }
  })

  client!.on('play-sound', (sound: string) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('play-sound', sound)
    }
  })

  client!.on('speak', (text: string) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('speak', text)
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

  // Register custom protocol for loading local files in the renderer
  protocol.handle('spaceterm-file', (request) => {
    const url = new URL(request.url)
    let filePath = decodeURIComponent(url.pathname)
    if (!path.isAbsolute(filePath)) {
      filePath = path.resolve(process.cwd(), filePath)
    }
    return net.fetch(pathToFileURL(filePath).href)
  })

  client = new ServerClient()
  setupIPC()
  setupTTSHandlers()
  wireClientEvents()

  {
    const maxRetries = 3
    let connected = false
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await client.connect()
        connected = true
        logger.log('Server connection established')
        break
      } catch {
        if (attempt < maxRetries) {
          logger.log(`Server connection attempt ${attempt}/${maxRetries} failed, retrying in 1s...`)
          await new Promise((r) => setTimeout(r, 1000))
        }
      }
    }
    if (!connected) {
      logger.log('Failed to connect to terminal server after 3 attempts. Is it running? (npm run server)')
      app.quit()
      return
    }
  }

  createWindow()

  // Bypass Cmd+P (Print) and Cmd+W (Close Window) menu accelerators so they reach the renderer.
  // setIgnoreMenuShortcuts in before-input-event selectively disables menu shortcuts
  // for individual keystrokes without modifying the menu itself.
  mainWindow!.webContents.on('before-input-event', (_event, input) => {
    mainWindow!.webContents.setIgnoreMenuShortcuts(
      input.meta && (input.key.toLowerCase() === 'p' || input.key.toLowerCase() === 'w')
    )
  })

  try {
    setupAudio(mainWindow!)
    logger.log('[audio] setupAudio completed')
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.log(`[audio] setupAudio threw: ${msg}`)
  }

  setupVisibilityTracking()

  logger.log('Window created')
})

app.on('window-all-closed', () => {
  // Don't destroy sessions — they persist on the server
  client?.disconnect()
  app.quit()
})

// Save which display the window is on before quitting
app.on('before-quit', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return
  try {
    const bounds = mainWindow.getBounds()
    const display = screen.getDisplayNearestPoint({ x: bounds.x, y: bounds.y })
    saveWindowState(display.bounds)
  } catch {
    // Best-effort — don't block quit
  }
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})
