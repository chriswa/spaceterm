import { describe, it, expect, vi, afterEach } from 'vitest'

/** A fresh copy of the store, as a new start of the app reads it. */
async function restart() {
  vi.resetModules()
  return (await import('./controlTranscriptStore')).useControlTranscriptStore
}

afterEach(() => localStorage.clear())

describe('controlTranscriptStore open', () => {
  it('starts closed on a device that never opened it', async () => {
    expect((await restart()).getState().open).toBe(false)
  })

  it('starts as it was left', async () => {
    ;(await restart()).getState().setOpen(true)
    const reopened = await restart()
    expect(reopened.getState().open).toBe(true)
    reopened.getState().setOpen(false)
    expect((await restart()).getState().open).toBe(false)
  })
})
