import { describe, it, expect } from 'vitest'
import { loadThresholdHours } from './dimStaleStore'
import { DEFAULT_STALE_THRESHOLD_HOURS, STALE_THRESHOLD_HOUR_OPTIONS } from '../lib/dim-stale'

/**
 * The threshold is persisted as a string in `localStorage`, so what comes back
 * on the next launch is whatever was last written there — including nothing,
 * and including a value written by a build that offered a different range.
 * Reading it is the part worth pinning; the store around it is a setter.
 */
describe('dim-stale threshold persistence', () => {
  it('starts at the default when nothing is stored', () => {
    expect(loadThresholdHours(null)).toBe(DEFAULT_STALE_THRESHOLD_HOURS)
    expect(loadThresholdHours('')).toBe(DEFAULT_STALE_THRESHOLD_HOURS)
  })

  it('restores a stored choice', () => {
    expect(loadThresholdHours('3')).toBe(3)
  })

  it('answers junk with the default rather than never dimming', () => {
    // Number('nonsense') is NaN, and NaN fails every threshold comparison — so
    // an unguarded read would leave every node at full brightness with the lens on.
    expect(loadThresholdHours('nonsense')).toBe(DEFAULT_STALE_THRESHOLD_HOURS)
  })

  it('pulls an out-of-range value onto an offered option', () => {
    expect(STALE_THRESHOLD_HOUR_OPTIONS).toContain(loadThresholdHours('40'))
    expect(STALE_THRESHOLD_HOUR_OPTIONS).toContain(loadThresholdHours('0'))
  })
})
