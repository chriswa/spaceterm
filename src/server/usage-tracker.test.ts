import { describe, it, expect, vi } from 'vitest'
import { usageSnapshotFrom, nextPollDelay, UsageTracker, POLL_AFTER_READING_MS, STALE_RETRY_MS, FAILED_RETRY_MS } from './usage-tracker'

/** Trimmed from a real `AISpendTracker --json`. */
const REPORT = {
  generatedAt: '2026-10-02T17:24:06-07:00',
  providers: [{
    id: 'claude',
    name: 'Claude',
    updatedAt: '2026-10-02T17:21:08-07:00',
    windows: [
      { caption: '5-Hour', elapsedPercent: 40.4, modelScoped: false, usagePercent: 6 },
      { caption: '7-Day', elapsedPercent: 40.7, modelScoped: false, usagePercent: 24 },
      { caption: 'Fable 7-Day', elapsedPercent: 40.7, modelScoped: true, usagePercent: 29 }
    ]
  }],
  spend: { budgetUSD: 50, monthElapsedPercent: 5.6, monthToDateUSD: 0, percentOfBudget: 0 }
}
const READ_AT = Date.parse('2026-10-02T17:21:08-07:00')

describe('usageSnapshotFrom', () => {
  it('makes the tray bars: each window, scoped ones in their own palette, then spend', () => {
    const { bars, updatedAt } = usageSnapshotFrom(REPORT)
    expect(updatedAt).toBe(READ_AT)
    expect(bars.map((b) => [b.label, b.palette, b.startsGroup])).toEqual([
      ['Claude 5-Hour', 'claude', true],
      ['Claude 7-Day', 'claude', false],
      ['Claude Fable 7-Day', 'scoped', false],
      ['Spend $0', 'spend', true]
    ])
    expect(bars[1].usage).toBeCloseTo(0.24)
    expect(bars[1].time).toBeCloseTo(0.407)
  })

  it('a failed provider is one warning, not its stale windows', () => {
    const { bars } = usageSnapshotFrom({ providers: [{ ...REPORT.providers[0], error: 'HTTP 401' }] })
    expect(bars).toEqual([expect.objectContaining({ palette: 'claude', error: true, startsGroup: true })])
  })

  it('spend with no budget fills once anything is spent', () => {
    const { bars } = usageSnapshotFrom({ providers: [], spend: { monthToDateUSD: 3, monthElapsedPercent: 10 } })
    expect(bars[0].usage).toBe(1)
  })
})

describe('nextPollDelay', () => {
  const snapshot = usageSnapshotFrom(REPORT)

  it('waits until the newest reading is 5½ minutes old', () => {
    expect(nextPollDelay(snapshot, READ_AT + 60_000)).toBe(POLL_AFTER_READING_MS - 60_000)
  })

  it('checks back at a modest pace when the reading is already older than that', () => {
    expect(nextPollDelay(snapshot, READ_AT + 20 * 60_000)).toBe(STALE_RETRY_MS)
  })

  it('backs right off when the tracker cannot be read', () => {
    expect(nextPollDelay(null, READ_AT)).toBe(FAILED_RETRY_MS)
  })
})

describe('UsageTracker', () => {
  function tracker(reads: Array<string | null>, now: number) {
    const scheduled: number[] = []
    const onChange = vi.fn()
    const t = new UsageTracker(onChange, {
      read: async () => reads.shift() ?? null,
      now: () => now,
      schedule: (_fn, ms) => { scheduled.push(ms); return () => undefined }
    })
    return { t, onChange, scheduled }
  }

  it('reports a new reading once, and schedules from it', async () => {
    const json = JSON.stringify(REPORT)
    const { t, onChange, scheduled } = tracker([json, json], READ_AT + 30_000)
    await t.poll()
    await t.poll()
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(t.current()?.bars).toHaveLength(4)
    expect(scheduled).toEqual([POLL_AFTER_READING_MS - 30_000, POLL_AFTER_READING_MS - 30_000])
  })

  it('keeps the last good reading through a failed run', async () => {
    const { t, scheduled } = tracker([JSON.stringify(REPORT), 'not json'], READ_AT)
    await t.poll()
    await t.poll()
    expect(t.current()?.bars).toHaveLength(4)
    expect(scheduled[1]).toBe(FAILED_RETRY_MS)
  })
})
