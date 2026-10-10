import { app, BrowserWindow, clipboard, contentTracing, ipcMain, net, protocol, screen, shell } from 'electron'
import * as path from 'path'
import { pathToFileURL } from 'url'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { SOCKET_DIR } from '../../shared/protocol'
import { ServerPipe } from './server-pipe'
import * as logger from './logger'
import { loadWindowState, saveWindowState, findTargetDisplay } from './window-state'
import { startSystemMetrics, stopSystemMetrics } from './system-metrics'
import { loadLaunchPrefs, saveLaunchPrefs } from './launch-prefs'
import type { LaunchPrefs } from '../../shared/launch-prefs'
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

/**
 * Run without ever putting a window on screen.
 *
 * Set by the E2E harness, which turns it on by default. The suite launches the
 * real app a dozen-odd times per run, and every launch used to raise a
 * full-screen window and steal focus — which makes the machine unusable for as
 * long as the run takes, and is why the suite was something you scheduled
 * around rather than something you ran.
 *
 * Nothing under test needs the pixels. Playwright drives the renderer over CDP,
 * which does not care whether the window is mapped, and the two GPU-dependent
 * tests reach WebGL through explicit `evaluate()` calls and context-event
 * handlers rather than through anything that has to paint. The GPU process is
 * still real, so shaders are still compiled by a real driver — the point of
 * having those tests at all.
 *
 * Deliberately opt-in at this level and defaulted-on one level up: the app
 * itself must never decide to be invisible.
 */
const headless = process.env['SPACETERM_HEADLESS'] === '1'

let mainWindow: BrowserWindow | null = null
/** The renderer's connection to the server. Opened and driven by the renderer. */
const serverPipe = new ServerPipe(() => mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null)
// Matched by client:dev's supervisor. A normal quit remains exit code 0 so
// Ctrl+C returns control to the terminal instead of relaunching Electron.
const CLIENT_RESTART_EXIT_CODE = 75

// Ids from `spaceterm-surface://` links that arrived before the renderer could
// take them (cold launch). Opaque: the server decides whether each names a
// surface or an agent session. The renderer holds its own queue until it has a
// server connection, so this one only covers the page not existing yet.
let pendingFocusIds: string[] = []

function requestFocus(id: string): void {
  const wc = mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null
  if (wc && !wc.isLoadingMainFrame()) {
    wc.send('window:focus-request', id)
  } else {
    pendingFocusIds.push(id)
  }
}

function flushPendingFocus(): void {
  const ids = pendingFocusIds
  pendingFocusIds = []
  ids.forEach(requestFocus)
}

// Bring this window to the foreground. The server has already decided this
// client should be the one to answer a focus request; the renderer handles
// what to show, and calls this for the raise.
function raiseWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  // Raising is the whole point of a deep link, and also the most disruptive
  // thing this process does — `steal: true` pulls the machine away from
  // whatever the user was doing. Skipped when headless; the renderer still
  // navigates, so the behaviour under test is unchanged.
  if (headless) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
  if (process.platform === 'darwin') app.focus({ steal: true })
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

// The display the window's centre currently sits on. Centre rather than a corner
// so a window filling one monitor is attributed to that monitor even when its
// top-left has drifted a pixel over a shared edge.
function currentDisplay(): Electron.Display | null {
  if (!mainWindow || mainWindow.isDestroyed()) return null
  const bounds = mainWindow.getBounds()
  return screen.getDisplayNearestPoint({
    x: bounds.x + Math.floor(bounds.width / 2),
    y: bounds.y + Math.floor(bounds.height / 2)
  })
}

// Fill the display's work area — the screen minus the menu bar and dock — instead of
// using native fullscreen. Combined with a frameless window this gives chrome-free
// terminal space while leaving the menu bar (and its status items) permanently visible;
// native fullscreen would hide the menu bar unless the OS is configured otherwise, and
// that setting varies per machine.
function fitToWorkArea(): void {
  const display = currentDisplay()
  if (!mainWindow || !display) return
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
      sandbox: false,
      // Chromium throttles rAF to a crawl in a window that is not on screen,
      // which for a never-shown window means the canvas render loop barely
      // runs. Only relaxed under `headless`, so the shipped app keeps
      // Chromium's power behaviour and `frame-policy` stays the one thing
      // deciding frame rate.
      ...(headless ? { backgroundThrottling: false } : {})
    }
  })

  // Load the renderer
  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  // The window is constructed with `show: false` either way; this is the line
  // that puts it on screen, and the only one.
  if (!headless) mainWindow.show()

  // The work area moves under us when the dock resizes or the display mode changes.
  const onDisplayMetricsChanged = () => fitToWorkArea()
  screen.on('display-metrics-changed', onDisplayMetricsChanged)

  // Dragging the window to another monitor doesn't resize it — the window keeps its
  // old bounds on the new display. Refit to the new display's work area so the window
  // fills whatever monitor it lands on, matching how it launches. Debounced so the
  // refit happens once the drag settles, not on every intermediate `move` event.
  let lastDisplayId = currentDisplay()?.id ?? null
  let moveTimer: ReturnType<typeof setTimeout> | null = null
  mainWindow.on('move', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (moveTimer !== null) clearTimeout(moveTimer)
    moveTimer = setTimeout(() => {
      moveTimer = null
      const display = currentDisplay()
      if (!display) return
      if (display.id !== lastDisplayId) {
        lastDisplayId = display.id
        fitToWorkArea()
      }
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
  // --- The renderer's server connection (see server-pipe.ts) ---

  ipcMain.on('server-pipe:open', (_event, attempt: string) => serverPipe.open(attempt))
  ipcMain.on('server-pipe:send', (_event, text: string) => serverPipe.send(text))
  ipcMain.on('server-pipe:close', () => serverPipe.close())

  ipcMain.on('window:raise', () => raiseWindow())

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

  ipcMain.handle('debug:write-log', (_event, content: string) => {
    const filename = `inertia-debug-${Date.now()}.log`
    const filepath = join(SOCKET_DIR, filename)
    writeFileSync(filepath, content)
    clipboard.writeText(filepath)
    return filepath
  })

  // The renderer has already had the server accept the restart.
  // app.relaunch() detaches a bare Electron process from electron-vite. Exit
  // with the supervisor's explicit restart code instead, so client:dev starts
  // a complete new Electron/Vite process in the same terminal tab.
  ipcMain.on('app:restart-client', () => {
    logger.log('[restart] Exiting for supervised client restart')
    setTimeout(() => app.exit(CLIENT_RESTART_EXIT_CODE), 50)
  })

  // --- Window mode ---

  ipcMain.handle('window:fit-to-work-area', () => {
    fitToWorkArea()
  })

  // --- Perf capture ---
  // Writes ~/.spaceterm/perf-captures/trace-*.json; analyse one with
  // `node scripts/perf/analyze-trace.mjs <trace>` (or deep-dive.mjs for GPU/compositor).

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

app.setName('Spaceterm')

// More GPU tile memory headroom for a canvas of many terminal cards. Chromium
// treats these as hints, not limits: they help, but are not reliable on their
// own, which is why offscreen terminals are also kept out of the DOM entirely.
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
 * The Chrome DevTools Protocol port, for profiling this app from outside it.
 *
 * **Always on, rather than behind a flag.** The traces worth having are the
 * ones from the session that was actually misbehaving — a window that has been
 * up for a day and a half and has drifted somewhere the numbers do not explain.
 * A port you have to switch on is a port that is off exactly then, and turning
 * it on means a restart, which destroys the state you wanted to look at.
 *
 * Chromium binds this to loopback; it is not reachable from the network. It is
 * still full control of the renderer to anything already on this machine —
 * every terminal's contents readable and arbitrary script executable — which is
 * why CLAUDE.md requires explicit operator approval before an agent attaches to
 * it. That rule is the access control here; the port itself has none.
 *
 * `SPACETERM_DEBUG_PORT` overrides it. 9222 is the protocol's default and what
 * every client tries first, so it is the right default to want — but a second
 * Chromium-based app in dev may already hold it, and losing that race is
 * silent, so the escape hatch is not hypothetical.
 */
app.commandLine.appendSwitch(
  'remote-debugging-port',
  process.env.SPACETERM_DEBUG_PORT ?? '9222'
)

app.whenReady().then(async () => {
  logger.init()
  logger.log('Electron app starting')

  if (headless) {
    logger.log('[headless] SPACETERM_HEADLESS=1 — no window will be shown')
    // The dock icon is the other half of the disruption: it appears and bounces
    // on every launch even when no window is ever mapped, and on macOS it also
    // makes the app a candidate for Cmd-Tab mid-run.
    app.dock?.hide()
  }

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

  setupIPC()

  // No wait for the server here. The renderer owns the connection, and waits
  // (briefly) for it before showing the canvas — see installApi.
  createWindow()

  // Bypass the Cmd+W (Close Window) menu accelerator so it reaches the renderer.
  // setIgnoreMenuShortcuts in before-input-event selectively disables menu shortcuts
  // for individual keystrokes without modifying the menu itself.
  mainWindow!.webContents.on('before-input-event', (_event, input) => {
    mainWindow!.webContents.setIgnoreMenuShortcuts(
      input.meta && input.key.toLowerCase() === 'w'
    )
  })

  setupVisibilityTracking()

  // Deep links that arrived during a cold launch, once there is a page to take them.
  mainWindow!.webContents.on('did-finish-load', flushPendingFocus)

  logger.log('Window created')
})

app.on('window-all-closed', () => {
  // Don't destroy sessions — they persist on the server
  serverPipe.close()
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
