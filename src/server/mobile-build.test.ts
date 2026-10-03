import { describe, it, expect, vi } from 'vitest'
import { needsRebuild, refreshMobileBuild, isSourcePath, MobileBuildKeeper, type MobileBuildDeps } from './mobile-build'

function deps(over: Partial<MobileBuildDeps> = {}) {
  const calls: string[] = []
  const d: MobileBuildDeps = {
    newestSource: () => 200,
    builtAt: () => 100,
    build: async (dir) => { calls.push(`build ${dir}`); return { ok: true, output: '' } },
    swap: (staged, target) => { calls.push(`swap ${staged} -> ${target}`) },
    log: () => undefined,
    ...over
  }
  return { d, calls }
}

describe('needsRebuild', () => {
  it('builds when there is no build at all', () => expect(needsRebuild(0, null)).toBe(true))
  it('builds when a source is newer than the build', () => expect(needsRebuild(200, 100)).toBe(true))
  it('leaves a current build alone', () => expect(needsRebuild(100, 200)).toBe(false))
})

describe('refreshMobileBuild', () => {
  it('builds into staging and swaps it in', async () => {
    const { d, calls } = deps()
    await expect(refreshMobileBuild('/out/mobile', d)).resolves.toBe('rebuilt')
    expect(calls).toEqual(['build /out/mobile.next', 'swap /out/mobile.next -> /out/mobile'])
  })

  it('does nothing when current', async () => {
    const { d, calls } = deps({ builtAt: () => 300 })
    await expect(refreshMobileBuild('/out/mobile', d)).resolves.toBe('current')
    expect(calls).toEqual([])
  })

  it('keeps serving the old build when the new one fails', async () => {
    const { d, calls } = deps({ build: async () => ({ ok: false, output: 'boom' }) })
    await expect(refreshMobileBuild('/out/mobile', d)).resolves.toBe('failed')
    expect(calls).toEqual([])
  })
})

describe('isSourcePath', () => {
  it('counts sources, not build output, dependencies or dotfiles', () => {
    expect(isSourcePath('components/TerminalCard.tsx')).toBe(true)
    expect(isSourcePath('ios/build/Release-iphoneos/SpacetermMobile.app/Info.plist')).toBe(false)
    expect(isSourcePath('node_modules/x/index.js')).toBe(false)
    expect(isSourcePath('.DS_Store')).toBe(false)
  })
})

describe('MobileBuildKeeper', () => {
  function keeper(results: Array<'current' | 'rebuilt' | 'failed'> = ['rebuilt']) {
    const timers: Array<{ fn: () => void; cancelled: boolean }> = []
    let finish: () => void = () => undefined
    let refreshes = 0
    const rebuilt = vi.fn()
    const k = new MobileBuildKeeper({
      refresh: () => {
        refreshes++
        const result = results.shift() ?? 'current'
        return new Promise((resolve) => { finish = () => resolve(result) })
      },
      schedule: (fn) => {
        const timer = { fn, cancelled: false }
        timers.push(timer)
        return () => { timer.cancelled = true }
      }
    }, rebuilt)
    const fire = () => { for (const t of timers.splice(0)) if (!t.cancelled) t.fn() }
    return { k, rebuilt, fire, finish: async () => { finish(); await new Promise((r) => setTimeout(r, 0)) }, refreshes: () => refreshes }
  }

  it('waits for a burst of edits to go quiet, then builds once, and says so', async () => {
    const h = keeper()
    h.k.changed()
    h.k.changed()
    h.k.changed()
    expect(h.refreshes()).toBe(0)
    h.fire()
    expect(h.refreshes()).toBe(1)
    await h.finish()
    expect(h.rebuilt).toHaveBeenCalledTimes(1)
  })

  it('an edit during a build earns exactly one more build, after it', async () => {
    const h = keeper(['rebuilt', 'rebuilt'])
    h.k.changed()
    h.fire()
    h.k.changed()
    h.k.changed()
    expect(h.refreshes()).toBe(1)
    await h.finish()
    h.fire()
    expect(h.refreshes()).toBe(2)
  })

  it('says nothing when the edit did not change the bundle', async () => {
    const h = keeper(['current'])
    h.k.changed()
    h.fire()
    await h.finish()
    expect(h.rebuilt).not.toHaveBeenCalled()
  })
})
