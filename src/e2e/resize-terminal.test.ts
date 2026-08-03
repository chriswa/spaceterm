import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { e2eBlocker, launchApp, type LaunchedApp } from './electron-app'
import { terminalPixelSize, MIN_COLS, MIN_ROWS, DEFAULT_COLS, DEFAULT_ROWS } from '../shared/node-size'

/**
 * Resizing a surface, through every process that has to agree about its size.
 *
 * A resize crosses the preload bridge, the main process, the server — which
 * clamps it and applies it to the node, the headless snapshot emulator and the
 * real PTY — and comes back as a state broadcast that redraws the card. Every
 * layer of that has unit coverage against a fake of the next one. Nothing else
 * checks the chain is connected, or that a resize reaches disk.
 *
 * The mutation is sent through the bridge rather than by driving the pointer:
 * the mode's geometry is renderer logic with its own jsdom coverage
 * (`ResizeGhost.test.tsx`, `node-size.test.ts`), and what only this layer can
 * show is the three processes agreeing. The surface is created live rather than
 * seeded, which also keeps the test out of startup recovery — that archives a
 * seeded terminal with no resumable agent session.
 */

const blocker = e2eBlocker()
const describeE2E = blocker ? describe.skip : describe

if (blocker) console.warn(`[e2e] skipping: ${blocker}`)

let launched: LaunchedApp | null = null

afterEach(async () => {
  await launched?.close()
  launched = null
})

/**
 * Press a card's action-bar button.
 *
 * Dispatched rather than clicked through Playwright: focusing a fresh surface
 * flies the camera to it, and a card mid-flight fails the actionability check
 * for being outside the viewport. What is under test is what the button does,
 * not whether it is on screen.
 */
async function pressCardButton(app: LaunchedApp, id: string, tooltip: string): Promise<void> {
  await app.window.evaluate(
    ([nodeId, label]) => {
      const el = document.querySelector(
        `.card-shell[data-node-id="${nodeId}"] [data-tooltip="${label}"]`
      ) as HTMLElement | null
      if (!el) throw new Error(`no "${label}" button on ${nodeId}`)
      el.click()
    },
    [id, tooltip] as [string, string]
  )
}

/** Create a real shell surface the way the UI does, and return its node id. */
async function createSurface(app: LaunchedApp): Promise<string> {
  await app.window.waitForSelector('.canvas-viewport', { timeout: 60_000 })
  await app.window.evaluate(() => window.api.node.terminalCreate('root' as never))
  await app.window.waitForSelector('.terminal-card', { timeout: 30_000 })
  // `data-node-id` lives on the CardShell root; `.terminal-card` is a class the
  // shell is given, applied further in.
  const id = await app.window.locator('.card-shell').evaluateAll(
    (els) => els.map((e) => e.getAttribute('data-node-id')).find((v) => v && v !== 'root') ?? null
  )
  if (!id) throw new Error('terminal card rendered without a node id')
  return id
}

/**
 * The card's rendered width. Scaled by the camera, so only ratios are
 * meaningful. Scoped to `.card-shell` because the toolbar carries a crab slot
 * tagged with the same node id.
 */
function cardWidth(app: LaunchedApp, id: string): Promise<number> {
  return app.window.locator(`.card-shell[data-node-id="${id}"]`).evaluate(
    (el) => (el as HTMLElement).getBoundingClientRect().width
  )
}

function persistedSize(app: LaunchedApp, id: string): { cols: number; rows: number } | undefined {
  const state = JSON.parse(readFileSync(join(app.home, 'state.json'), 'utf-8')) as
    { nodes: Record<string, { cols: number; rows: number } | undefined> }
  return state.nodes[id]
}

/** Persistence is debounced, so the file is a poll rather than a read. */
async function waitForPersistedSize(
  app: LaunchedApp,
  id: string,
  want: { cols: number; rows: number }
): Promise<void> {
  const deadline = Date.now() + 15_000
  for (;;) {
    const seen = persistedSize(app, id)
    if (seen && seen.cols === want.cols && seen.rows === want.rows) return
    if (Date.now() > deadline) {
      throw new Error(`state.json never showed ${want.cols}x${want.rows}; last saw ${JSON.stringify(seen)}`)
    }
    await app.window.waitForTimeout(250)
  }
}

async function resizeTo(app: LaunchedApp, id: string, cols: number, rows: number): Promise<void> {
  await app.window.evaluate(
    ([nodeId, c, r]) => window.api.node.terminalResize(nodeId as never, c as number, r as number),
    [id, cols, rows] as [string, number, number]
  )
}

describeE2E('resizing a terminal surface', () => {
  it('offers the mode on a terminal card, and opens a preview at the current size', async () => {
    launched = await launchApp()
    const id = await createSurface(launched)

    const button = launched.window.locator(`.card-shell[data-node-id="${id}"] [data-tooltip="Resize terminal"]`)
    expect(await button.count()).toBe(1)

    await pressCardButton(launched, id, 'Resize terminal')
    await launched.window.waitForSelector('.resize-ghost', { timeout: 10_000 })
    expect(await launched.window.locator('.resize-ghost__readout').innerText())
      .toBe(`${DEFAULT_COLS} × ${DEFAULT_ROWS}`)
  })

  it('previews the surface’s own content, and hides the card it stands for', async () => {
    launched = await launchApp()
    const id = await createSurface(launched)
    await launched.window.waitForTimeout(2000)

    await pressCardButton(launched, id, 'Resize terminal')
    await launched.window.waitForSelector('.resize-ghost', { timeout: 10_000 })
    const viewport = await launched.window.evaluate(
      () => ({ w: window.innerWidth, h: window.innerHeight })
    )
    await launched.window.mouse.move(viewport.w - 40, viewport.h - 40)
    await launched.window.waitForTimeout(400)

    const preview = await launched.window.evaluate(() => {
      const ghost = document.querySelector('.resize-ghost') as HTMLElement
      const canvas = ghost.querySelector('canvas') as HTMLCanvasElement | null
      const card = document.querySelector('.terminal-card') as HTMLElement
      let painted = 0
      if (canvas) {
        const w = Math.min(200, canvas.width)
        const h = Math.min(100, canvas.height)
        const pixels = canvas.getContext('2d')!.getImageData(0, 0, w, h).data
        for (let i = 3; i < pixels.length; i += 4) if (pixels[i] > 0) painted++
      }
      return {
        bars: [...ghost.querySelectorAll('.resize-ghost__bar')].length,
        painted,
        cardVisibility: getComputedStyle(card).visibility
      }
    })

    // Content copied from the card, chrome stood in for, and the card itself
    // out of the way — otherwise the same screen shows twice, offset.
    expect(preview.painted).toBeGreaterThan(0)
    expect(preview.bars).toBe(2)
    expect(preview.cardVisibility).toBe('hidden')
  })

  it('snaps to the default size while the Command key is held', async () => {
    launched = await launchApp()
    const id = await createSurface(launched)
    await resizeTo(launched, id, 200, 60)
    await waitForPersistedSize(launched, id, { cols: 200, rows: 60 })

    await pressCardButton(launched, id, 'Resize terminal')
    await launched.window.waitForSelector('.resize-ghost', { timeout: 10_000 })
    const viewport = await launched.window.evaluate(
      () => ({ w: window.innerWidth, h: window.innerHeight })
    )
    await launched.window.mouse.move(viewport.w - 40, viewport.h - 40)
    await launched.window.waitForTimeout(300)

    await launched.window.keyboard.down('Meta')
    await launched.window.waitForTimeout(300)
    // The readout follows the modifier without waiting for the mouse to move.
    expect(await launched.window.locator('.resize-ghost__readout').innerText())
      .toBe(`${DEFAULT_COLS} × ${DEFAULT_ROWS}`)

    await launched.window.mouse.down()
    await launched.window.mouse.up()
    await launched.window.keyboard.up('Meta')

    await waitForPersistedSize(launched, id, { cols: DEFAULT_COLS, rows: DEFAULT_ROWS })
  })

  it('repaints the snapshot at the new size instead of stretching it', async () => {
    // The snapshot subscription is keyed on focus, so its callback used to
    // hold the cols/rows of whichever render last focused the card: every
    // snapshot after a resize was painted at the old bitmap size and scaled to
    // the new box, and only focusing and unfocusing put it right.
    launched = await launchApp()
    const id = await createSurface(launched)
    await launched.window.waitForTimeout(2000)
    await launched.window.evaluate(() => {
      const vp = document.querySelector('.canvas-viewport') as HTMLElement
      for (const type of ['mousedown', 'mouseup', 'click']) {
        vp.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: 5, clientY: 5 }))
      }
    })
    await launched.window.waitForTimeout(1000)

    await resizeTo(launched, id, 200, 60)
    await waitForPersistedSize(launched, id, { cols: 200, rows: 60 })
    await launched.window.waitForTimeout(1000)

    const canvas = await launched.window.evaluate((nodeId) => {
      const c = document.querySelector(`.card-shell[data-node-id="${nodeId}"] canvas`) as HTMLCanvasElement
      return { bitmap: [c.width, c.height], box: [parseFloat(c.style.width), parseFloat(c.style.height)] }
    }, id)
    expect(canvas.bitmap).toEqual(canvas.box)
  })

  it('abandons the mode on Escape without touching the surface', async () => {
    launched = await launchApp()
    const id = await createSurface(launched)
    const before = await cardWidth(launched, id)

    await pressCardButton(launched, id, 'Resize terminal')
    await launched.window.waitForSelector('.resize-ghost', { timeout: 10_000 })
    await launched.window.keyboard.press('Escape')

    await launched.window.waitForSelector('.resize-ghost', { state: 'detached', timeout: 10_000 })
    expect(await cardWidth(launched, id)).toBe(before)
  })

  it('clamps on the server, not in the client', async () => {
    launched = await launchApp()
    const id = await createSurface(launched)
    const before = await cardWidth(launched, id)

    // Below the floor: asking for something illegal through the bridge is how
    // to show the limit is enforced past the UI that normally prevents it.
    await resizeTo(launched, id, 10, 5)

    await waitForPersistedSize(launched, id, { cols: MIN_COLS, rows: MIN_ROWS })
    expect(await cardWidth(launched, id)).toBeLessThan(before)
  })

  it('draws the card from the grid the server settled on', async () => {
    launched = await launchApp()
    const id = await createSurface(launched)

    await resizeTo(launched, id, 200, 60)
    await waitForPersistedSize(launched, id, { cols: 200, rows: 60 })

    const zoom = await launched.window.evaluate(() => {
      const surface = document.querySelector('.canvas-surface') as HTMLElement | null
      return surface ? new DOMMatrix(getComputedStyle(surface).transform).a : 1
    })
    expect(await cardWidth(launched, id)).toBeCloseTo(terminalPixelSize(200, 60).width * zoom, 0)
  })
})
