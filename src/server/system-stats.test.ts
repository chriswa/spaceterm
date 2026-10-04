import { describe, it, expect } from 'vitest'
import { systemStatsFrom, SystemStatsWatcher, POLL_MS, STALE_AFTER_MS, type SystemStatsDeps } from './system-stats'
import type { SystemStatsSnapshot } from '../shared/system-stats'

const WRITTEN_AT = Date.parse('2026-10-04T01:28:05Z')

/** Trimmed from a real ~/.mini-stats/menubar.json. */
const EXPORT = {
  version: 1,
  updatedAt: '2026-10-04T01:28:05Z',
  spacing: 2.5,
  widgets: [
    { kind: 'bars', module: 'CPU', width: 5, height: 18, box: true, label: 'CPU', bars: [[{ value: 0.409297052154195, color: '#007aff' }]] },
    { kind: 'bars', module: 'RAM', width: 5, height: 18, box: true, label: 'RAM', bars: [[{ value: 0.2338, color: '#ff9230' }]] },
    { kind: 'battery', module: 'Battery', width: 26, height: 14, level: 1, fill: '#ffffff', charger: 'plugged' }
  ]
}

describe('systemStatsFrom', () => {
  it('keeps the widgets in order, values rounded to what a phone can draw', () => {
    const snapshot = systemStatsFrom(EXPORT as never, WRITTEN_AT + 1_000)
    expect(snapshot?.spacing).toBe(2.5)
    expect(snapshot?.widgets.map((w) => w.module)).toEqual(['CPU', 'RAM', 'Battery'])
    expect(snapshot?.widgets[0]).toMatchObject({ kind: 'bars', bars: [[{ value: 0.41, color: '#007aff' }]] })
  })

  it('an export mini-stats stopped rewriting is no reading at all', () => {
    expect(systemStatsFrom(EXPORT as never, WRITTEN_AT + STALE_AFTER_MS + 1)).toBeNull()
  })

  it('drops widget kinds it does not know, and versions it does not', () => {
    const odd = { ...EXPORT, widgets: [...EXPORT.widgets, { kind: 'sparkline', module: 'Net' }] }
    expect(systemStatsFrom(odd as never, WRITTEN_AT)?.widgets).toHaveLength(3)
    expect(systemStatsFrom({ ...EXPORT, version: 2 } as never, WRITTEN_AT)).toBeNull()
  })
})

/** A file, a clock and a timer queue the test drives. */
function harness(file: string | null) {
  const state = { file, now: WRITTEN_AT, timers: [] as { fn: () => void; ms: number; cancelled: boolean }[], reads: 0 }
  const deps: SystemStatsDeps = {
    read: async () => { state.reads++; return state.file },
    now: () => state.now,
    schedule: (fn, ms) => {
      const t = { fn, ms, cancelled: false }
      state.timers.push(t)
      return () => { t.cancelled = true }
    }
  }
  const seen: (SystemStatsSnapshot | null)[] = []
  const watcher = new SystemStatsWatcher((s) => seen.push(s), deps)
  const live = () => state.timers.filter((t) => !t.cancelled)
  return { state, watcher, seen, live }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

describe('SystemStatsWatcher', () => {
  it('reads nothing until someone watches', async () => {
    const h = harness(JSON.stringify(EXPORT))
    await flush()
    expect(h.state.reads).toBe(0)
  })

  it('reads at once when watched, then every POLL_MS, telling only of changes', async () => {
    const h = harness(JSON.stringify(EXPORT))
    h.watcher.setWatched(true)
    await flush()
    expect(h.seen).toHaveLength(1)
    expect(h.live()).toEqual([expect.objectContaining({ ms: POLL_MS })])

    h.live()[0].fn()
    await flush()
    expect(h.state.reads).toBe(2)
    expect(h.seen).toHaveLength(1)
  })

  it('stops when no one watches, and forgets the reading so the next watcher gets a fresh one', async () => {
    const h = harness(JSON.stringify(EXPORT))
    h.watcher.setWatched(true)
    await flush()
    h.watcher.setWatched(false)
    expect(h.live()).toHaveLength(0)
    expect(h.watcher.current()).toBeNull()
  })

  it('a missing file is null, told once', async () => {
    const h = harness(JSON.stringify(EXPORT))
    h.watcher.setWatched(true)
    await flush()
    h.state.file = null
    h.live()[0].fn()
    await flush()
    h.live()[0].fn()
    await flush()
    expect(h.seen.map((s) => s === null)).toEqual([false, true])
  })
})
