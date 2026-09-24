import { describe, it, expect, afterEach } from 'vitest'
import { e2eBlocker, launchApp, type LaunchedApp } from './electron-app'

/**
 * A stamp floats above every card, and must still let a click on the empty
 * corners of its box reach the card underneath. That is the browser's hit
 * testing against the SVG's painted shapes, which jsdom does not do — so it is
 * checked here, against real Chromium.
 */

const blocker = e2eBlocker()
const describeE2E = blocker ? describe.skip : describe

if (blocker) console.warn(`[e2e] skipping: ${blocker}`)

let launched: LaunchedApp | null = null

afterEach(async () => {
  await launched?.close()
  launched = null
})

describeE2E('stamps', () => {
  it('catch the pointer on their glyph and pass it through everywhere else', async () => {
    launched = await launchApp()
    const page = launched.window
    await page.waitForSelector('.canvas-viewport', { timeout: 60_000 })

    // Drop both where the camera is already looking, rather than moving the
    // camera to them: the surface's transform is the camera.
    const centre = await page.evaluate(() => {
      const viewport = document.querySelector('.canvas-viewport')!.getBoundingClientRect()
      const m = new DOMMatrix(getComputedStyle(document.querySelector('.canvas-surface')!).transform)
      return { x: (viewport.width / 2 - m.e) / m.a, y: (viewport.height / 2 - m.f) / m.a }
    })
    const title = await page.evaluate(async (p) => (await window.api.node.titleAdd('root' as never, p.x, p.y)).nodeId, centre)
    const stamp = await page.evaluate(async (p) => (await window.api.node.stampAdd('root' as never, 'star', p.x, p.y)).nodeId, centre)
    await page.waitForSelector(`.card-shell[data-node-id="${stamp}"] .stamp-art__ink`, { timeout: 30_000 })

    const probe = () => page.evaluate((stampId) => {
      const shell = document.querySelector(`.card-shell[data-node-id="${stampId}"]`)!
      const r = shell.getBoundingClientRect()
      const at = (x: number, y: number) =>
        (document.elementFromPoint(x, y)?.closest('.canvas-node') as HTMLElement | null)?.dataset.nodeId ?? null
      return {
        centre: at(r.left + r.width / 2, r.top + r.height / 2),
        // The top-left corner of a star's box is empty.
        corner: at(r.left + r.width * 0.05, r.top + r.height * 0.05)
      }
    }, stamp)

    // The cards can lay out a frame or two after the ink first appears.
    await expect.poll(probe, { timeout: 15_000, interval: 200 }).toEqual({ centre: stamp, corner: title })
  }, 120_000)
})
