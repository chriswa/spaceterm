import { describe, it, expect } from 'vitest'
import {
  projectUsage,
  utilizationColor,
  formatDelta,
  ONE_HOUR_MS,
  PROJECTION_MIN_ELAPSED_MS
} from './usage-format'

const NOW = new Date('2024-06-01T12:00:00Z').getTime()
/** A reset timestamp `ms` in the future, relative to NOW. */
const resetIn = (ms: number) => new Date(NOW + ms).toISOString()

describe('projectUsage', () => {
  it('extrapolates linearly to the end of the window', () => {
    // Half the window gone with 20% used projects to 40%.
    const pct = projectUsage(20, resetIn(ONE_HOUR_MS / 2), ONE_HOUR_MS, NOW)
    expect(pct).toBeCloseTo(40)
  })

  it('converges on the actual usage as the window runs out', () => {
    // With one millisecond left there is nothing to extrapolate: the
    // projection should be what has already been used, not a multiple of it.
    expect(projectUsage(37, resetIn(1), ONE_HOUR_MS, NOW)).toBeCloseTo(37, 3)
  })

  describe('declines to guess', () => {
    it('before enough of the window has elapsed', () => {
      // One minute in, a single request would project to a wild number; the
      // honest answer is no number at all.
      const justStarted = ONE_HOUR_MS - 60_000
      expect(projectUsage(5, resetIn(justStarted), ONE_HOUR_MS, NOW)).toBeNull()
    })

    it('until exactly the threshold, and answers from there on', () => {
      // The threshold is inclusive: elapsed === PROJECTION_MIN_ELAPSED_MS projects.
      const atThreshold = ONE_HOUR_MS - PROJECTION_MIN_ELAPSED_MS
      expect(projectUsage(5, resetIn(atThreshold + 1), ONE_HOUR_MS, NOW)).toBeNull()
      expect(projectUsage(5, resetIn(atThreshold), ONE_HOUR_MS, NOW)).not.toBeNull()
    })

    it('when the window has already expired', () => {
      expect(projectUsage(50, resetIn(0), ONE_HOUR_MS, NOW)).toBeNull()
      expect(projectUsage(50, resetIn(-60_000), ONE_HOUR_MS, NOW)).toBeNull()
    })

    it('when nothing has been used', () => {
      expect(projectUsage(0, resetIn(ONE_HOUR_MS / 2), ONE_HOUR_MS, NOW)).toBeNull()
    })

    it('on an unparseable reset timestamp', () => {
      // The value comes from GitHub's API; a shape change should blank the
      // projection, not throw inside a render.
      expect(projectUsage(50, 'not a date', ONE_HOUR_MS, NOW)).toBeNull()
      expect(projectUsage(50, '', ONE_HOUR_MS, NOW)).toBeNull()
    })
  })

  it('can project above 100%, which is the point of showing it', () => {
    const projected = projectUsage(60, resetIn(ONE_HOUR_MS / 2), ONE_HOUR_MS, NOW)
    expect(projected).toBeGreaterThan(100)
  })
})

describe('utilizationColor', () => {
  it('is white for the untroubled half', () => {
    expect(utilizationColor(0)).toBe('#ffffff')
    expect(utilizationColor(50)).toBe('#ffffff')
  })

  it('is red at and above the cap', () => {
    expect(utilizationColor(100)).toBe('#ff3b30')
    expect(utilizationColor(150)).toBe('#ff3b30')
  })

  it('warms monotonically — blue falls away, then green', () => {
    const blue = (c: string) => Number(c.match(/rgb\(\d+,\d+,(\d+)\)/)?.[1] ?? NaN)
    expect(blue(utilizationColor(55))).toBeGreaterThan(blue(utilizationColor(70)))

    const green = (c: string) => Number(c.match(/rgb\(\d+,(\d+),\d+\)/)?.[1] ?? NaN)
    expect(green(utilizationColor(80))).toBeGreaterThan(green(utilizationColor(95)))
  })

  it('has no discontinuity at the band boundaries', () => {
    // A visible colour jump at 75% would read as a threshold that does not exist.
    expect(utilizationColor(75)).toBe('rgb(255,255,0)')
    expect(utilizationColor(75.5)).toMatch(/^rgb\(255,25[0-9],0\)$/)
  })

  it('always produces a parseable colour', () => {
    for (let pct = 0; pct <= 100; pct += 0.5) {
      expect(utilizationColor(pct), `at ${pct}%`).toMatch(/^(#[0-9a-f]{6}|rgb\(\d+,\d+,\d+\))$/)
    }
  })
})

describe('formatDelta', () => {
  it('reports minutes under an hour', () => {
    expect(formatDelta(resetIn(45 * 60_000), NOW)).toBe('45m')
  })

  it('rounds up, so a live window never reads as expired', () => {
    // 30 seconds left is "1m", not "0m" — which would look like `now`.
    expect(formatDelta(resetIn(30_000), NOW)).toBe('1m')
  })

  it('reports whole hours without a stray 0m', () => {
    expect(formatDelta(resetIn(2 * ONE_HOUR_MS), NOW)).toBe('2h')
  })

  it('reports hours and minutes together', () => {
    expect(formatDelta(resetIn(ONE_HOUR_MS + 5 * 60_000), NOW)).toBe('1h 5m')
  })

  it('says "now" once the window has passed', () => {
    expect(formatDelta(resetIn(0), NOW)).toBe('now')
    expect(formatDelta(resetIn(-ONE_HOUR_MS), NOW)).toBe('now')
  })

  it('says "now" rather than NaN on an unparseable timestamp', () => {
    expect(formatDelta('not a date', NOW)).toBe('now')
  })

  it('crosses the hour boundary cleanly', () => {
    expect(formatDelta(resetIn(60 * 60_000), NOW)).toBe('1h')
    expect(formatDelta(resetIn(59 * 60_000), NOW)).toBe('59m')
  })
})
