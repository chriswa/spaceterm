import { describe, it, expect } from 'vitest'
import { ageText } from './UsageReadout'

describe('ageText', () => {
  it('reads at a glance', () => {
    expect(ageText(20_000)).toBe('moments')
    expect(ageText(4 * 60_000 + 59_000)).toBe('4m')
    expect(ageText(65 * 60_000)).toBe('1h 5m')
  })
})
