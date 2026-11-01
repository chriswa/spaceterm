import { describe, expect, it } from 'vitest'
import { setUpActionButton, type ActionButtonSetupDeps } from './action-button-setup'

function harness(over: Partial<ActionButtonSetupDeps> & { fetchedAnswer?: boolean } = {}) {
  const opened: string[] = []
  const toasts: string[] = []
  let back: ((left: boolean) => void) | undefined
  const deps: ActionButtonSetupDeps = {
    prepare: async () => ({ ok: true, urlPath: '/action-button/s3cret/Copy-Last-Dictation.shortcut' }),
    fetched: async () => over.fetchedAnswer ?? true,
    open: (url) => opened.push(url),
    origin: 'https://mac.tailnet.ts.net',
    inApp: true,
    whenBack: (_ms, fn) => { back = fn },
    toast: (message) => toasts.push(message),
    log: () => {},
    ...over,
  }
  return {
    deps, opened, toasts,
    comeBack: async (left = true) => { back?.(left); await new Promise((r) => setTimeout(r, 0)) },
  }
}

const FILE = 'https://mac.tailnet.ts.net/action-button/s3cret/Copy-Last-Dictation.shortcut'

describe('setting up the Action button', () => {
  it("opens Shortcuts' import link to the Mac's signed shortcut", async () => {
    const h = harness()
    await setUpActionButton(h.deps)
    expect(h.opened).toEqual([`shortcuts://import-shortcut?url=${encodeURIComponent(FILE)}&name=Copy%20Last%20Dictation`])
  })

  it('once Shortcuts fetched it, says where to choose it for the Action button', async () => {
    const h = harness()
    await setUpActionButton(h.deps)
    await h.comeBack()
    expect(h.opened).toHaveLength(1)
    expect(h.toasts.join()).toContain('Settings → Action Button')
  })

  it('opens it in Safari when Shortcuts never fetched it', async () => {
    const h = harness({ fetchedAnswer: false })
    await setUpActionButton(h.deps)
    await h.comeBack(false)
    expect(h.opened.at(-1)).toBe(`x-safari-${FILE}`)
  })

  it('in Safari itself, simply opens the file', async () => {
    const h = harness({ fetchedAnswer: false, inApp: false })
    await setUpActionButton(h.deps)
    await h.comeBack()
    expect(h.opened.at(-1)).toBe(FILE)
  })

  it('says why when the Mac cannot make it, and opens nothing', async () => {
    const h = harness({ prepare: async () => ({ ok: false, message: 'The Mac could not sign the shortcut: offline' }) })
    await setUpActionButton(h.deps)
    expect(h.opened).toEqual([])
    expect(h.toasts).toEqual(['The Mac could not sign the shortcut: offline'])
  })
})
