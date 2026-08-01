import { describe, it, expect } from 'vitest'
import { SnapshotManager, SCROLLBACK_LINES, type CancelScheduled } from './snapshot-manager'
import { asPtySessionId } from '../shared/ids'
import type { SnapshotMessage } from '../shared/protocol'

const TICK_INTERVAL = 100

const sid = asPtySessionId

/** Manual tick driver, so the 10Hz snapshot loop costs no wall-clock. */
class FakeTicker {
  private fn: (() => void) | null = null
  intervalMs: number | null = null

  readonly schedule = (fn: () => void, ms: number): CancelScheduled => {
    this.fn = fn
    this.intervalMs = ms
    return () => { this.fn = null }
  }

  /** Run `count` ticks. */
  tick(count = 1): void {
    for (let i = 0; i < count; i++) this.fn?.()
  }

  get armed(): boolean {
    return this.fn !== null
  }
}

interface Harness {
  manager: SnapshotManager
  ticker: FakeTicker
  snapshots: SnapshotMessage[]
}

function harness(): Harness {
  const ticker = new FakeTicker()
  const snapshots: SnapshotMessage[] = []
  const manager = new SnapshotManager(
    (snapshot) => snapshots.push(snapshot),
    { scheduleInterval: ticker.schedule }
  )
  return { manager, ticker, snapshots }
}

/**
 * All text on a snapshot's rows, joined. Each row is an array of attribute
 * spans, so the characters have to be reassembled.
 */
function text(snapshot: SnapshotMessage): string {
  return snapshot.lines.map(rowText).join('\n')
}

function rowText(row: SnapshotMessage['lines'][number]): string {
  return row.map((span) => span.text).join('')
}

describe('tick scheduling', () => {
  it('runs at the snapshot interval', () => {
    const h = harness()
    expect(h.ticker.intervalMs).toBe(TICK_INTERVAL)
  })

  it('emits nothing while no session is dirty', () => {
    const h = harness()
    h.manager.addSession(sid('s1'), 80, 24)

    h.ticker.tick(5)
    expect(h.snapshots).toEqual([])
  })

  it('emits a snapshot for a session that received output', async () => {
    const h = harness()
    h.manager.addSession(sid('s1'), 80, 24)
    h.manager.write(sid('s1'), 'hello world')

    await h.manager.flushForTest()

    h.ticker.tick()

    expect(h.snapshots).toHaveLength(1)
    expect(h.snapshots[0].sessionId).toBe('s1')
    expect(text(h.snapshots[0])).toContain('hello world')
  })

  it('clears the dirty flag, so an idle session is not re-serialized', async () => {
    const h = harness()
    h.manager.addSession(sid('s1'), 80, 24)
    h.manager.write(sid('s1'), 'once')

    await h.manager.flushForTest()

    h.ticker.tick(5)
    expect(h.snapshots).toHaveLength(1)
  })

  it('snapshots one session per tick', async () => {
    const h = harness()
    h.manager.addSession(sid('s1'), 80, 24)
    h.manager.addSession(sid('s2'), 80, 24)
    h.manager.write(sid('s1'), 'a')
    h.manager.write(sid('s2'), 'b')

    await h.manager.flushForTest()

    h.ticker.tick()
    expect(h.snapshots).toHaveLength(1)

    h.ticker.tick()
    expect(h.snapshots).toHaveLength(2)
  })
})

describe('fairness', () => {
  it('round-robins between two continuously busy sessions', () => {
    const h = harness()
    h.manager.addSession(sid('s1'), 80, 24)
    h.manager.addSession(sid('s2'), 80, 24)

    // Both stay dirty throughout: neither may be starved.
    for (let i = 0; i < 6; i++) {
      h.manager.write(sid('s1'), 'a')
      h.manager.write(sid('s2'), 'b')
      h.ticker.tick()
    }

    const served = h.snapshots.map((s) => s.sessionId)
    expect(served.filter((id) => id === 's1').length).toBeGreaterThan(1)
    expect(served.filter((id) => id === 's2').length).toBeGreaterThan(1)
    // Perfectly alternating, since both are always dirty.
    expect(new Set(served.slice(0, 2)).size).toBe(2)
  })

  it('serves a newly added session before one already snapshotted', async () => {
    const h = harness()
    h.manager.addSession(sid('old'), 80, 24)
    h.manager.write(sid('old'), 'x')
    await h.manager.flushForTest()
    h.ticker.tick()

    h.manager.addSession(sid('new'), 80, 24)
    h.manager.write(sid('old'), 'y')
    h.manager.write(sid('new'), 'z')
    await h.manager.flushForTest()
    h.ticker.tick()

    expect(h.snapshots[1].sessionId).toBe('new')
  })
})

describe('session lifecycle', () => {
  it('ignores writes to an unknown session', () => {
    const h = harness()
    expect(() => h.manager.write(sid('ghost'), 'data')).not.toThrow()

    h.ticker.tick()
    expect(h.snapshots).toEqual([])
  })

  it('ignores resizes for an unknown session', () => {
    const h = harness()
    expect(() => h.manager.resize(sid('ghost'), 100, 40)).not.toThrow()
  })

  it('stops snapshotting a removed session', () => {
    const h = harness()
    h.manager.addSession(sid('s1'), 80, 24)
    h.manager.write(sid('s1'), 'hello')
    h.manager.removeSession(sid('s1'))

    h.ticker.tick(3)
    expect(h.snapshots).toEqual([])
  })

  it('tolerates removing a session that was never added', () => {
    const h = harness()
    expect(() => h.manager.removeSession(sid('ghost'))).not.toThrow()
  })

  it('re-adding a session id starts from a clean terminal', async () => {
    const h = harness()
    h.manager.addSession(sid('s1'), 80, 24)
    h.manager.write(sid('s1'), 'first incarnation')
    h.manager.removeSession(sid('s1'))

    h.manager.addSession(sid('s1'), 80, 24)
    h.manager.write(sid('s1'), 'second')
    await h.manager.flushForTest()
    h.ticker.tick()

    expect(text(h.snapshots[0])).toContain('second')
    expect(text(h.snapshots[0])).not.toContain('first incarnation')
  })
})

describe('resize', () => {
  it('reports the new dimensions and marks the session dirty', async () => {
    const h = harness()
    h.manager.addSession(sid('s1'), 80, 24)
    h.manager.resize(sid('s1'), 100, 40)

    await h.manager.flushForTest()

    h.ticker.tick()

    expect(h.snapshots[0]).toMatchObject({ cols: 100, rows: 40 })
  })
})

describe('snapshot content', () => {
  it('carries the cursor position', async () => {
    const h = harness()
    h.manager.addSession(sid('s1'), 80, 24)
    h.manager.write(sid('s1'), 'abc')
    await h.manager.flushForTest()
    h.ticker.tick()

    expect(h.snapshots[0].cursorX).toBe(3)
    expect(h.snapshots[0].cursorY).toBe(0)
  })

  it('preserves output across a newline', async () => {
    const h = harness()
    h.manager.addSession(sid('s1'), 80, 24)
    h.manager.write(sid('s1'), 'line one\r\nline two')
    await h.manager.flushForTest()
    h.ticker.tick()

    const body = text(h.snapshots[0])
    expect(body).toContain('line one')
    expect(body).toContain('line two')
  })

  it('records styling as attribute spans rather than inline escapes', async () => {
    const h = harness()
    h.manager.addSession(sid('s1'), 80, 24)
    h.manager.write(sid('s1'), '\x1b[31mred\x1b[0m plain')
    await h.manager.flushForTest()
    h.ticker.tick()

    const row = h.snapshots[0].lines.find((line) => rowText(line).includes('red'))
    // Styling is carried structurally, not as escape sequences in the text.
    expect(rowText(row!)).not.toContain('\x1b')
    expect(row!.length).toBeGreaterThan(1)
    expect(row![0].text).toBe('red')
  })

  it('captures the visible viewport, not the whole scrollback', async () => {
    const h = harness()
    h.manager.addSession(sid('s1'), 80, 24)
    // Far more output than fits on screen, and more than the buffer retains.
    for (let i = 0; i < SCROLLBACK_LINES + 200; i++) {
      h.manager.write(sid('s1'), `line-${i}\r\n`)
    }
    await h.manager.flushForTest()
    h.ticker.tick()

    const snapshot = h.snapshots[0]
    const body = text(snapshot)

    // One row per visible line — the scrollback lives in the emulator, and is
    // sent separately on attach.
    expect(snapshot.lines).toHaveLength(24)
    expect(body).toContain(`line-${SCROLLBACK_LINES + 199}`)
    expect(body).not.toContain('line-0 ')
  })
})

describe('dispose', () => {
  it('stops the tick', () => {
    const h = harness()
    h.manager.addSession(sid('s1'), 80, 24)
    h.manager.write(sid('s1'), 'hello')

    h.manager.dispose()
    expect(h.ticker.armed).toBe(false)

    h.ticker.tick(3)
    expect(h.snapshots).toEqual([])
  })

  it('is safe to call twice', () => {
    const h = harness()
    h.manager.dispose()
    expect(() => h.manager.dispose()).not.toThrow()
  })

  it('drops all sessions', async () => {
    const h = harness()
    h.manager.addSession(sid('s1'), 80, 24)
    h.manager.dispose()

    // A write after dispose must not resurrect anything.
    h.manager.write(sid('s1'), 'hello')
    await h.manager.flushForTest()
    h.ticker.tick()
    expect(h.snapshots).toEqual([])
  })
})
