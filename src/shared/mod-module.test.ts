import { describe, it, expect, vi } from 'vitest'
import { runModPhase, type ModHostBase, type ServerModModule } from './mod-module'

/**
 * The containment rule.
 *
 * Loading mods in-process instead of spawning them trades crash isolation for
 * a great deal less machinery. This is the part of that isolation a
 * `try`/`catch` can buy back, and it is the only thing standing between one
 * careless mod and the rest of them, so it is worth pinning precisely.
 */

interface TestHost extends ModHostBase { }

/** Annotated so TypeScript does not infer an element type from the first entry. */
type TestMods = ReadonlyArray<{ modId: string; module: ServerModModule<TestHost> }>

const logs: string[] = []
const hostFor = (modId: string): TestHost => ({ modId, log: (line) => logs.push(`${modId}: ${line}`) })

describe('a phase over several mods', () => {
  it('runs every mod', () => {
    const order: string[] = []
    const mods: TestMods = [
      { modId: 'a', module: { register: () => { order.push('a') } } },
      { modId: 'b', module: { register: () => { order.push('b') } } },
    ]
    runModPhase(mods, 'register', hostFor, new Set())
    expect(order).toEqual(['a', 'b'])
  })

  it('is fine with a mod that implements neither phase', () => {
    const results = runModPhase([{ modId: 'a', module: {} }], 'register', hostFor, new Set())
    expect(results).toEqual([{ modId: 'a', ok: true }])
  })

  it('hands each mod a host scoped to its own id', () => {
    const seen: string[] = []
    runModPhase(
      [
        { modId: 'a', module: { register: (h: TestHost) => { seen.push(h.modId) } } },
        { modId: 'b', module: { register: (h: TestHost) => { seen.push(h.modId) } } },
      ],
      'register', hostFor, new Set(),
    )
    expect(seen).toEqual(['a', 'b'])
  })
})

describe('a mod that throws', () => {
  it('does not stop the mods after it', () => {
    const order: string[] = []
    const mods: TestMods = [
      { modId: 'bad', module: { register: () => { throw new Error('boom') } } },
      { modId: 'good', module: { register: () => { order.push('good') } } },
    ]
    const results = runModPhase(mods, 'register', hostFor, new Set())
    expect(order).toEqual(['good'])
    expect(results).toEqual([
      { modId: 'bad', ok: false, error: expect.stringContaining('boom') },
      { modId: 'good', ok: true },
    ])
  })

  it('is marked failed, so it never reaches the next phase', () => {
    // Half-declared and then started is how one broken mod becomes several.
    const failed = new Set<string>()
    const activated: string[] = []
    const mods: TestMods = [
      {
        modId: 'bad',
        module: {
          register: () => { throw new Error('boom') },
          activate: () => { activated.push('bad') },
        },
      },
      { modId: 'good', module: { activate: () => { activated.push('good') } } },
    ]
    runModPhase(mods, 'register', hostFor, failed)
    runModPhase(mods, 'activate', hostFor, failed)

    expect(failed).toEqual(new Set(['bad']))
    expect(activated).toEqual(['good'])
  })

  it('reports the stack, not just the message', () => {
    const results = runModPhase(
      [{ modId: 'bad', module: { register: () => { throw new Error('boom') } } }],
      'register', hostFor, new Set(),
    )
    // A mod failing to load is a thing someone has to debug, and "boom" alone
    // does not say which line.
    expect(results[0].error).toContain('mod-module.test')
  })

  it('contains a thrown non-Error', () => {
    const results = runModPhase(
      [{ modId: 'bad', module: { register: () => { throw 'a string' } } }],
      'register', hostFor, new Set(),
    )
    expect(results[0]).toMatchObject({ ok: false, error: 'a string' })
  })
})

describe('an async activate that rejects', () => {
  it('is contained rather than becoming an unhandled rejection', async () => {
    logs.length = 0
    const failed = new Set<string>()
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)

    runModPhase(
      [{ modId: 'slow', module: { activate: () => Promise.reject(new Error('late boom')) } }],
      'activate', hostFor, failed,
    )
    await new Promise((r) => setTimeout(r, 0))
    process.off('unhandledRejection', unhandled)

    expect(unhandled).not.toHaveBeenCalled()
    expect(failed).toEqual(new Set(['slow']))
    // Named, because an unattributed rejection is the worst kind to chase.
    expect(logs.join('\n')).toContain('slow')
  })
})
