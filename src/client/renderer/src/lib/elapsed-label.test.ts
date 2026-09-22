import { describe, it, expect } from 'vitest'
import { formatCountdownShort, formatElapsedShort } from './elapsed-label'

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

describe('formatCountdownShort', () => {
  it('counts whole seconds up to half a minute, where an age would say "0m"', () => {
    expect(formatCountdownShort(0)).toBe('0s')
    expect(formatCountdownShort(22 * SECOND)).toBe('22s')
    expect(formatCountdownShort(29 * SECOND)).toBe('29s')
  })

  it('takes the seconds rung at the same half-unit boundary as every other', () => {
    expect(formatCountdownShort(31 * SECOND)).toBe('1m')
    expect(formatCountdownShort(89 * SECOND)).toBe('1m')
    expect(formatCountdownShort(91 * SECOND)).toBe('2m')
  })

  it('is the elapsed ladder from a minute up', () => {
    for (const ms of [MINUTE, 3 * MINUTE + 40 * SECOND, HOUR - 1, HOUR, 25 * HOUR]) {
      expect(formatCountdownShort(ms)).toBe(formatElapsedShort(ms))
    }
  })

  it('holds a refreshed cache steady instead of flickering off its own boundary', () => {
    // The reason this rounds rather than truncates. An agent working in a
    // surface refreshes its cache every message, so the countdown is repeatedly
    // set to just under a whole hour — which truncation renders as `59m` while
    // the untouched cache next to it reads `1h`.
    for (let ms = HOUR; ms > HOUR - 30 * SECOND; ms -= SECOND) {
      expect(formatCountdownShort(ms), `${ms}ms should still read as an hour`).toBe('1h')
    }
    expect(formatCountdownShort(59 * MINUTE + 30 * SECOND)).toBe('1h')
    expect(formatCountdownShort(59 * MINUTE + 29 * SECOND)).toBe('59m')
  })

  it('only ever shows one unit', () => {
    for (const ms of [9 * SECOND, 90 * MINUTE, 25 * HOUR]) {
      expect(formatCountdownShort(ms)).toMatch(/^\d+[smhd]$/)
    }
  })
})
