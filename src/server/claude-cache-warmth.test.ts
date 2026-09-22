import { describe, it, expect } from 'vitest'
import { readClaudeCacheTouch } from './claude-cache-warmth'
import type { SessionFileEntry } from './session-file-watcher'

const FIVE_MINUTES = 5 * 60_000
const HOUR = 60 * 60_000

const at = (iso: string) => new Date(iso).getTime()

/**
 * An assistant entry shaped like the real thing — the fields under test copied
 * from a Claude transcript, everything else left off.
 */
function assistant(
  timestamp: string,
  usage: { write5m?: number; write1h?: number; read?: number },
  extra: Record<string, unknown> = {},
): SessionFileEntry {
  return {
    type: 'assistant',
    timestamp,
    message: {
      model: 'claude-opus-5',
      usage: {
        input_tokens: 2,
        cache_creation_input_tokens: (usage.write5m ?? 0) + (usage.write1h ?? 0),
        cache_read_input_tokens: usage.read ?? 0,
        output_tokens: 111,
        cache_creation: {
          ephemeral_5m_input_tokens: usage.write5m ?? 0,
          ephemeral_1h_input_tokens: usage.write1h ?? 0,
        },
      },
    },
    ...extra,
  }
}

describe('readClaudeCacheTouch', () => {
  it('reads the TTL the request was cached at, rather than guessing one', () => {
    expect(readClaudeCacheTouch(assistant('2026-09-16T16:34:34.959Z', { write1h: 746, read: 184_272 })))
      .toEqual({ at: at('2026-09-16T16:34:34.959Z'), ttlMs: HOUR, tokens: 185_018 })
    expect(readClaudeCacheTouch(assistant('2026-09-10T21:51:07.618Z', { write5m: 3134, read: 530_961 })))
      .toEqual({ at: at('2026-09-10T21:51:07.618Z'), ttlMs: FIVE_MINUTES, tokens: 534_095 })
  })

  it('sizes the cache as everything in it, read back plus newly written', () => {
    // What a cold cache would make you pay for again — which is what ranks one
    // expiring session against another.
    const touch = readClaudeCacheTouch(assistant('2026-09-16T16:34:34.959Z', { write1h: 746, read: 184_272 }))
    expect(touch!.tokens).toBe(746 + 184_272)
  })

  it('reports a cache read with no write as a touch of unstated length', () => {
    // A hit refreshes the entry's lifetime, so the deadline moves; the request
    // just does not restate how long that lifetime is.
    expect(readClaudeCacheTouch(assistant('2026-09-12T01:25:28.633Z', { read: 835_381 })))
      .toEqual({ at: at('2026-09-12T01:25:28.633Z'), tokens: 835_381 })
  })

  it('ignores entries that neither wrote nor read a cache', () => {
    expect(readClaudeCacheTouch(assistant('2026-09-10T19:09:25.693Z', {}))).toBeNull()
    expect(readClaudeCacheTouch({ type: 'user', timestamp: '2026-09-16T16:34:00.000Z' })).toBeNull()
    expect(readClaudeCacheTouch({ type: 'summary' })).toBeNull()
  })

  it('ignores a subagent, whose cache is not the one the human is typing against', () => {
    const entry = assistant('2026-09-16T16:34:34.959Z', { write1h: 900, read: 1000 }, { isSidechain: true })
    expect(readClaudeCacheTouch(entry)).toBeNull()
  })

  it('ignores an entry whose timestamp cannot be placed in time', () => {
    expect(readClaudeCacheTouch(assistant('not a date', { write1h: 900 }))).toBeNull()
    const undated: SessionFileEntry = { type: 'assistant', message: { usage: { cache_read_input_tokens: 5 } } }
    expect(readClaudeCacheTouch(undated)).toBeNull()
  })
})
