import { describe, it, expect } from 'vitest'
import { ageText, remainingText } from './UsageReadout'

describe('ageText', () => {
  it('reads at a glance', () => {
    expect(ageText(20_000)).toBe('moments')
    expect(ageText(4 * 60_000 + 59_000)).toBe('4m')
    expect(ageText(65 * 60_000)).toBe('1h 5m')
  })
})

describe('remainingText', () => {
  it('is the largest whole unit, with minutes rounded up so a window never reads as over early', () => {
    expect(remainingText(-1)).toBe('now')
    expect(remainingText(30_000)).toBe('1m')
    expect(remainingText(45 * 60_000)).toBe('45m')
    expect(remainingText(3 * 3_600_000)).toBe('3h')
    expect(remainingText((4 * 60 + 35) * 60_000)).toBe('4h')
    expect(remainingText((28 * 60 + 10) * 60_000)).toBe('1d')
    expect(remainingText(28 * 86_400_000 + 3_600_000)).toBe('28d')
  })
})
