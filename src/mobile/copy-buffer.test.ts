import { describe, it, expect } from 'vitest'
import { flattenBuffer } from './copy-buffer'

describe('flattenBuffer', () => {
  it('puts a link a TUI broke across indented rows back together', () => {
    const buffer = [
      '⏺ Open this:',
      '  https://example.com/oauth/authorize?client_id=abc',
      '  &redirect_uri=https%3A%2F%2Fexample.com',
      '  &state=xyz   ',
      '',
    ].join('\n')
    expect(flattenBuffer(buffer)).toContain('https://example.com/oauth/authorize?client_id=abc&redirect_uri=https%3A%2F%2Fexample.com&state=xyz')
  })

  it('has no line breaks', () => {
    expect(flattenBuffer('a\nb\n\nc')).toBe('abc')
  })
})
