import { describe, expect, it } from 'vitest'
import { setUpActionButton, type ActionButtonSetupDeps } from './action-button-setup'

function harness(over: Partial<ActionButtonSetupDeps> = {}) {
  const offered: Array<[string, string]> = []
  const toasts: string[] = []
  const deps: ActionButtonSetupDeps = {
    prepare: async () => ({ ok: true, urlPath: '/action-button/s3cret/Copy-Last-Dictation.shortcut' }),
    openInShortcuts: async (url, name) => { offered.push([url, name]) },
    origin: 'https://mac.tailnet.ts.net',
    toast: (message) => toasts.push(message),
    log: () => {},
    ...over,
  }
  return { deps, offered, toasts }
}

describe('setting up the Action button', () => {
  it("offers the Mac's signed shortcut to Shortcuts, then says where to choose it", async () => {
    const h = harness()
    await setUpActionButton(h.deps)
    expect(h.offered).toEqual([['https://mac.tailnet.ts.net/action-button/s3cret/Copy-Last-Dictation.shortcut', 'Copy Last Dictation']])
    expect(h.toasts.join()).toContain('Settings → Action Button')
  })

  it('says why when the Mac cannot make it, and offers nothing', async () => {
    const h = harness({ prepare: async () => ({ ok: false, message: 'The Mac could not sign the shortcut: offline' }) })
    await setUpActionButton(h.deps)
    expect(h.offered).toEqual([])
    expect(h.toasts).toEqual(['The Mac could not sign the shortcut: offline'])
  })

  it('says why when the app cannot offer it, such as an app too old', async () => {
    const h = harness({ openInShortcuts: async () => { throw new Error('this iPhone app is too old to add shortcuts; install the app update first') } })
    await setUpActionButton(h.deps)
    expect(h.toasts).toEqual(['Could not set up the Action button: this iPhone app is too old to add shortcuts; install the app update first'])
  })
})
