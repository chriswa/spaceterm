import { describe, it, expect, vi } from 'vitest'
import type { Terminal } from '@xterm/xterm'
import { attachWebGLRenderer } from './webgl-renderer'

/**
 * jsdom has no WebGL2, so this suite pins the fallback path — which is also the
 * path taken on a machine with software rendering or a blocklisted driver.
 *
 * The bug worth guarding: the addon does not fail loudly when the context is
 * missing. It loads, stores nothing, and then throws from a theme change one
 * render later. Anything that reintroduces a speculative `loadAddon` here will
 * fail these tests the same way it failed the card's lifecycle suite.
 */
function stubTerminal() {
  return { loadAddon: vi.fn() } as unknown as Terminal & { loadAddon: ReturnType<typeof vi.fn> }
}

describe('attachWebGLRenderer without WebGL', () => {
  it('does not load an addon onto the terminal', () => {
    const term = stubTerminal()
    attachWebGLRenderer(term)
    expect(term.loadAddon).not.toHaveBeenCalled()
  })

  it('returns a disposer that is safe to call, twice', () => {
    const dispose = attachWebGLRenderer(stubTerminal())
    expect(() => { dispose(); dispose() }).not.toThrow()
  })

  it('never throws at attach time', () => {
    expect(() => attachWebGLRenderer(stubTerminal())).not.toThrow()
  })
})
