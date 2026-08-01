import { describe, it, expect } from 'vitest'
import {
  FileContentManager,
  type CancelScheduled,
  type FileContentIO,
  type FileWatchHandle
} from './file-content-manager'
import { asNodeId } from '../shared/ids'
import type { NodeId } from '../shared/ids'

const MD = asNodeId('markdown-1')
const FILE = asNodeId('file-1')
const DEBOUNCE_MS = 100

/**
 * In-memory filesystem with explicit change notification and a manual clock.
 *
 * `fs.watch`'s event timing is platform-specific and its coalescing is not
 * something a test should depend on, so the fake drives changes explicitly:
 * a test says "the file changed on disk" and then advances the clock.
 */
class FakeFs implements FileContentIO {
  readonly files = new Map<string, string>()
  readonly writes: Array<{ path: string; content: string }> = []
  /** Set to make the next write throw. */
  failNextWrite = false
  /** Paths that cannot be watched at all. */
  readonly unwatchable = new Set<string>()

  // A path can carry several independent watches, as fs.watch allows.
  private handlers: Array<{ path: string; onChange: () => void; onError: () => void }> = []
  private timers: Array<{ fn: () => void; dueAt: number; cancelled: boolean }> = []
  private now = 0

  /** Paths that currently have at least one live watch. */
  get watched(): Set<string> {
    return new Set(this.handlers.map((h) => h.path))
  }

  readFile(filePath: string): string | undefined {
    return this.files.get(filePath)
  }

  writeFile(filePath: string, content: string): void {
    if (this.failNextWrite) {
      this.failNextWrite = false
      throw new Error('disk full')
    }
    this.files.set(filePath, content)
    this.writes.push({ path: filePath, content })
  }

  watch(filePath: string, onChange: () => void, onError: () => void): FileWatchHandle | null {
    if (this.unwatchable.has(filePath)) return null
    const handler = { path: filePath, onChange, onError }
    this.handlers.push(handler)
    return {
      close: () => {
        this.handlers = this.handlers.filter((h) => h !== handler)
      }
    }
  }

  private fire(filePath: string, which: 'onChange' | 'onError'): void {
    for (const h of this.handlers.filter((h) => h.path === filePath)) h[which]()
  }

  scheduleTimeout(fn: () => void, ms: number): CancelScheduled {
    const entry = { fn, dueAt: this.now + ms, cancelled: false }
    this.timers.push(entry)
    return () => { entry.cancelled = true }
  }

  /** Someone else edited the file. Fires the watch, if any. */
  externalEdit(filePath: string, content: string): void {
    this.files.set(filePath, content)
    this.fire(filePath, 'onChange')
  }

  /** Fire the watch without changing content — editors do this on save. */
  touch(filePath: string): void {
    this.fire(filePath, 'onChange')
  }

  /** The file went away and the watch died with it. */
  deleteAndFailWatch(filePath: string): void {
    this.files.delete(filePath)
    this.fire(filePath, 'onError')
  }

  advance(ms: number): void {
    this.now += ms
    const due = this.timers.filter((t) => !t.cancelled && t.dueAt <= this.now)
    this.timers = this.timers.filter((t) => !t.cancelled && t.dueAt > this.now)
    for (const t of due) t.fn()
  }

  get armedTimers(): number {
    return this.timers.filter((t) => !t.cancelled).length
  }
}

interface Harness {
  manager: FileContentManager
  fs: FakeFs
  broadcasts: Array<{ nodeId: NodeId; content: string }>
}

function harness(seed: Record<string, string> = {}): Harness {
  const fs = new FakeFs()
  for (const [p, c] of Object.entries(seed)) fs.files.set(p, c)
  const broadcasts: Harness['broadcasts'] = []
  const manager = new FileContentManager(
    (nodeId, content) => broadcasts.push({ nodeId, content }),
    fs
  )
  return { manager, fs, broadcasts }
}

describe('startWatching', () => {
  it('broadcasts the file content and starts a watch', () => {
    const h = harness({ '/notes.md': 'hello' })
    h.manager.startWatching(MD, FILE, '/notes.md')

    expect(h.broadcasts).toEqual([{ nodeId: MD, content: 'hello' }])
    expect(h.fs.watched.has('/notes.md')).toBe(true)
    expect(h.manager.isWatched(MD)).toBe(true)
  })

  it('creates the file when it does not exist, and broadcasts empty', () => {
    const h = harness()
    h.manager.startWatching(MD, FILE, '/new.md')

    expect(h.fs.readFile('/new.md')).toBe('')
    expect(h.broadcasts).toEqual([{ nodeId: MD, content: '' }])
  })

  it('does not register the node when the file cannot be created', () => {
    const h = harness()
    h.fs.failNextWrite = true

    h.manager.startWatching(MD, FILE, '/readonly/new.md')

    expect(h.manager.isWatched(MD)).toBe(false)
    expect(h.broadcasts).toEqual([])
  })

  it('still syncs content when the path cannot be watched', () => {
    // No live updates, but the card should not come up blank.
    const h = harness({ '/notes.md': 'contents' })
    h.fs.unwatchable.add('/notes.md')

    h.manager.startWatching(MD, FILE, '/notes.md')

    expect(h.broadcasts).toEqual([{ nodeId: MD, content: 'contents' }])
    expect(h.manager.isWatched(MD)).toBe(true)
  })

  it('replaces an existing watch for the same node', () => {
    const h = harness({ '/a.md': 'a', '/b.md': 'b' })
    h.manager.startWatching(MD, FILE, '/a.md')
    h.manager.startWatching(MD, FILE, '/b.md')

    expect(h.fs.watched.has('/a.md')).toBe(false)
    expect(h.fs.watched.has('/b.md')).toBe(true)
  })
})

describe('external edits', () => {
  it('broadcasts after the debounce', () => {
    const h = harness({ '/notes.md': 'v1' })
    h.manager.startWatching(MD, FILE, '/notes.md')
    h.broadcasts.length = 0

    h.fs.externalEdit('/notes.md', 'v2')
    expect(h.broadcasts).toEqual([])

    h.fs.advance(DEBOUNCE_MS)
    expect(h.broadcasts).toEqual([{ nodeId: MD, content: 'v2' }])
  })

  it('coalesces a burst of events into one broadcast', () => {
    // A single editor save typically produces several filesystem events.
    const h = harness({ '/notes.md': 'v1' })
    h.manager.startWatching(MD, FILE, '/notes.md')
    h.broadcasts.length = 0

    for (let i = 0; i < 5; i++) {
      h.fs.externalEdit('/notes.md', `v${i}`)
      h.fs.advance(10)
    }
    h.fs.advance(DEBOUNCE_MS)

    expect(h.broadcasts).toEqual([{ nodeId: MD, content: 'v4' }])
  })

  it('ignores an event for a file that has since been deleted', () => {
    const h = harness({ '/notes.md': 'v1' })
    h.manager.startWatching(MD, FILE, '/notes.md')
    h.broadcasts.length = 0

    h.fs.touch('/notes.md')
    h.fs.files.delete('/notes.md')
    h.fs.advance(DEBOUNCE_MS)

    expect(h.broadcasts).toEqual([])
  })

  it('drops the watch when the watch itself errors', () => {
    const h = harness({ '/notes.md': 'v1' })
    h.manager.startWatching(MD, FILE, '/notes.md')

    h.fs.deleteAndFailWatch('/notes.md')

    expect(h.fs.watched.has('/notes.md')).toBe(false)
    // The node stays registered — the path may come back.
    expect(h.manager.isWatched(MD)).toBe(true)
  })
})

describe('echo suppression', () => {
  it('does not re-broadcast our own write when the watch fires', () => {
    const h = harness({ '/notes.md': 'v1' })
    h.manager.startWatching(MD, FILE, '/notes.md')
    h.broadcasts.length = 0

    h.manager.writeContent(MD, 'from the editor')
    expect(h.broadcasts).toEqual([{ nodeId: MD, content: 'from the editor' }])

    // The write we just made trips the watcher.
    h.fs.touch('/notes.md')
    h.fs.advance(DEBOUNCE_MS)

    expect(h.broadcasts).toHaveLength(1)
  })

  it('suppresses only once — a later external edit still comes through', () => {
    const h = harness({ '/notes.md': 'v1' })
    h.manager.startWatching(MD, FILE, '/notes.md')
    h.manager.writeContent(MD, 'ours')
    h.fs.touch('/notes.md')
    h.fs.advance(DEBOUNCE_MS)
    h.broadcasts.length = 0

    h.fs.externalEdit('/notes.md', 'theirs')
    h.fs.advance(DEBOUNCE_MS)

    expect(h.broadcasts).toEqual([{ nodeId: MD, content: 'theirs' }])
  })

  it('does not suppress an external edit that lands before our echo', () => {
    const h = harness({ '/notes.md': 'v1' })
    h.manager.startWatching(MD, FILE, '/notes.md')
    h.manager.writeContent(MD, 'ours')
    h.broadcasts.length = 0

    // Someone else's change arrives instead of our own echo.
    h.fs.externalEdit('/notes.md', 'theirs')
    h.fs.advance(DEBOUNCE_MS)

    expect(h.broadcasts).toEqual([{ nodeId: MD, content: 'theirs' }])
  })
})

describe('writeContent', () => {
  it('writes the file and broadcasts', () => {
    const h = harness({ '/notes.md': 'v1' })
    h.manager.startWatching(MD, FILE, '/notes.md')
    h.broadcasts.length = 0

    h.manager.writeContent(MD, 'new body')

    expect(h.fs.readFile('/notes.md')).toBe('new body')
    expect(h.broadcasts).toEqual([{ nodeId: MD, content: 'new body' }])
  })

  it('does not broadcast when the write fails', () => {
    const h = harness({ '/notes.md': 'v1' })
    h.manager.startWatching(MD, FILE, '/notes.md')
    h.broadcasts.length = 0
    h.fs.failNextWrite = true

    h.manager.writeContent(MD, 'never lands')

    expect(h.broadcasts).toEqual([])
  })

  it('re-arms echo suppression after a failed write', () => {
    // A failed write means nothing hit disk, so the next event is genuinely
    // external and must not be swallowed.
    const h = harness({ '/notes.md': 'v1' })
    h.manager.startWatching(MD, FILE, '/notes.md')
    h.fs.failNextWrite = true
    h.manager.writeContent(MD, 'never lands')
    h.broadcasts.length = 0

    h.fs.externalEdit('/notes.md', 'never lands')
    h.fs.advance(DEBOUNCE_MS)

    expect(h.broadcasts).toEqual([{ nodeId: MD, content: 'never lands' }])
  })

  it('ignores an unwatched node', () => {
    const h = harness()
    h.manager.writeContent(MD, 'nothing')

    expect(h.fs.writes).toEqual([])
    expect(h.broadcasts).toEqual([])
  })
})

describe('stopWatching', () => {
  it('closes the watch and forgets the node', () => {
    const h = harness({ '/notes.md': 'v1' })
    h.manager.startWatching(MD, FILE, '/notes.md')

    h.manager.stopWatching(MD)

    expect(h.fs.watched.has('/notes.md')).toBe(false)
    expect(h.manager.isWatched(MD)).toBe(false)
  })

  it('cancels a debounce already in flight', () => {
    // The debounce cancel used to be unreachable: it was declared on the entry,
    // cleared here, and only ever assigned to a local inside the watcher.
    const h = harness({ '/notes.md': 'v1' })
    h.manager.startWatching(MD, FILE, '/notes.md')
    h.broadcasts.length = 0

    h.fs.externalEdit('/notes.md', 'v2')
    h.manager.stopWatching(MD)
    h.fs.advance(DEBOUNCE_MS * 2)

    expect(h.broadcasts).toEqual([])
    expect(h.fs.armedTimers).toBe(0)
  })

  it('tolerates an unwatched node', () => {
    const h = harness()
    expect(() => h.manager.stopWatching(MD)).not.toThrow()
  })
})

describe('updatePath', () => {
  it('moves the watch and broadcasts the new file', () => {
    const h = harness({ '/old.md': 'old body', '/new.md': 'new body' })
    h.manager.startWatching(MD, FILE, '/old.md')
    h.broadcasts.length = 0

    h.manager.updatePath(MD, FILE, '/new.md')

    expect(h.fs.watched.has('/old.md')).toBe(false)
    expect(h.fs.watched.has('/new.md')).toBe(true)
    expect(h.broadcasts).toEqual([{ nodeId: MD, content: 'new body' }])
  })

  it('does not deliver the old file content after the switch', () => {
    // The visible symptom of the unreachable debounce cancel: repoint a file
    // card while its old file is being edited, and the markdown flashed back to
    // the old file's content a moment later.
    const h = harness({ '/old.md': 'old body', '/new.md': 'new body' })
    h.manager.startWatching(MD, FILE, '/old.md')

    h.fs.externalEdit('/old.md', 'old body edited')
    h.manager.updatePath(MD, FILE, '/new.md')
    h.broadcasts.length = 0
    h.fs.advance(DEBOUNCE_MS * 2)

    expect(h.broadcasts).toEqual([])
  })

  it('ignores an unwatched node rather than starting a new watch', () => {
    const h = harness({ '/new.md': 'body' })
    h.manager.updatePath(MD, FILE, '/new.md')

    expect(h.manager.isWatched(MD)).toBe(false)
    expect(h.fs.watched.has('/new.md')).toBe(false)
  })
})

describe('getContent', () => {
  it('reads through to the file, not a cached copy', () => {
    const h = harness({ '/notes.md': 'v1' })
    h.manager.startWatching(MD, FILE, '/notes.md')

    h.fs.files.set('/notes.md', 'changed underneath')
    expect(h.manager.getContent(MD)).toBe('changed underneath')
  })

  it('returns null for an unwatched node', () => {
    expect(harness().manager.getContent(MD)).toBeNull()
  })

  it('returns null when the file has been deleted', () => {
    const h = harness({ '/notes.md': 'v1' })
    h.manager.startWatching(MD, FILE, '/notes.md')
    h.fs.files.delete('/notes.md')

    expect(h.manager.getContent(MD)).toBeNull()
  })
})

describe('multiple nodes', () => {
  const other = asNodeId('markdown-2')

  it('watches each independently', () => {
    const h = harness({ '/a.md': 'a', '/b.md': 'b' })
    h.manager.startWatching(MD, FILE, '/a.md')
    h.manager.startWatching(other, FILE, '/b.md')
    h.broadcasts.length = 0

    h.fs.externalEdit('/b.md', 'b2')
    h.fs.advance(DEBOUNCE_MS)

    expect(h.broadcasts).toEqual([{ nodeId: other, content: 'b2' }])
  })

  it('enumerates every watched node', () => {
    const h = harness({ '/a.md': 'a', '/b.md': 'b' })
    h.manager.startWatching(MD, FILE, '/a.md')
    h.manager.startWatching(other, FILE, '/b.md')

    expect(h.manager.getWatchedNodeIds().sort()).toEqual([MD, other].sort())
  })

  it('two nodes can share one file', () => {
    const h = harness({ '/shared.md': 'v1' })
    h.manager.startWatching(MD, FILE, '/shared.md')
    h.manager.startWatching(other, FILE, '/shared.md')
    h.broadcasts.length = 0

    h.fs.externalEdit('/shared.md', 'v2')
    h.fs.advance(DEBOUNCE_MS)

    expect(h.broadcasts.map((b) => b.nodeId).sort()).toEqual([MD, other].sort())
  })
})

describe('dispose', () => {
  it('closes every watch', () => {
    const other = asNodeId('markdown-2')
    const h = harness({ '/a.md': 'a', '/b.md': 'b' })
    h.manager.startWatching(MD, FILE, '/a.md')
    h.manager.startWatching(other, FILE, '/b.md')

    h.manager.dispose()

    expect(h.fs.watched.size).toBe(0)
    expect(h.manager.getWatchedNodeIds()).toEqual([])
  })

  it('leaves no debounce armed', () => {
    const h = harness({ '/a.md': 'a' })
    h.manager.startWatching(MD, FILE, '/a.md')
    h.fs.externalEdit('/a.md', 'a2')

    h.manager.dispose()
    h.fs.advance(DEBOUNCE_MS * 2)

    expect(h.fs.armedTimers).toBe(0)
  })

  it('is safe to call twice', () => {
    const h = harness({ '/a.md': 'a' })
    h.manager.startWatching(MD, FILE, '/a.md')
    h.manager.dispose()

    expect(() => h.manager.dispose()).not.toThrow()
  })
})
