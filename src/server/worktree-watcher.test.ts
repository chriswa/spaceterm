import { describe, it, expect } from 'vitest'
import { WorktreeWatcher, type WorktreeWatcherDeps } from './worktree-watcher'

interface FakeWatch {
  dir: string
  fire: () => void
  fail: (message?: string) => void
  closed: boolean
}

function harness(options: { unwatchable?: string[] } = {}) {
  const watches: FakeWatch[] = []
  const changes: string[] = []
  const unwatchable = new Set(options.unwatchable ?? [])

  const deps: WorktreeWatcherDeps = {
    watch(dir, onChange, onError) {
      if (unwatchable.has(dir)) throw new Error(`ENOENT: ${dir}`)
      const entry: FakeWatch = {
        dir,
        fire: onChange,
        fail: (message = 'watch died') => onError(new Error(message)),
        closed: false,
      }
      watches.push(entry)
      return () => { entry.closed = true }
    },
  }

  const watcher = new WorktreeWatcher((dir) => changes.push(dir), deps)
  return {
    watcher,
    changes,
    /** Live (unclosed) watches, by directory. */
    live: () => watches.filter((w) => !w.closed).map((w) => w.dir),
    /** How many times a watch was armed for this directory, ever. */
    armings: (dir: string) => watches.filter((w) => w.dir === dir).length,
    find: (dir: string) => watches.filter((w) => w.dir === dir).at(-1)!,
    allow: (dir: string) => unwatchable.delete(dir),
  }
}

describe('sync', () => {
  it('arms a watch for each directory', () => {
    const h = harness()
    h.watcher.sync(new Set(['/a', '/b']))

    expect(h.live().sort()).toEqual(['/a', '/b'])
    expect(h.watcher.watched.sort()).toEqual(['/a', '/b'])
  })

  it('leaves an already-watched directory alone', () => {
    const h = harness()
    h.watcher.sync(new Set(['/a']))
    h.watcher.sync(new Set(['/a']))

    expect(h.armings('/a')).toBe(1)
  })

  it('closes the watch for a directory that has gone', () => {
    const h = harness()
    h.watcher.sync(new Set(['/a', '/b']))
    h.watcher.sync(new Set(['/a']))

    expect(h.live()).toEqual(['/a'])
    expect(h.find('/b').closed).toBe(true)
  })

  it('survives a directory that cannot be watched', () => {
    const h = harness({ unwatchable: ['/missing'] })
    h.watcher.sync(new Set(['/a', '/missing']))

    expect(h.watcher.watched).toEqual(['/a'])
  })

  it('retries a directory that could not be watched before', () => {
    const h = harness({ unwatchable: ['/later'] })
    h.watcher.sync(new Set(['/later']))
    expect(h.watcher.watched).toEqual([])

    h.allow('/later')
    h.watcher.sync(new Set(['/later']))

    expect(h.watcher.watched).toEqual(['/later'])
  })
})

describe('change reporting', () => {
  it('names the directory the change happened under', () => {
    const h = harness()
    h.watcher.sync(new Set(['/a', '/b']))

    h.find('/b').fire()

    expect(h.changes).toEqual(['/b'])
  })

  it('reports every event, leaving the throttling to the caller', () => {
    const h = harness()
    h.watcher.sync(new Set(['/a']))

    for (let i = 0; i < 5; i++) h.find('/a').fire()

    expect(h.changes).toHaveLength(5)
  })
})

describe('a watch that dies', () => {
  it('is re-armed by the next sync', () => {
    const h = harness()
    h.watcher.sync(new Set(['/a']))
    h.find('/a').fail()

    expect(h.watcher.watched).toEqual([])

    h.watcher.sync(new Set(['/a']))
    expect(h.watcher.watched).toEqual(['/a'])
    expect(h.armings('/a')).toBe(2)
  })
})

describe('dispose', () => {
  it('closes every watch', () => {
    const h = harness()
    h.watcher.sync(new Set(['/a', '/b']))

    h.watcher.dispose()

    expect(h.live()).toEqual([])
    expect(h.watcher.watched).toEqual([])
  })

  it('ignores an event that arrives after it', () => {
    const h = harness()
    h.watcher.sync(new Set(['/a']))
    const watch = h.find('/a')

    h.watcher.dispose()
    watch.fire()

    expect(h.changes).toEqual([])
  })

  it('arms nothing further', () => {
    const h = harness()
    h.watcher.dispose()
    h.watcher.sync(new Set(['/a']))

    expect(h.watcher.watched).toEqual([])
  })
})
