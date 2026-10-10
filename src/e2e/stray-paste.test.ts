import { describe, it, expect, afterEach } from 'vitest'
import { e2eBlocker, launchApp, type LaunchedApp } from './electron-app'

/**
 * A paste into a window with nothing focused is caught as dictation.
 *
 * The jsdom tests cover which focus counts as "nowhere"; what only the real app
 * can answer is whether Chromium fires a `paste` event at all when ⌘V lands on
 * a page with no editable focus. `webContents.paste()` is what the default Edit
 * menu's ⌘V runs, so it is the path Voice Operator's synthesized keystroke
 * takes.
 *
 * `receptionist.say` is replaced in the page, so the text never reaches a
 * real Control.
 */

const blocker = e2eBlocker()
const describeE2E = blocker ? describe.skip : describe

if (blocker) console.warn(`[e2e] skipping: ${blocker}`)

let launched: LaunchedApp | null = null

afterEach(async () => {
  await launched?.close()
  launched = null
})

describeE2E('a stray paste', () => {
  it('goes to Control, as said, when nothing has focus', async () => {
    launched = await launchApp()
    const { app, window } = launched
    await window.waitForSelector('.canvas-viewport', { timeout: 60_000 })

    await window.evaluate(() => {
      const sent: Array<[string, boolean]> = []
      ;(window as unknown as { __sent: typeof sent }).__sent = sent
      window.api.receptionist.say = (text, how) => { sent.push([text, how?.spoken === true]) }
      ;(document.activeElement as HTMLElement | null)?.blur()
    })

    // The system clipboard is shared with the operator's session on macOS, so
    // whatever they had on it is put back.
    const saved = await app.evaluate(({ clipboard }) => clipboard.readText())
    try {
      await app.evaluate(({ BrowserWindow, clipboard }) => {
        clipboard.writeText('  open the build logs  ')
        BrowserWindow.getAllWindows()[0].webContents.paste()
      })

      await expect.poll(
        () => window.evaluate(() => (window as unknown as { __sent: Array<[string, boolean]> }).__sent),
        { timeout: 10_000 },
      ).toEqual([['open the build logs', true]])
    } finally {
      await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), saved)
    }
  })
})
