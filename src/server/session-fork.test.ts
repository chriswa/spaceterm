import { describe, expect, it } from 'vitest'
import { computeForkName } from './session-fork'

/**
 * Fork names must not accumulate suffixes: forking a fork repeatedly would
 * otherwise produce "x (fork) (fork) (fork)".
 */
describe('computeForkName', () => {
  it('appends the suffix to a named surface', () => {
    expect(computeForkName('api server')).toBe('api server (fork)')
  })

  it('falls back for an unnamed surface', () => {
    expect(computeForkName(undefined)).toBe('Untitled (fork)')
  })

  it('falls back for a null name', () => {
    // renameNode stores `name || null`, so a cleared name arrives as null.
    expect(computeForkName(null)).toBe('Untitled (fork)')
  })

  it('falls back for an empty name', () => {
    expect(computeForkName('')).toBe('Untitled (fork)')
  })

  it('does not double-suffix an existing fork', () => {
    expect(computeForkName('api server (fork)')).toBe('api server (fork)')
  })

  it('does not double-suffix a capitalised existing fork', () => {
    expect(computeForkName('api server (Fork)')).toBe('api server (Fork)')
  })

  it('appends when the marker is present but not at the end', () => {
    expect(computeForkName('(fork) leftover')).toBe('(fork) leftover (fork)')
  })

  it('preserves surrounding whitespace in the source name', () => {
    expect(computeForkName('  spaced  ')).toBe('  spaced   (fork)')
  })
})
