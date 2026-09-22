import { describe, it, expect } from 'vitest'
import { CacheWarmthTracker, type CacheTouch } from './cache-warmth'
import type { SessionFileEntry } from './session-file-watcher'
import { asPtySessionId } from '../shared/ids'

const SURFACE = asPtySessionId('s1')
const OTHER = asPtySessionId('s2')
const MINUTE = 60_000

/**
 * The tracker's job is the fold, not the parsing, so these entries carry the
 * reading itself and the reader below just hands it back. What each agent's
 * transcript looks like is covered beside its own reader.
 */
const touch = (at: number, rest: Omit<CacheTouch, 'at'> = {}): SessionFileEntry =>
  ({ type: 'touch', at, ...rest })

const passthrough = new CacheWarmthTracker((_surfaceId, entry) =>
  entry.type === 'touch' ? (entry as unknown as CacheTouch) : null
)

const tracker = () => new CacheWarmthTracker((_s, e) => (e.type === 'touch' ? (e as unknown as CacheTouch) : null))

describe('CacheWarmthTracker', () => {
  it('projects the deadline from the newest request, not the oldest', () => {
    expect(tracker().observe(SURFACE, [
      touch(1_000, { ttlMs: 5 * MINUTE }),
      touch(2_000, { ttlMs: 5 * MINUTE }),
    ])).toEqual({ warmUntil: 2_000 + 5 * MINUTE, tokens: undefined })
  })

  it('takes the newest entry by timestamp, not by position in the batch', () => {
    // Parallel tool calls and retries land out of order.
    expect(tracker().observe(SURFACE, [
      touch(2_000, { ttlMs: 5 * MINUTE }),
      touch(1_000, { ttlMs: 60 * MINUTE }),
    ])).toEqual({ warmUntil: 2_000 + 5 * MINUTE, tokens: undefined })
  })

  it('follows a surface whose TTL changes partway through', () => {
    const t = tracker()
    expect(t.observe(SURFACE, [touch(1_000, { ttlMs: 60 * MINUTE })])!.warmUntil).toBe(1_000 + 60 * MINUTE)
    expect(t.observe(SURFACE, [touch(2_000, { ttlMs: 5 * MINUTE })])!.warmUntil).toBe(2_000 + 5 * MINUTE)
    expect(t.observe(SURFACE, [touch(3_000, { ttlMs: 60 * MINUTE })])!.warmUntil).toBe(3_000 + 60 * MINUTE)
  })

  it('carries the last stated TTL across a batch that only refreshed the cache', () => {
    const t = tracker()
    t.observe(SURFACE, [touch(1_000, { ttlMs: 5 * MINUTE })])
    expect(t.observe(SURFACE, [touch(2_000)])!.warmUntil).toBe(2_000 + 5 * MINUTE)
  })

  it('takes the newest stated TTL when a batch holds several', () => {
    const t = tracker()
    t.observe(SURFACE, [touch(2_000, { ttlMs: 5 * MINUTE }), touch(1_000, { ttlMs: 60 * MINUTE })])
    // The five-minute one was the newer, so it is what the next read inherits.
    expect(t.observe(SURFACE, [touch(3_000)])!.warmUntil).toBe(3_000 + 5 * MINUTE)
  })

  it('says nothing for a refresh on a surface it has never seen a lifetime for', () => {
    // The cache is warm, but for how much longer is genuinely unknown, and a
    // guess would be indistinguishable from a reading.
    expect(tracker().observe(SURFACE, [touch(1_000)])).toBeUndefined()
  })

  it('says nothing for a batch with no cache news, rather than withdrawing the old', () => {
    const t = tracker()
    t.observe(SURFACE, [touch(1_000, { ttlMs: 5 * MINUTE })])
    expect(t.observe(SURFACE, [{ type: 'user' }])).toBeUndefined()
    expect(t.observe(SURFACE, [])).toBeUndefined()
  })

  it('carries the newest entry’s token count alongside the deadline', () => {
    expect(tracker().observe(SURFACE, [
      touch(1_000, { ttlMs: 5 * MINUTE, tokens: 20_000 }),
      touch(2_000, { ttlMs: 5 * MINUTE, tokens: 185_000 }),
    ])).toEqual({ warmUntil: 2_000 + 5 * MINUTE, tokens: 185_000 })
  })

  it('forgets the remembered TTL on a backfill, which re-reads from the first line', () => {
    const t = tracker()
    t.observe(SURFACE, [touch(1_000, { ttlMs: 60 * MINUTE })])
    // A fresh watch on the same surface: the hour above belonged to the session
    // that came before, and must not colour this file's opening refresh.
    expect(t.observe(SURFACE, [touch(2_000)], { reset: true })).toBeUndefined()
  })

  it('keeps surfaces apart', () => {
    const t = tracker()
    t.observe(SURFACE, [touch(1_000, { ttlMs: 5 * MINUTE })])
    expect(t.observe(OTHER, [touch(2_000)])).toBeUndefined()

    t.observe(OTHER, [touch(3_000, { ttlMs: 60 * MINUTE })])
    expect(t.observe(SURFACE, [touch(4_000)])!.warmUntil).toBe(4_000 + 5 * MINUTE)
  })

  it('forgets a surface on request, so a reused id starts clean', () => {
    const t = tracker()
    t.observe(SURFACE, [touch(1_000, { ttlMs: 60 * MINUTE })])
    t.forget(SURFACE)
    expect(t.observe(SURFACE, [touch(2_000)])).toBeUndefined()
  })

  it('asks its reader for every entry, so an agent can track state across them', () => {
    // CodexCacheReader depends on this: the model arrives in one entry and the
    // usage in another, and it has to see both.
    const seen: string[] = []
    const t = new CacheWarmthTracker((_s, e) => {
      seen.push(e.type)
      return null
    })
    t.observe(SURFACE, [{ type: 'turn_context' }, { type: 'token_usage_record' }])
    expect(seen).toEqual(['turn_context', 'token_usage_record'])
  })

  it('passes the surface id to its reader', () => {
    const seen: string[] = []
    const t = new CacheWarmthTracker((surfaceId, _e) => {
      seen.push(surfaceId)
      return null
    })
    t.observe(SURFACE, [{ type: 'x' }])
    t.observe(OTHER, [{ type: 'x' }])
    expect(seen).toEqual([SURFACE, OTHER])
  })

  it('is unaffected by a reader that returns entries in file order', () => {
    expect(passthrough.observe(SURFACE, [touch(5_000, { ttlMs: MINUTE })])!.warmUntil).toBe(5_000 + MINUTE)
  })
})
