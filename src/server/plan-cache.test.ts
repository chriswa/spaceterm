import { describe, it, expect } from 'vitest'
import { PlanCacheManager, type PlanCacheStore } from './plan-cache'
import { asClaudeSessionId, asPtySessionId } from '../shared/ids'

const SURFACE = asPtySessionId('surface-1')
const SESSION = asClaudeSessionId('session-1')

class FakeStore implements PlanCacheStore {
  readonly files = new Map<string, string>()
  readonly cacheDir = '/cache'

  read(filePath: string): string | undefined {
    return this.files.get(filePath)
  }

  write(filePath: string, content: string): void {
    this.files.set(filePath, content)
  }

  /** Simulate a cached version becoming unreadable (deleted, permissions). */
  remove(filePath: string): void {
    this.files.delete(filePath)
  }
}

function harness(): { manager: PlanCacheManager; store: FakeStore } {
  const store = new FakeStore()
  return { manager: new PlanCacheManager(store), store }
}

describe('before any plan file is tracked', () => {
  it('snapshot returns nothing', () => {
    const { manager } = harness()
    expect(manager.snapshot(SURFACE, SESSION, 1000)).toEqual([])
  })

  it('getVersions returns nothing', () => {
    const { manager } = harness()
    expect(manager.getVersions(SESSION)).toEqual([])
  })
})

describe('snapshot', () => {
  it('copies the tracked plan into the cache directory', () => {
    const { manager, store } = harness()
    store.write('/plans/plan.md', 'version one')
    manager.trackPlanFile(SURFACE, '/plans/plan.md')

    const files = manager.snapshot(SURFACE, SESSION, 1000)

    expect(files).toHaveLength(1)
    expect(files[0].startsWith('/cache/')).toBe(true)
    expect(store.read(files[0])).toBe('version one')
  })

  it('returns the existing versions when the tracked file is unreadable', () => {
    const { manager, store } = harness()
    store.write('/plans/plan.md', 'version one')
    manager.trackPlanFile(SURFACE, '/plans/plan.md')
    manager.snapshot(SURFACE, SESSION, 1000)

    store.remove('/plans/plan.md')
    const files = manager.snapshot(SURFACE, SESSION, 2000)

    expect(files).toHaveLength(1)
  })

  it('appends a version when the plan changes', () => {
    const { manager, store } = harness()
    manager.trackPlanFile(SURFACE, '/plans/plan.md')

    store.write('/plans/plan.md', 'version one')
    manager.snapshot(SURFACE, SESSION, 1000)
    store.write('/plans/plan.md', 'version two')
    const files = manager.snapshot(SURFACE, SESSION, 2000)

    expect(files).toHaveLength(2)
    expect(store.read(files[0])).toBe('version one')
    expect(store.read(files[1])).toBe('version two')
  })

  it('does not append when the plan is unchanged', () => {
    const { manager, store } = harness()
    store.write('/plans/plan.md', 'same')
    manager.trackPlanFile(SURFACE, '/plans/plan.md')

    manager.snapshot(SURFACE, SESSION, 1000)
    const files = manager.snapshot(SURFACE, SESSION, 2000)

    expect(files).toHaveLength(1)
  })

  it('re-snapshots when the newest cached version has gone missing', () => {
    const { manager, store } = harness()
    store.write('/plans/plan.md', 'same')
    manager.trackPlanFile(SURFACE, '/plans/plan.md')

    const first = manager.snapshot(SURFACE, SESSION, 1000)
    store.remove(first[0])
    const files = manager.snapshot(SURFACE, SESSION, 2000)

    expect(files).toHaveLength(2)
  })

  it('compares only against the newest version, so a plan can revert', () => {
    const { manager, store } = harness()
    manager.trackPlanFile(SURFACE, '/plans/plan.md')

    store.write('/plans/plan.md', 'A')
    manager.snapshot(SURFACE, SESSION, 1000)
    store.write('/plans/plan.md', 'B')
    manager.snapshot(SURFACE, SESSION, 2000)
    store.write('/plans/plan.md', 'A')
    const files = manager.snapshot(SURFACE, SESSION, 3000)

    expect(files.map((f) => store.read(f))).toEqual(['A', 'B', 'A'])
  })

  it('gives distinct filenames to versions captured in the same millisecond', () => {
    // Two writes a millisecond apart used to produce the same path, so the
    // newer one overwrote the older and the list gained a duplicate entry.
    const { manager, store } = harness()
    manager.trackPlanFile(SURFACE, '/plans/plan.md')

    store.write('/plans/plan.md', 'first')
    manager.snapshot(SURFACE, SESSION, 1000)
    store.write('/plans/plan.md', 'second')
    const files = manager.snapshot(SURFACE, SESSION, 1000)

    expect(new Set(files).size).toBe(2)
    expect(files.map((f) => store.read(f))).toEqual(['first', 'second'])
  })
})

describe('multiple surfaces and sessions', () => {
  it('keeps each surface tracking its own plan file', () => {
    const other = asPtySessionId('surface-2')
    const { manager, store } = harness()
    store.write('/plans/a.md', 'plan A')
    store.write('/plans/b.md', 'plan B')

    manager.trackPlanFile(SURFACE, '/plans/a.md')
    manager.trackPlanFile(other, '/plans/b.md')

    const a = manager.snapshot(SURFACE, SESSION, 1000)
    const b = manager.snapshot(other, asClaudeSessionId('session-2'), 1000)

    expect(store.read(a[0])).toBe('plan A')
    expect(store.read(b[0])).toBe('plan B')
  })

  it('keeps version lists separate per claude session', () => {
    const otherSession = asClaudeSessionId('session-2')
    const { manager, store } = harness()
    store.write('/plans/plan.md', 'shared plan')
    manager.trackPlanFile(SURFACE, '/plans/plan.md')

    manager.snapshot(SURFACE, SESSION, 1000)
    manager.snapshot(SURFACE, otherSession, 1000)

    expect(manager.getVersions(SESSION)).toHaveLength(1)
    expect(manager.getVersions(otherSession)).toHaveLength(1)
    expect(manager.getVersions(SESSION)).not.toEqual(manager.getVersions(otherSession))
  })

  it('re-tracking a surface points later snapshots at the new file', () => {
    const { manager, store } = harness()
    store.write('/plans/old.md', 'old plan')
    store.write('/plans/new.md', 'new plan')

    manager.trackPlanFile(SURFACE, '/plans/old.md')
    manager.snapshot(SURFACE, SESSION, 1000)
    manager.trackPlanFile(SURFACE, '/plans/new.md')
    const files = manager.snapshot(SURFACE, SESSION, 2000)

    expect(files.map((f) => store.read(f))).toEqual(['old plan', 'new plan'])
  })
})

describe('getVersions', () => {
  it('mirrors what snapshot returned', () => {
    const { manager, store } = harness()
    store.write('/plans/plan.md', 'plan')
    manager.trackPlanFile(SURFACE, '/plans/plan.md')

    const files = manager.snapshot(SURFACE, SESSION, 1000)
    expect(manager.getVersions(SESSION)).toEqual(files)
  })
})
