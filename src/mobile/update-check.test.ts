import { describe, it, expect } from 'vitest'
import { staleness } from './update-check'

describe('staleness', () => {
  it('a page built before the latest build needs a reload', () => {
    expect(staleness({ web: 'a' }, { web: 'b', native: 'n' })).toEqual({ web: true, native: false })
  })

  it('an app installed before its source changed needs reinstalling', () => {
    expect(staleness({ web: 'a', native: 'old' }, { web: 'a', native: 'new' })).toEqual({ web: false, native: true })
  })

  it('what cannot be known is never behind: a browser has no native version, an old build no id', () => {
    expect(staleness({}, { web: 'b', native: 'n' })).toEqual({ web: false, native: false })
    expect(staleness({ web: 'a', native: 'x' }, {})).toEqual({ web: false, native: false })
  })
})
