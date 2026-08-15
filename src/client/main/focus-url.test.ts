import { describe, it, expect } from 'vitest'
import { parseFocusUrl, FOCUS_URL_SCHEME } from './focus-url'

describe('parseFocusUrl', () => {
  it('extracts the id from the canonical form', () => {
    expect(parseFocusUrl(`${FOCUS_URL_SCHEME}://abc-123`)).toBe('abc-123')
  })

  it('tolerates the slash variants the OS and hand-written links produce', () => {
    // macOS normalises `scheme://x` to `scheme://x/` before handing it over.
    expect(parseFocusUrl(`${FOCUS_URL_SCHEME}://abc-123/`)).toBe('abc-123')
    expect(parseFocusUrl(`${FOCUS_URL_SCHEME}:///abc-123`)).toBe('abc-123')
    expect(parseFocusUrl(`${FOCUS_URL_SCHEME}:///abc-123//`)).toBe('abc-123')
  })

  it('percent-decodes the id', () => {
    expect(parseFocusUrl(`${FOCUS_URL_SCHEME}://a%20b`)).toBe('a b')
  })

  it('rejects other schemes', () => {
    expect(parseFocusUrl('https://example.com/abc')).toBeNull()
    expect(parseFocusUrl('spaceterm://abc')).toBeNull()
  })

  it('rejects a link with no id', () => {
    expect(parseFocusUrl(`${FOCUS_URL_SCHEME}://`)).toBeNull()
    expect(parseFocusUrl(`${FOCUS_URL_SCHEME}:///`)).toBeNull()
  })
})
