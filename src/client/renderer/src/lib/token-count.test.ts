import { describe, it, expect } from 'vitest'
import { formatTokensShort } from './token-count'

describe('formatTokensShort', () => {
  it('writes a small count as itself', () => {
    expect(formatTokensShort(0)).toBe('0')
    expect(formatTokensShort(840)).toBe('840')
    expect(formatTokensShort(999)).toBe('999')
  })

  it('writes thousands with a k, to the nearest', () => {
    // Rounded rather than truncated, unlike the spans beside it: a size is a
    // magnitude compared against its neighbours, not a bound to rely on.
    expect(formatTokensShort(1_000)).toBe('1k')
    expect(formatTokensShort(20_000)).toBe('20k')
    expect(formatTokensShort(185_018)).toBe('185k')
    expect(formatTokensShort(185_800)).toBe('186k')
    expect(formatTokensShort(999_000)).toBe('999k')
  })

  it('writes millions with one decimal, so a big session is not flattened', () => {
    expect(formatTokensShort(1_000_000)).toBe('1.0M')
    expect(formatTokensShort(1_240_000)).toBe('1.2M')
    expect(formatTokensShort(3_000_000)).toBe('3.0M')
  })

  it('never runs longer than a caption can carry', () => {
    for (const n of [0, 999, 1_000, 185_018, 999_999, 1_240_000, 15_441_375]) {
      expect(formatTokensShort(n).length).toBeLessThanOrEqual(6)
    }
  })

  it('reads a nonsensical count as zero rather than printing NaN', () => {
    expect(formatTokensShort(NaN)).toBe('0')
    expect(formatTokensShort(-5)).toBe('0')
  })
})
