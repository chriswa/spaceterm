import { app, BrowserWindow, clipboard, contentTracing, ipcMain, net, protocol, screen, shell } from 'electron'
import * as path from 'path'
import { pathToFileURL } from 'url'
import { mkdirSync, writeFileSync } from 'fs'
import { execFile } from 'child_process'
import { join } from 'path'
import { SOCKET_DIR } from '../../shared/protocol'
import { ServerClient } from './server-client'
import * as logger from './logger'
import { setupTTSHandlers } from './tts'
import { loadWindowState, saveWindowState, findTargetDisplay } from './window-state'
import { startSystemMetrics, stopSystemMetrics } from './system-metrics'
import { loadLaunchPrefs, saveLaunchPrefs } from './launch-prefs'
import type { LaunchPrefs } from '../../shared/launch-prefs'
import type { NodeId, PtySessionId } from '../../shared/ids'
import { parseFocusUrl, FOCUS_URL_SCHEME } from './focus-url'

/**
 * What this process launched with.
 *
 * Read at module scope because Chromium parses its command line before
 * `whenReady()`, so the switches below have to be decided here — and because
 * an IPC handler further down reports it, which means it must be initialised
 * before any of them can run.
 */
const launchPrefs = loadLaunchPrefs()

let mainWindow: BrowserWindow | null = null
let client: ServerClient | null = null
// Matched by client:dev's supervisor. A normal quit remains exit code 0 so
// Ctrl+C returns control to the terminal instead of relaunching Electron.
const CLIENT_RESTART_EXIT_CODE = 75

// Id from a `spaceterm-surface://` link that arrived before the server
// connection was ready (cold launch). Flushed once the client connects. Opaque:
// the server decides whether it names a surface or an agent session.
let pendingFocusId: string | null = null
// Node id to focus once the renderer has finished loading (cold launch).
let pendingFocusNodeId: string | null = null

function requestFocus(id: string): void {
  if (client?.isConnected()) {
    client.requestFocusById(id)
  } else {
    pendingFocusId = id
  }
}

// Bring this window to the foreground and tell the renderer to focus the node.
// The server has already decided this client should be the one to raise.
function raiseAndFocusNode(nodeId: NodeId): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
  if (process.platform === 'darwin') app.focus({ steal: true })

  const wc = mainWindow.webContents
  if (wc.isLoadingMainFrame()) {
    pendingFocusNodeId = nodeId
    wc.once('did-finish-load', () => {
      if (pendingFocusNodeId && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('window:focus-node', pendingFocusNodeId)
        pendingFocusNodeId = null
      }
    })
  } else {
    wc.send('window:focus-node', nodeId)
  }
}

// Register the OS-level URL scheme. Registered at module load (before app ready)
// so a cold-launch `open-url` is captured.
app.setAsDefaultProtocolClient(FOCUS_URL_SCHEME)
app.on('open-url', (event, url) => {
  event.preventDefault()
  const id = parseFocusUrl(url)
  if (id) {
    logger.log(`Deep link focus request: id=${id}`)
    requestFocus(id)
  }
})

// Fill the display's work area — the screen minus the menu bar and dock — instead of
// using native fullscreen. Combined with a frameless window this gives chrome-free
// terminal space while leaving the menu bar (and its status items) permanently visible;
// native fullscreen hides the menu bar unless the OS is configured otherwise, and that
// setting varies per machine.
function fitToWorkArea(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.isFullScreen()) return
  const bounds = mainWindow.getBounds()
  const display = screen.getDisplayNearestPoint({
    x: bounds.x + Math.floor(bounds.width / 2),
    y: bounds.y + Math.floor(bounds.height / 2)
  })
  mainWindow.setBounds(display.workArea)
}

function createWindow(): void {
  // Determine which display to open on based on saved state
  const saved = loadWindowState()
  const targetDisplay = saved ? findTargetDisplay(saved.displayBounds) : screen.getPrimaryDisplay()
  const { x, y, width, height } = targetDisplay.workArea

  mainWindow = new BrowserWindow({
    x,
    y,
    width,
    height,
    show: false,
    frame: false,
    // macOS rounds the corners of frameless windows by default, which clips the grid
    // against the screen edges it is meant to fill flush.
    roundedCorners: false,
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

  mainWindow.show()

  // The work area moves under us when the dock resizes or the display mode changes,
  // and native fullscreen restores pre-fullscreen bounds on exit rather than refitting.
  const onDisplayMetricsChanged = () => fitToWorkArea()
  screen.on('display-metrics-changed', onDisplayMetricsChanged)
  mainWindow.on('leave-full-screen', fitToWorkArea)

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
    screen.removeListener('display-metrics-changed', onDisplayMetricsChanged)
    mainWindow = null
  })
}

/**
 * Report window state the renderer's render loops throttle themselves against.
 *
 * Two separate signals, which the renderer uses for two different decisions:
 *
 * - **Visibility** — hidden and minimised. Whether to draw *at all*. Window
 *   state only: occlusion, where the window is covered by another or sits on a
 *   Space that is not on screen, is not reported here because `BrowserWindow`
 *   emits no event for it; the renderer reads it from
 *   `document.visibilityState`, which is Chromium's own belief and covers it.
 *   See `useWindowVisible`, which ANDs the two.
 * - **Focus** — how *fast* to draw. Not a visibility input, and must never be
 *   treated as one: an unfocused window on a second display is fully on screen
 *   and is often the one being watched. See `frame-policy`.
 */
function setupVisibilityTracking(): void {
  if (!mainWindow) return

  let isHidden = false
  let isMinimized = false
  let wasVisible = true

  const update = () => {
    const visible = !isHidden && !isMinimized
    if (visible === wasVisible) return
    wasVisible = visible
    const reason = isHidden ? 'hidden' : isMinimized ? 'minimized' : 'restored'
    logger.log(`[visibility] visible=${visible} (${reason})`)

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('window:visibility-changed', visible)
    }
  }

  mainWindow.on('hide', () => { isHidden = true; update() })
  mainWindow.on('show', () => { isHidden = false; update() })
  mainWindow.on('minimize', () => { isMinimized = true; update() })
  mainWindow.on('restore', () => { isMinimized = false; update() })

  const sendFocus = (focused: boolean) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('window:focus-changed', focused)
    }
  }
  mainWindow.on('focus', () => sendFocus(true))
  mainWindow.on('blur', () => sendFocus(false))
  // The renderer assumes focused until told otherwise, and `blur` does not fire
  // for a window that was never focused — so a window that opens in the
  // background, or a reload while the app is not frontmost, would sit at full
  // rate forever. Sent on load rather than now because a send before the page
  // exists goes nowhere.
  mainWindow.webContents.on('did-finish-load', () => {
    if (mainWindow && !mainWindow.isDestroyed()) sendFocus(mainWindow.isFocused())
  })
}

function setupIPC(): void {
  ipcMain.handle('pty:create', async (_event, options?: Record<string, unknown>) => {
    const session = await client!.create(options as any)
    // Auto-attach so we receive data events for this session. The `attached`
    // message carries only scrollback + claude context/line count (see
    // AttachedMessage in shared/protocol); shellTitleHistory, cwd and
    // claudeSessionHistory reach the renderer via node-updated broadcasts, so
    // there is nothing here to forward.
    await client!.attach(session.sessionId)
    return session
  })

  ipcMain.handle('pty:list', async () => {
    return client!.list()
  })

  ipcMain.handle('pty:attach', async (_event, sessionId: PtySessionId) => {
    const { scrollback, claudeContextPercent, claudeSessionLineCount } = await client!.attach(sessionId)
    return { scrollback, claudeContextPercent, claudeSessionLineCount }
  })

  ipcMain.on('pty:write', (_event, sessionId: PtySessionId, data: string) => {
    client!.write(sessionId, data)
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

  ipcMain.handle('debug:write-log', (_event, content: string) => {
    const filename = `inertia-debug-${Date.now()}.log`
    const filepath = join(SOCKET_DIR, filename)
    writeFileSync(filepath, content)
    clipboard.writeText(filepath)
    return filepath
  })

  ipcMain.handle('pty:destroy', async (_event, sessionId: PtySessionId) => {
    await client!.destroy(sessionId)
  })

  ipcMain.handle('server:status', () => {
    return client!.isConnected()
  })

  ipcMain.handle('app:restart-spaceterm', async () => {
    logger.log('[restart] Restart Spaceterm requested')
    await client!.restartServer()
    // app.relaunch() detaches a bare Electron process from electron-vite. Exit
    // with the supervisor's explicit restart code instead, so client:dev starts
    // a complete new Electron/Vite process in the same terminal tab.
    logger.log('[restart] Server accepted restart; exiting for supervised client restart')
    setTimeout(() => app.exit(CLIENT_RESTART_EXIT_CODE), 50)
  })

  ipcMain.handle('summary-chat:toggle', async (_event, nodeId: NodeId | undefined) => {
    logger.log(`[summary-chat] chord pressed, focused node=${nodeId ? nodeId.slice(0, 8) : 'none'}`)
    const result = await client!.toggleSummaryChat(nodeId)
    logger.log(`[summary-chat] chord ${result.outcome}${result.message ? `: ${result.message}` : ''}`)
    return result
  })

  // --- Node state mutations ---

  ipcMain.handle('node:sync-request', async () => {
    const resp = await client!.nodeSyncRequest()
    if (resp.type === 'sync-state') return resp.state
    throw new Error('Unexpected response')
  })

  ipcMain.handle('node:move', async (_event, nodeId: NodeId, x: number, y: number) => {
    await client!.nodeMove(nodeId, x, y)
  })

  ipcMain.handle('node:batch-move', async (_event, moves: Array<{ nodeId: NodeId; x: number; y: number }>) => {
    await client!.nodeBatchMove(moves)
  })

  ipcMain.handle('node:rename', async (_event, nodeId: NodeId, name: string) => {
    await client!.nodeRename(nodeId, name)
  })

  ipcMain.handle('node:set-color', async (_event, nodeId: NodeId, colorPresetId: string) => {
    await client!.nodeSetColor(nodeId, colorPresetId)
  })

  ipcMain.handle('node:archive', async (_event, nodeId: NodeId) => {
    await client!.nodeArchive(nodeId)
  })

  ipcMain.handle('node:unarchive', async (_event, parentNodeId: NodeId, archivedNodeId: NodeId) => {
    await client!.nodeUnarchive(parentNodeId, archivedNodeId)
  })

  ipcMain.handle('node:archive-delete', async (_event, parentNodeId: NodeId, archivedNodeId: NodeId) => {
    await client!.nodeArchiveDelete(parentNodeId, archivedNodeId)
  })

  ipcMain.handle('node:undo-push', async (_event, entry: import('../../shared/undo-types').UndoEntry) => {
    await client!.undoPush(entry)
  })

  ipcMain.handle('node:undo-set-cursor', async (_event, cursor: number) => {
    await client!.undoSetCursor(cursor)
  })

  ipcMain.handle('node:bring-to-front', async (_event, nodeId: NodeId) => {
    await client!.nodeBringToFront(nodeId)
  })

  ipcMain.handle('node:reparent', async (_event, nodeId: NodeId, newParentId: NodeId) => {
    await client!.nodeReparent(nodeId, newParentId)
  })

  ipcMain.handle('node:swap-parent-child', async (_event, nodeId: NodeId, childId: NodeId) => {
    await client!.nodeSwapParentChild(nodeId, childId)
  })

  ipcMain.handle('node:terminal-create', async (_event, parentId: NodeId, options?: Record<string, unknown>, initialTitleHistory?: string[], initialName?: string, x?: number, y?: number, initialInput?: string) => {
    const resp = await client!.terminalCreate(parentId, options as any, initialTitleHistory, initialName, x, y, initialInput)
    if (resp.type === 'created') {
      // Auto-attach so we receive data events for this session
      await client!.attach(resp.sessionId)
      return { sessionId: resp.sessionId, cols: resp.cols, rows: resp.rows }
    }
    throw new Error('Unexpected response')
  })

  ipcMain.handle('node:terminal-resize', async (_event, nodeId: NodeId, cols: number, rows: number) => {
    await client!.terminalResize(nodeId, cols, rows)
  })

  ipcMain.handle('node:terminal-reincarnate', async (_event, nodeId: NodeId, options?: Record<string, unknown>) => {
    const resp = await client!.terminalReincarnate(nodeId, options as any)
    if (resp.type === 'created') {
      // Auto-attach so we receive data events for the new session
      await client!.attach(resp.sessionId)
      return { sessionId: resp.sessionId, cols: resp.cols, rows: resp.rows }
    }
    throw new Error('Unexpected response')
  })

  ipcMain.handle('node:directory-add', async (_event, parentId: NodeId, cwd: string, x?: number, y?: number) => {
    const resp = await client!.directoryAdd(parentId, cwd, x, y)
    if (resp.type === 'node-add-ack') return { nodeId: resp.nodeId }
    return {}
  })

  ipcMain.handle('node:directory-cwd', async (_event, nodeId: NodeId, cwd: string) => {
    await client!.directoryCwd(nodeId, cwd)
  })

  ipcMain.handle('node:directory-git-fetch', async (_event, nodeId: NodeId) => {
    await client!.directoryGitFetch(nodeId)
  })

  ipcMain.handle('node:directory-wt-spawn', async (_event, nodeId: NodeId, branchName: string) => {
    const resp = await client!.directoryWtSpawn(nodeId, branchName)
    if (resp.type === 'node-add-ack') return { nodeId: resp.nodeId }
    throw new Error('wt-spawn failed')
  })

  ipcMain.handle('node:validate-directory', async (_event, path: string) => {
    const resp = await client!.validateDirectory(path)
    if (resp.type === 'validate-directory-result') return { valid: resp.valid, error: resp.error }
    throw new Error('Unexpected response')
  })

  ipcMain.handle('node:file-add', async (_event, parentId: NodeId, filePath: string, x?: number, y?: number) => {
    const resp = await client!.fileAdd(parentId, filePath, x, y)
    if (resp.type === 'node-add-ack') return { nodeId: resp.nodeId }
    return {}
  })

  ipcMain.handle('node:file-path', async (_event, nodeId: NodeId, filePath: string) => {
    await client!.filePath(nodeId, filePath)
  })

  ipcMain.handle('node:validate-file', async (_event, path: string, cwd?: string) => {
    const resp = await client!.validateFile(path, cwd)
    if (resp.type === 'validate-file-result') return { valid: resp.valid, error: resp.error }
    throw new Error('Unexpected response')
  })

  ipcMain.handle('node:markdown-add', async (_event, parentId: NodeId, x?: number, y?: number) => {
    const resp = await client!.markdownAdd(parentId, x, y)
    if (resp.type === 'node-add-ack') return { nodeId: resp.nodeId }
    return {}
  })

  ipcMain.handle('node:markdown-resize', async (_event, nodeId: NodeId, width: number, height: number) => {
    await client!.markdownResize(nodeId, width, height)
  })

  ipcMain.handle('node:markdown-content', async (_event, nodeId: NodeId, content: string) => {
    await client!.markdownContent(nodeId, content)
  })

  ipcMain.handle('node:markdown-set-max-width', async (_event, nodeId: NodeId, maxWidth: number) => {
    await client!.markdownSetMaxWidth(nodeId, maxWidth)
  })

  ipcMain.handle('node:title-add', async (_event, parentId: NodeId, x?: number, y?: number) => {
    const resp = await client!.titleAdd(parentId, x, y)
    if (resp.type === 'node-add-ack') return { nodeId: resp.nodeId }
    return {}
  })

  ipcMain.handle('node:title-text', async (_event, nodeId: NodeId, text: string) => {
    await client!.titleText(nodeId, text)
  })

  ipcMain.handle('node:fork-session', async (_event, nodeId: NodeId) => {
    const resp = await client!.forkSession(nodeId)
    if (resp.type === 'created') {
      await client!.attach(resp.sessionId)
      return { sessionId: resp.sessionId, cols: resp.cols, rows: resp.rows }
    }
    throw new Error('Unexpected response')
  })

  ipcMain.handle('node:terminal-restart', async (_event, nodeId: NodeId, extraCliArgs: string) => {
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

  ipcMain.on('node:set-terminal-mode', (_event, sessionId: PtySessionId, mode: 'live' | 'snapshot') => {
    client!.setTerminalMode(sessionId, mode)
  })

  ipcMain.on('node:set-claude-status-unread', (_event, sessionId: PtySessionId, unread: boolean) => {
    client!.setClaudeStatusUnread(sessionId, unread)
  })

  ipcMain.on('node:set-claude-status-asleep', (_event, sessionId: PtySessionId, asleep: boolean) => {
    client!.setClaudeStatusAsleep(sessionId, asleep)
  })

  ipcMain.on('node:set-alerts-read-timestamp', (_event, nodeId: NodeId, timestamp: number) => {
    client!.setAlertsReadTimestamp(nodeId, timestamp)
  })

  ipcMain.on('node:camera-bounds', (_event, bounds: { x: number; y: number; width: number; height: number }) => {
    client!.sendCameraBounds(bounds)
  })

  ipcMain.on('node:save-viewport', (_event, slot: string, bounds: { x: number; y: number; width: number; height: number }) => {
    client!.saveViewport(slot, bounds)
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

  // --- Mod envelopes (renderer → server) ---

  ipcMain.on('mod:send', (_event, modId: string, event: string, payload: unknown) => {
    client?.sendMod(modId, event, payload)
  })

  // --- Launch preferences ---

  // Reports the *stored* prefs, which is what the next launch will use. When
  // the two differ the UI has an unapplied change to tell the user about.
  ipcMain.handle('system:get-launch-prefs', () => loadLaunchPrefs())

  ipcMain.handle('system:set-launch-prefs', (_event, patch: Partial<LaunchPrefs>) => {
    const next = saveLaunchPrefs(patch)
    logger.log('[launch-prefs] saved: ' + JSON.stringify(next))
    return next
  })

  /** What the running process actually launched with, for comparison. */
  ipcMain.handle('system:active-launch-prefs', () => launchPrefs)

  // --- System metrics (power monitor) ---

  ipcMain.on('system:set-metrics-enabled', (_event, enabled: boolean) => {
    if (!enabled) {
      stopSystemMetrics()
      return
    }
    startSystemMetrics((sample) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('system:metrics', sample)
      } else {
        // Nothing left to report to; do not keep spawning `ioreg`.
        stopSystemMetrics()
      }
    })
  })

}

/**
 * The renderer is showing state it built without a live server, so the next
 * successful connect must rebuild it.
 *
 * Set on a disconnect (the reconnect missed broadcasts and invalidated every
 * terminal attachment) and on a startup that opened the window before the
 * server was up. Module-scoped rather than local to `wireClientEvents` because
 * startup arms it too.
 */
let needsRendererResync = false

function markRendererResyncNeeded(): void {
  needsRendererResync = true
}

function wireClientEvents(): void {
  client!.on('focus-surface', (nodeId: NodeId) => {
    raiseAndFocusNode(nodeId)
  })

  client!.on('data', (sessionId: PtySessionId, data: string) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(`pty:data:${sessionId}`, data)
    }
  })

  client!.on('exit', (sessionId: PtySessionId, exitCode: number) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(`pty:exit:${sessionId}`, exitCode)
    }
  })

  client!.on('claude-context', (sessionId: PtySessionId, contextRemainingPercent: number) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(`pty:claude-context:${sessionId}`, contextRemainingPercent)
    }
  })

  client!.on('claude-session-line-count', (sessionId: PtySessionId, lineCount: number) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(`pty:claude-session-line-count:${sessionId}`, lineCount)
    }
  })

  // Mod envelopes, relayed straight through. This process reads `modId` only
  // to put it back on the wire — see ModMessage in shared/protocol.
  client!.on('mod', (modId: string, event: string, payload: unknown) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('mod:message', modId, event, payload)
    }
  })

  client!.on('file-content', (nodeId: NodeId, content: string) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('node:file-content', nodeId, content)
    }
  })

  client!.on('node-updated', (nodeId: NodeId, fields: Record<string, unknown>) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('node:updated', nodeId, fields)
    }
  })

  client!.on('node-added', (node: Record<string, unknown>) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('node:added', node)
    }
  })

  client!.on('node-removed', (nodeId: NodeId) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('node:removed', nodeId)
    }
  })

  client!.on('snapshot', (sessionId: PtySessionId, snapshot: Record<string, unknown>) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(`snapshot:${sessionId}`, snapshot)
    }
  })

  client!.on('plan-cache-update', (sessionId: PtySessionId, count: number, files: string[]) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(`pty:plan-cache-update:${sessionId}`, count, files)
    }
  })

  client!.on('server-error', (message: string) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('server:error', message)
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

  client!.on('speaking-changed', (nodeId: NodeId, speaking: boolean, voice: string | undefined) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('speaking-changed', nodeId, speaking, voice)
    }
  })

  client!.on('summary-chat-status', (nodeId: NodeId, state: string, message: string | undefined) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('summary-chat-status', nodeId, state, message)
    }
  })

  client!.on('peer-connected', (clientId: string) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('peer:connected', clientId)
    }
  })

  client!.on('peer-disconnected', (clientId: string) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('peer:disconnected', clientId)
    }
  })

  client!.on('peer-camera-bounds', (clientId: string, bounds: { x: number; y: number; width: number; height: number }) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('peer:camera-bounds', clientId, bounds)
    }
  })

  client!.on('saved-viewports', (viewports: Record<string, { x: number; y: number; width: number; height: number }>) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('viewports:saved', viewports)
    }
  })

  client!.on('connect', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (needsRendererResync) {
        needsRendererResync = false
        logger.log('Server reconnected; reloading renderer for authoritative resync')
        mainWindow.webContents.reload()
        return
      }
      mainWindow.webContents.send('server:status', true)
    }
  })

  client!.on('disconnect', () => {
    needsRendererResync = true
    logger.log('Lost connection to the spaceterm server; reconnecting')
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('server:status', false)
    }
  })
}

app.setName('Spaceterm')

// Strategy 6: Chromium GPU flags to increase tile memory headroom
app.commandLine.appendSwitch('force-gpu-mem-available-mb', '4096')
app.commandLine.appendSwitch('enable-gpu-rasterization')
app.commandLine.appendSwitch('enable-zero-copy')
app.commandLine.appendSwitch('ignore-gpu-blocklist')

if (launchPrefs.highPerformanceGpu) {
  // Dual-GPU Macs only. Faster and hungrier — which of the two is better for
  // battery depends on the machine, hence the toggle rather than a decision.
  app.commandLine.appendSwitch('force_high_performance_gpu')
}

/**
 * How long startup waits for the server before opening the window anyway.
 *
 * Long enough that the ordinary case — server already up, or coming up
 * alongside us — never sees a resync reload, short enough that a broken server
 * does not look like a hung app.
 */
const STARTUP_CONNECT_GRACE_MS = 8_000

/**
 * Resolve true once connected, or false once `graceMs` has passed.
 *
 * `ServerClient.connect()` never rejects — it retries with backoff forever —
 * so a race against a timer is the only way to ask "is it up *yet*". The
 * connection attempt continues either way; this only decides whether to keep
 * waiting before showing a window.
 */
function connectWithinGrace(serverClient: ServerClient, graceMs: number): Promise<boolean> {
  return Promise.race([
    serverClient.connect().then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), graceMs))
  ])
}

app.whenReady().then(async () => {
  logger.init()
  logger.log('Electron app starting')

  // Which GPU Chromium actually chose. On a dual-GPU MacBook this is the
  // difference between a canvas theme costing a couple of watts and costing
  // fifteen, and it is not observable from the renderer.
  try {
    const gpuInfo = await app.getGPUInfo('basic')
    logger.log('[gpu] active GPU: ' + JSON.stringify(gpuInfo))
  } catch (err: unknown) {
    logger.log('[gpu] failed to read GPU info: ' + (err instanceof Error ? err.message : String(err)))
  }

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

  // Wait for the server, but not forever.
  //
  // This used to be a bare `await client.connect()`, and `connect()` retries
  // indefinitely rather than rejecting — so a server that could not start meant
  // no window at all, permanently, with no error. A first-run user saw a dock
  // icon and nothing else. Showing an empty canvas is worse than a working one
  // and far better than showing nothing.
  const connected = await connectWithinGrace(client, STARTUP_CONNECT_GRACE_MS)
  if (connected) {
    logger.log('Server connection established')
  } else {
    // The window is about to be created against no server, so the renderer's
    // initial sync will come back empty. Arm the resync that the reconnect
    // path already implements, so the first successful connect rebuilds it.
    markRendererResyncNeeded()
    logger.log(
      `Server not up after ${STARTUP_CONNECT_GRACE_MS}ms; opening the window anyway and retrying in the background`
    )
  }

  // Flush a deep-link focus request that arrived before the server connection.
  if (connected && pendingFocusId) {
    client.requestFocusById(pendingFocusId)
    pendingFocusId = null
  }

  createWindow()

  // Bypass the Cmd+W (Close Window) menu accelerator so it reaches the renderer.
  // setIgnoreMenuShortcuts in before-input-event selectively disables menu shortcuts
  // for individual keystrokes without modifying the menu itself.
  //
  // The Summary Chat chord (Cmd+Ctrl+X) needs no entry here: Cut is bound to a
  // bare Cmd+X, and an accelerator only fires on an exact modifier match.
  mainWindow!.webContents.on('before-input-event', (_event, input) => {
    mainWindow!.webContents.setIgnoreMenuShortcuts(
      input.meta && input.key.toLowerCase() === 'w'
    )
  })

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
