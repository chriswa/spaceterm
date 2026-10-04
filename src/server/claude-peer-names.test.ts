import { describe, expect, it } from 'vitest'
import { parsePeerNames } from './claude-peer-names'

const file = (fields: Record<string, unknown>): string => JSON.stringify({ pid: 1, kind: 'interactive', ...fields })

describe('parsePeerNames', () => {
  it('maps each session id to its messaging name', () => {
    const names = parsePeerNames([
      file({ sessionId: 'a', name: 'spaceterm-43' }),
      file({ sessionId: 'b', name: 'research-9d' }),
    ])
    expect(names.get('a')).toBe('spaceterm-43')
    expect(names.get('b')).toBe('research-9d')
  })

  it('keeps the newest file when a stale one names the same session', () => {
    const names = parsePeerNames([
      file({ sessionId: 'a', name: 'spaceterm-old', updatedAt: 100 }),
      file({ sessionId: 'a', name: 'spaceterm-new', updatedAt: 200 }),
      file({ sessionId: 'a', name: 'spaceterm-older', updatedAt: 50 }),
    ])
    expect(names.get('a')).toBe('spaceterm-new')
  })

  it('skips files it cannot use', () => {
    const names = parsePeerNames(['{not json', 'null', file({ sessionId: 'a' }), file({ name: 'x-1' }), file({ sessionId: 'b', name: '' })])
    expect(names.size).toBe(0)
  })
})
