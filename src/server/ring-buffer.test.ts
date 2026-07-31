import { describe, expect, it } from 'vitest'
import { RingBuffer, HISTORY_SLOTS } from './ring-buffer'

const MINUTE = 60_000
/** A round base time so slot boundaries in the tests are easy to reason about. */
const T0 = 1_800_000_000_000 - (1_800_000_000_000 % MINUTE)

function buffer(): RingBuffer {
  return new RingBuffer('test', MINUTE)
}

describe('RingBuffer', () => {
  it('builds an all-null series when nothing was recorded', () => {
    const series = buffer().build(T0)
    expect(series).toHaveLength(HISTORY_SLOTS)
    expect(series.every((v) => v === null)).toBe(true)
  })

  it('places a value recorded now in the last slot', () => {
    const b = buffer()
    b.record(42, T0)
    expect(b.build(T0).at(-1)).toBe(42)
  })

  it('orders the series oldest to newest', () => {
    const b = buffer()
    b.record(1, T0 - 2 * MINUTE)
    b.record(2, T0 - MINUTE)
    b.record(3, T0)
    expect(b.build(T0).slice(-3)).toEqual([1, 2, 3])
  })

  it('leaves gaps as null rather than carrying values forward', () => {
    const b = buffer()
    b.record(1, T0 - 2 * MINUTE)
    b.record(3, T0)
    expect(b.build(T0).slice(-3)).toEqual([1, null, 3])
  })

  it('overwrites within the same slot', () => {
    const b = buffer()
    b.record(1, T0)
    b.record(2, T0 + 1000) // same minute
    expect(b.build(T0).at(-1)).toBe(2)
  })

  it('keeps a value recorded at the oldest edge of the window', () => {
    const b = buffer()
    b.record(7, T0 - (HISTORY_SLOTS - 1) * MINUTE)
    expect(b.build(T0)[0]).toBe(7)
  })

  it('drops a value that has fallen out of the window', () => {
    const b = buffer()
    b.record(7, T0 - HISTORY_SLOTS * MINUTE)
    // The slot is physically reused by the current minute; the stored slotKey is
    // what prevents it being reported as current data.
    expect(b.build(T0).every((v) => v === null)).toBe(true)
  })

  it('does not report a stale value after a full wrap', () => {
    const b = buffer()
    b.record(99, T0)
    expect(b.build(T0 + HISTORY_SLOTS * MINUTE).every((v) => v === null)).toBe(true)
  })

  it('reports a future-dated slot as null', () => {
    const b = buffer()
    b.record(5, T0 + 10 * MINUTE)
    expect(b.build(T0).every((v) => v === null)).toBe(true)
  })

  it('handles negative slot keys without throwing', () => {
    const b = buffer()
    b.record(3, -5 * MINUTE)
    expect(b.build(-5 * MINUTE).at(-1)).toBe(3)
  })
})

describe('RingBuffer.seedFromLines', () => {
  const line = (t: number, used: number): string =>
    JSON.stringify({ timestamp: new Date(t).toISOString(), used })

  it('replays entries into their own slots', () => {
    const b = buffer()
    const recorded = b.seedFromLines(
      [line(T0 - 2 * MINUTE, 10), line(T0 - MINUTE, 20), line(T0, 30)],
      'used',
      T0,
    )
    expect(recorded).toBe(3)
    expect(b.build(T0).slice(-3)).toEqual([10, 20, 30])
  })

  it('skips entries older than the window', () => {
    const b = buffer()
    const recorded = b.seedFromLines([line(T0 - HISTORY_SLOTS * MINUTE, 10)], 'used', T0)
    expect(recorded).toBe(0)
  })

  it('skips malformed JSON without abandoning the rest', () => {
    const b = buffer()
    const recorded = b.seedFromLines(
      [line(T0 - MINUTE, 10), 'not json at all', line(T0, 30)],
      'used',
      T0,
    )
    expect(recorded).toBe(2)
    expect(b.build(T0).slice(-2)).toEqual([10, 30])
  })

  it('skips entries missing the value key', () => {
    const b = buffer()
    expect(b.seedFromLines([JSON.stringify({ timestamp: new Date(T0).toISOString() })], 'used', T0)).toBe(0)
  })

  it('skips entries whose value is not a number', () => {
    const b = buffer()
    const entry = JSON.stringify({ timestamp: new Date(T0).toISOString(), used: 'lots' })
    expect(b.seedFromLines([entry], 'used', T0)).toBe(0)
  })

  it('skips entries with no timestamp', () => {
    const b = buffer()
    expect(b.seedFromLines([JSON.stringify({ used: 5 })], 'used', T0)).toBe(0)
  })

  it('skips entries with an unparseable timestamp', () => {
    const b = buffer()
    expect(b.seedFromLines([JSON.stringify({ timestamp: 'never', used: 5 })], 'used', T0)).toBe(0)
  })

  it('reads the requested key, not the first numeric one', () => {
    const b = buffer()
    const entry = JSON.stringify({ timestamp: new Date(T0).toISOString(), other: 1, used: 42 })
    b.seedFromLines([entry], 'used', T0)
    expect(b.build(T0).at(-1)).toBe(42)
  })

  it('lets a later entry win within the same slot', () => {
    const b = buffer()
    b.seedFromLines([line(T0, 1), line(T0 + 1000, 2)], 'used', T0)
    expect(b.build(T0).at(-1)).toBe(2)
  })

  it('accepts an empty list', () => {
    expect(buffer().seedFromLines([], 'used', T0)).toBe(0)
  })
})
