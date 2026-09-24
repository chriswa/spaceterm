import { describe, it, expect } from 'vitest'
import { formatCountdownClock, formatCountdownMinutes, formatElapsedShort } from './elapsed-label'

const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

describe('formatElapsedShort', () => {
  it('says "0m" for anything under half a minute, rather than ticking off seconds', () => {
    expect(formatElapsedShort(0)).toBe('0m')
    expect(formatElapsedShort(3 * SECOND)).toBe('0m')
    expect(formatElapsedShort(29 * SECOND)).toBe('0m')
  })

  it('reads a future timestamp as "0m" rather than a negative span', () => {
    expect(formatElapsedShort(-5 * MINUTE)).toBe('0m')
  })

  it('rounds to the nearest minute up to the hour', () => {
    expect(formatElapsedShort(31 * SECOND)).toBe('1m')
    expect(formatElapsedShort(MINUTE)).toBe('1m')
    expect(formatElapsedShort(3 * MINUTE + 20 * SECOND)).toBe('3m')
    expect(formatElapsedShort(3 * MINUTE + 40 * SECOND)).toBe('4m')
    expect(formatElapsedShort(59 * MINUTE + 20 * SECOND)).toBe('59m')
  })

  it('rounds to the nearest hour up to the day', () => {
    expect(formatElapsedShort(HOUR)).toBe('1h')
    expect(formatElapsedShort(HOUR + 20 * MINUTE)).toBe('1h')
    expect(formatElapsedShort(HOUR + 40 * MINUTE)).toBe('2h')
    expect(formatElapsedShort(23 * HOUR + 20 * MINUTE)).toBe('23h')
  })

  it('carries a round-up across a unit boundary instead of printing "60m"', () => {
    // 59m40s rounds to 60 minutes, which is not a minutes answer, so it rounds
    // again and comes out as the hour it is.
    expect(formatElapsedShort(59 * MINUTE + 40 * SECOND)).toBe('1h')
    expect(formatElapsedShort(HOUR - 1)).toBe('1h')
    expect(formatElapsedShort(23 * HOUR + 40 * MINUTE)).toBe('1d')
    expect(formatElapsedShort(DAY - 1)).toBe('1d')
  })

  it('counts days from there on, and never reaches for a larger unit', () => {
    expect(formatElapsedShort(DAY)).toBe('1d')
    expect(formatElapsedShort(DAY + 2 * HOUR)).toBe('1d')
    expect(formatElapsedShort(9 * DAY)).toBe('9d')
    // No weeks, months or years: a long-quiet surface just keeps counting.
    expect(formatElapsedShort(400 * DAY)).toBe('400d')
  })

  it('only ever shows one unit', () => {
    for (const ms of [90 * MINUTE, 25 * HOUR, 8 * DAY + 3 * HOUR]) {
      expect(formatElapsedShort(ms)).toMatch(/^\d+[mhd]$/)
    }
  })
})

describe('formatCountdownClock', () => {
  it('writes minutes and zero-padded seconds', () => {
    expect(formatCountdownClock(4 * MINUTE + 32 * SECOND)).toBe('4:32')
    expect(formatCountdownClock(7 * SECOND)).toBe('0:07')
    expect(formatCountdownClock(58 * MINUTE)).toBe('58:00')
  })

  it('never rolls minutes into hours, so the width holds across the hour', () => {
    expect(formatCountdownClock(HOUR)).toBe('60:00')
    expect(formatCountdownClock(HOUR - SECOND)).toBe('59:59')
  })

  it('rounds seconds down, so a fresh hour against a lagging clock reads 60:00', () => {
    // `now` is quantised down to the second, so a just-refreshed deadline can
    // be up to a second more than an hour away.
    expect(formatCountdownClock(HOUR + 999)).toBe('60:00')
    expect(formatCountdownClock(4 * MINUTE + 32 * SECOND + 999)).toBe('4:32')
  })
})

describe('formatCountdownMinutes', () => {
  it('rounds to whole minutes', () => {
    expect(formatCountdownMinutes(4 * MINUTE + 29 * SECOND)).toBe('4m')
    expect(formatCountdownMinutes(4 * MINUTE + 30 * SECOND)).toBe('5m')
    expect(formatCountdownMinutes(HOUR)).toBe('60m')
  })

  it('never says 0m while the cache is still warm', () => {
    expect(formatCountdownMinutes(20 * SECOND)).toBe('1m')
    expect(formatCountdownMinutes(1)).toBe('1m')
  })
})
