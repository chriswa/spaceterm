import { describe, it, expect } from 'vitest'
import { needsRebuild, refreshMobileBuild, type MobileBuildDeps } from './mobile-build'

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
