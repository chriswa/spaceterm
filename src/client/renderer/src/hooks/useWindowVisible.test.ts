import { describe, it, expect, beforeEach, vi } from 'vitest'
import { installFakeBridge, type FakeBridge } from '../testing/fake-bridge'

/**
 * Two sources, and the interesting cases are the ones only one of them sees.
 *
 * The signal decides whether the render loops run, and `CanvasFrameGate` treats
 * a transition back to visible as "the composited frame is gone, repaint" — so a
 * missed transition is a canvas that stays wrong. Occlusion is the case with no
 * Electron event behind it, and therefore the one worth pinning: `BrowserWindow`
 * reports nothing when the window is covered or on another Space, and
 * `document.visibilityState` is the only thing that does.
 */

/** jsdom's `visibilityState` is a getter on the prototype, so it is redefined. */
function defineDocumentVisibility(hidden: boolean): void {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => (hidden ? 'hidden' : 'visible'),
  })
}

/** What Chromium does when the window is occluded, hidden, or on another Space. */
function occlude(hidden: boolean): void {
  defineDocumentVisibility(hidden)
  document.dispatchEvent(new Event('visibilitychange'))
}

/**
 * The module memoises its state on import, which is what makes it a single
 * source of truth — so each case needs a fresh copy of it.
 */
async function load(): Promise<typeof import('./useWindowVisible')> {
  vi.resetModules()
  return import('./useWindowVisible')
}

describe('window visibility', () => {
  let bridge: FakeBridge

  beforeEach(() => {
    bridge = installFakeBridge()
    defineDocumentVisibility(false)
  })

  it('is visible when both sources agree it is', async () => {
    const { isWindowVisible } = await load()
    expect(isWindowVisible()).toBe(true)
  })

  it('starts hidden when the document is already hidden at import', async () => {
    defineDocumentVisibility(true)
    const { isWindowVisible } = await load()
    expect(isWindowVisible()).toBe(false)
  })

  it('reports occlusion, which the main process cannot', async () => {
    const { isWindowVisible, onWindowVisibleChange } = await load()
    const seen: boolean[] = []
    onWindowVisibleChange((v) => seen.push(v))

    occlude(true)
    expect(isWindowVisible()).toBe(false)

    occlude(false)
    expect(isWindowVisible()).toBe(true)
    expect(seen).toEqual([false, true])
  })

  it('stays hidden while either source says so', async () => {
    const { isWindowVisible } = await load()

    bridge.emit.visibilityChanged(false)
    expect(isWindowVisible()).toBe(false)

    // The document going hidden and back must not talk the window out of being
    // minimised: a restore is the main process's to report.
    occlude(true)
    occlude(false)
    expect(isWindowVisible()).toBe(false)

    bridge.emit.visibilityChanged(true)
    expect(isWindowVisible()).toBe(true)
  })

  it('notifies only on a change', async () => {
    const { onWindowVisibleChange } = await load()
    const cb = vi.fn()
    onWindowVisibleChange(cb)

    occlude(true)
    occlude(true)
    bridge.emit.visibilityChanged(false)
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('stops notifying once unsubscribed', async () => {
    const { onWindowVisibleChange } = await load()
    const cb = vi.fn()
    onWindowVisibleChange(cb)()

    occlude(true)
    expect(cb).not.toHaveBeenCalled()
  })
})
