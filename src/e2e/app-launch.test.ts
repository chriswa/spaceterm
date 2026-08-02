import { describe, it, expect, afterEach } from 'vitest'
import { existsSync } from 'fs'
import { join } from 'path'
import { e2eBlocker, launchApp, type LaunchedApp } from './electron-app'

/**
 * The real app, launched.
 *
 * Three processes have to agree for any of this to pass: the Go pty daemon, the
 * Node server, and Electron's main and renderer. Nothing else in the suite
 * covers that they actually connect — every other test fakes at least one of
 * the three.
 *
 * Deliberately shallow. This layer is slow and the most brittle thing in the
 * repo (timing, focus, elements off-viewport at high zoom), so it answers
 * "does it come up and talk to itself" and leaves behaviour to the jsdom
 * project. A broad E2E suite here would be a suite nobody trusts.
 */

const blocker = e2eBlocker()
const describeE2E = blocker ? describe.skip : describe

if (blocker) {
  // Say why rather than vanishing. A suite that silently disappears looks
  // identical to a suite that passed.
  console.warn(`[e2e] skipping: ${blocker}`)
}

let launched: LaunchedApp | null = null

afterEach(async () => {
  await launched?.close()
  launched = null
})

describeE2E('launching Spaceterm', () => {
  it('opens a window', async () => {
    launched = await launchApp()
    expect(await launched.window.title()).toBeTruthy()
  })

  it('mounts the React tree rather than showing a blank page', async () => {
    // A renderer that throws during mount leaves #root empty, which is exactly
    // what a missing preload bridge or a node builtin in the bundle produces.
    launched = await launchApp()
    await launched.window.waitForSelector('#root', { timeout: 30_000 })
    const html = await launched.window.locator('#root').innerHTML()
    expect(html.length).toBeGreaterThan(100)
  })

  it('renders the canvas and the toolbar', async () => {
    launched = await launchApp()
    await launched.window.waitForSelector('.canvas-viewport', { timeout: 30_000 })
    // `.count()`, not Playwright's `toHaveCount` — that matcher lives in
    // @playwright/test's expect, and this suite runs on Vitest's.
    expect(await launched.window.locator('.toolbar').count()).toBe(1)
  })

  it('reports no uncaught page errors during startup', async () => {
    // The single most valuable assertion here: it catches a broken bundle, a
    // preload mismatch, or a store that throws on hydration — none of which
    // any faked test can see.
    const errors: string[] = []
    launched = await launchApp()
    launched.window.on('pageerror', (err) => errors.push(err.message))

    await launched.window.waitForSelector('.canvas-viewport', { timeout: 30_000 })
    await launched.window.waitForTimeout(1500)

    expect(errors, `page errors during startup:\n  ${errors.join('\n  ')}`).toEqual([])
  })

  it('exposes the preload bridge to the renderer', async () => {
    // contextIsolation means the bridge is the only thing crossing over, and a
    // preload that failed to load produces a renderer that mounts and then
    // dies on its first server call.
    launched = await launchApp()
    const shape = await launched.window.evaluate(() => ({
      hasApi: typeof (window as { api?: unknown }).api === 'object',
      namespaces: Object.keys((window as { api?: object }).api ?? {}).sort()
    }))

    expect(shape.hasApi).toBe(true)
    expect(shape.namespaces).toEqual(
      expect.arrayContaining(['node', 'perf', 'pty', 'tts', 'window'])
    )
  })

  it('does not leak node integration into the renderer', async () => {
    // `nodeIntegration: false` plus `contextIsolation: true` is the whole
    // security posture of the renderer. A regression here would be silent.
    launched = await launchApp()
    const leaked = await launched.window.evaluate(() => ({
      require: typeof (window as Record<string, unknown>).require,
      process: typeof (window as Record<string, unknown>).process,
      module: typeof (window as Record<string, unknown>).module
    }))

    expect(leaked).toEqual({ require: 'undefined', process: 'undefined', module: 'undefined' })
  })

  it('keeps its state inside the isolated SPACETERM_HOME', async () => {
    // Both the server and the Go daemon honour SPACETERM_HOME. If either ever
    // stopped, an E2E run would adopt — and then destroy — the developer's
    // live session, which is the kind of thing you find out about once.
    launched = await launchApp()
    await launched.window.waitForSelector('.canvas-viewport', { timeout: 30_000 })
    await launched.window.waitForTimeout(2000)

    const home = launched.home
    const touched = ['state.json', 'electron.log', 'bidirectional.sock', 'pty-daemon.sock']
      .filter((f) => existsSync(join(home, f)))
    expect(touched.length, `nothing was written under ${home}`).toBeGreaterThan(0)
  })
})

describeE2E('the main process', () => {
  it('is reachable, so main-process code is testable at all', async () => {
    // app.evaluate runs INSIDE the main process — the only way to reach
    // src/client/main/ from a test. Proving the channel works is the
    // prerequisite for testing window state, IPC handlers and lifecycle.
    launched = await launchApp()
    const info = await launched.app.evaluate(async ({ app, BrowserWindow }) => ({
      name: app.getName(),
      windows: BrowserWindow.getAllWindows().length,
      ready: app.isReady()
    }))

    expect(info.ready).toBe(true)
    expect(info.windows).toBeGreaterThan(0)
  })

  it('registers the spaceterm-file protocol the file cards load through', async () => {
    // Main-process only and genuinely load-bearing: a file card renders its
    // content through this scheme, and a handler that failed to register shows
    // up as a card that is silently blank rather than as an error.
    launched = await launchApp()
    const handled = await launched.app.evaluate(async ({ protocol }) =>
      protocol.isProtocolHandled('spaceterm-file')
    )
    expect(handled).toBe(true)
  })

  it('fills the work area without a title bar, rather than going fullscreen', async () => {
    // The window is deliberately not fullscreen: native fullscreen hides the menu bar
    // (and its status items) unless the OS is configured not to, and that setting is
    // per-machine. Frameless + work-area bounds drops the title bar without the OS
    // dependency. Content bounds matching the outer bounds is what "no frame" looks
    // like from the main process — there is no isFrameless() to ask.
    launched = await launchApp()
    const info = await launched.app.evaluate(async ({ BrowserWindow, screen }) => {
      const win = BrowserWindow.getAllWindows()[0]
      const bounds = win.getBounds()
      const display = screen.getDisplayNearestPoint({
        x: bounds.x + Math.floor(bounds.width / 2),
        y: bounds.y + Math.floor(bounds.height / 2)
      })
      return {
        fullScreen: win.isFullScreen(),
        bounds,
        content: win.getContentBounds(),
        workArea: display.workArea
      }
    })

    expect(info.fullScreen).toBe(false)
    expect(info.bounds).toEqual(info.workArea)
    expect(info.content).toEqual(info.bounds)
  })

  it('has exactly one window — a second would mean a duplicate createWindow', async () => {
    launched = await launchApp()
    const count = await launched.app.evaluate(async ({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().length
    )
    expect(count).toBe(1)
  })
})

describeE2E('when the server cannot start', () => {
  it('still opens a window instead of showing nothing at all', async () => {
    // `app.whenReady()` used to `await client.connect()` before creating the
    // window, and `connect()` retries forever rather than rejecting — so a
    // server that could not start meant no window, permanently, with no error.
    // A first-run user saw a dock icon and nothing else. Startup now waits a
    // bounded grace period and opens the window regardless.
    launched = await launchApp({ withServer: false })
    await launched.window.waitForSelector('.canvas-viewport', { timeout: 60_000 })
    expect(await launched.window.locator('.toolbar').count()).toBe(1)
  })

  it('renders an empty canvas rather than crashing on the failed sync', async () => {
    // The renderer's initial `syncRequest` rejects with no server. It has
    // always tolerated that; this proves it end to end rather than against a
    // fake bridge.
    const errors: string[] = []
    launched = await launchApp({ withServer: false })
    launched.window.on('pageerror', (err) => errors.push(err.message))

    await launched.window.waitForSelector('.canvas-viewport', { timeout: 60_000 })
    await launched.window.waitForTimeout(1000)

    expect(errors, `page errors with no server:\n  ${errors.join('\n  ')}`).toEqual([])
  })
})

describeE2E('a canvas with content', () => {
  /**
   * A persisted state file with one card of every non-terminal type.
   *
   * Terminals are deliberately absent: reviving one spawns a real shell through
   * the daemon, which makes the test about pty lifecycle rather than about
   * rendering. The four here are exactly the ones App.tsx renders from one
   * shared prop bundle, so this is the end-to-end check on that hoist.
   */
  function seededState(): unknown {
    const base = (id: string, x: number, y: number) => ({
      id, parentId: 'root', x, y, zIndex: 1, archivedChildren: [], colorPresetId: 'inherit'
    })
    return {
      version: 2,
      nextZIndex: 10,
      nodes: {
        md: { ...base('md', 0, 0), type: 'markdown', width: 400, height: 300, content: '# Seeded Markdown' },
        ttl: { ...base('ttl', 600, 0), type: 'title', text: 'Seeded Title' },
        dir: { ...base('dir', 0, 500), type: 'directory', cwd: '/tmp' },
        fil: { ...base('fil', 600, 500), type: 'file', filePath: '/tmp/seeded.txt' }
      },
      rootArchivedChildren: [],
      undoBuffer: [],
      undoCursor: -1,
      savedViewports: {}
    }
  }

  it('renders one card per persisted node', async () => {
    launched = await launchApp({ seedState: seededState() })
    await launched.window.waitForSelector('.card-shell', { timeout: 30_000 })

    const ids = await launched.window.locator('.card-shell').evaluateAll(
      (els) => els.map((e) => e.getAttribute('data-node-id')).sort()
    )
    // `root` is the canvas origin marker, which is a CardShell too — one more
    // thing the shared shell already covers.
    expect(ids).toEqual(['dir', 'fil', 'md', 'root', 'ttl'])
  })

  it('shows each card’s own content', async () => {
    launched = await launchApp({ seedState: seededState() })
    await launched.window.waitForSelector('.card-shell', { timeout: 30_000 })
    const text = await launched.window.locator('.canvas-viewport').innerText()

    expect(text).toContain('Seeded Title')
    expect(text).toContain('Seeded Markdown')
  })

  it('stacks titles above directories above ordinary cards', async () => {
    // The z-index tiering moved into CARD_TYPE_SPECS and is now applied
    // uniformly through one shared prop bundle. This is the check that the
    // uniform call did not change what lands in the DOM.
    launched = await launchApp({ seedState: seededState() })
    await launched.window.waitForSelector('.card-shell', { timeout: 30_000 })

    const z = Object.fromEntries(
      await launched.window.locator('.card-shell').evaluateAll((els) =>
        els.map((e) => [e.getAttribute('data-node-id'), Number((e as HTMLElement).style.zIndex)])
      )
    ) as Record<string, number>

    expect(z.ttl).toBeGreaterThan(z.dir)
    expect(z.dir).toBeGreaterThan(z.md)
    expect(z.dir).toBeGreaterThan(z.fil)
  })

  it('renders them all without a page error', async () => {
    const errors: string[] = []
    launched = await launchApp({ seedState: seededState() })
    launched.window.on('pageerror', (err) => errors.push(err.message))

    await launched.window.waitForSelector('.card-shell', { timeout: 30_000 })
    await launched.window.waitForTimeout(1000)

    expect(errors, `page errors rendering cards:\n  ${errors.join('\n  ')}`).toEqual([])
  })
})
