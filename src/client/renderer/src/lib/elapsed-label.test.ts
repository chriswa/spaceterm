import { describe, it, expect } from 'vitest'
import { formatElapsedShort } from './elapsed-label'

const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

describe('formatElapsedShort', () => {
  it('says "0m" for anything under a minute', () => {
    expect(formatElapsedShort(0)).toBe('0m')
    expect(formatElapsedShort(3 * SECOND)).toBe('0m')
    expect(formatElapsedShort(MINUTE - 1)).toBe('0m')
  })

  it('reads a future timestamp as "0m" rather than a negative span', () => {
    expect(formatElapsedShort(-5 * MINUTE)).toBe('0m')
  })

  it('counts whole minutes up to the hour', () => {
    expect(formatElapsedShort(MINUTE)).toBe('1m')
    expect(formatElapsedShort(3 * MINUTE + 59 * SECOND)).toBe('3m')
    expect(formatElapsedShort(HOUR - 1)).toBe('59m')
  })

  it('counts whole hours up to the day, without rounding up', () => {
    expect(formatElapsedShort(HOUR)).toBe('1h')
    expect(formatElapsedShort(HOUR + 59 * MINUTE)).toBe('1h')
    expect(formatElapsedShort(2 * HOUR)).toBe('2h')
    expect(formatElapsedShort(DAY - 1)).toBe('23h')
  })

  it('counts days from there on, and never reaches for a larger unit', () => {
    expect(formatElapsedShort(DAY)).toBe('1d')
    expect(formatElapsedShort(DAY + 23 * HOUR)).toBe('1d')
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
