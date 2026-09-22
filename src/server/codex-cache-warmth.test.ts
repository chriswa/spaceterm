import { describe, it, expect } from 'vitest'
import { CODEX_CACHE_TTL_MS, CodexCacheReader, codexCacheTtlMs } from './codex-cache-warmth'
import type { SessionFileEntry } from './session-file-watcher'
import { asPtySessionId } from '../shared/ids'

const SURFACE = asPtySessionId('s1')
const OTHER = asPtySessionId('s2')
const at = (iso: string) => new Date(iso).getTime()

/** A rollout entry naming the model for the turn, as Codex writes one. */
const turnContext = (model: string): SessionFileEntry =>
  ({ type: 'turn_context', timestamp: '2026-09-21T18:22:13.954Z', payload: { model, effort: 'medium' } })

/** A rollout usage record, fields copied from a real Codex rollout. */
const usageRecord = (timestamp: string, input: number, cached: number): SessionFileEntry => ({
  type: 'token_usage_record',
  timestamp,
  payload: {
    usage: {
      input_tokens: input,
      cached_input_tokens: cached,
      cache_write_input_tokens: 0,
      output_tokens: 286,
      total_tokens: input + 286,
    },
  },
})

describe('codexCacheTtlMs', () => {
  it('gives GPT-5.6 and later OpenAI’s documented thirty-minute floor', () => {
    expect(codexCacheTtlMs('gpt-5.6-terra')).toBe(CODEX_CACHE_TTL_MS)
    expect(codexCacheTtlMs('gpt-5.6')).toBe(CODEX_CACHE_TTL_MS)
    expect(codexCacheTtlMs('gpt-5.7-whatever')).toBe(CODEX_CACHE_TTL_MS)
    // Compared as a version, so a later model inherits the rule rather than
    // silently losing its countdown.
    expect(codexCacheTtlMs('gpt-6')).toBe(CODEX_CACHE_TTL_MS)
    expect(codexCacheTtlMs('gpt-10.1')).toBe(CODEX_CACHE_TTL_MS)
  })

  it('gives earlier models nothing, since their lifetime spans minutes to a day', () => {
    // Pre-5.6 depends on `prompt_cache_retention`, which Codex does not record:
    // 5–10 minutes under in_memory, up to 24 hours under 24h. No countdown
    // beats one that could be wrong by a factor of a hundred.
    expect(codexCacheTtlMs('gpt-5.5')).toBeUndefined()
    expect(codexCacheTtlMs('gpt-4.1')).toBeUndefined()
  })

  it('gives an unknown or missing model nothing', () => {
    expect(codexCacheTtlMs(undefined)).toBeUndefined()
    expect(codexCacheTtlMs('o3-mini')).toBeUndefined()
    expect(codexCacheTtlMs('')).toBeUndefined()
  })
})

describe('CodexCacheReader', () => {
  it('dates a usage record and gives it the model’s lifetime', () => {
    const reader = new CodexCacheReader()
    expect(reader.read(SURFACE, turnContext('gpt-5.6-terra'))).toBeNull()
    expect(reader.read(SURFACE, usageRecord('2026-09-22T16:15:06.844Z', 149_975, 149_376))).toEqual({
      at: at('2026-09-22T16:15:06.844Z'),
      ttlMs: CODEX_CACHE_TTL_MS,
      tokens: 149_975,
    })
  })

  it('sizes the cache as the whole prompt, not just what was read back', () => {
    // OpenAI caches the longest matching prefix, so this request's prompt is
    // now that prefix — and on a session's first request, where nothing was
    // read back, it is the only number that is not zero.
    const reader = new CodexCacheReader()
    reader.read(SURFACE, turnContext('gpt-5.6-terra'))
    expect(reader.read(SURFACE, usageRecord('2026-09-22T16:15:06.844Z', 8_000, 0))!.tokens).toBe(8_000)
  })

  it('says nothing until it has seen which model the surface runs', () => {
    // The two facts arrive in different entries, and a lifetime cannot be
    // assumed before the one that states the model shows up.
    const reader = new CodexCacheReader()
    expect(reader.read(SURFACE, usageRecord('2026-09-22T16:15:06.844Z', 149_975, 149_376))).toBeNull()
  })

  it('says nothing for a model whose lifetime is not a single number', () => {
    const reader = new CodexCacheReader()
    reader.read(SURFACE, turnContext('gpt-5.5'))
    expect(reader.read(SURFACE, usageRecord('2026-09-22T16:15:06.844Z', 149_975, 149_376))).toBeNull()
  })

  it('follows a rollout that switches model partway through', () => {
    const reader = new CodexCacheReader()
    reader.read(SURFACE, turnContext('gpt-5.6-terra'))
    expect(reader.read(SURFACE, usageRecord('2026-09-22T16:15:06.844Z', 100, 0))).not.toBeNull()

    reader.read(SURFACE, turnContext('gpt-5.5'))
    expect(reader.read(SURFACE, usageRecord('2026-09-22T16:16:06.844Z', 100, 0))).toBeNull()
  })

  it('keeps each surface’s model to itself', () => {
    const reader = new CodexCacheReader()
    reader.read(SURFACE, turnContext('gpt-5.6-terra'))
    expect(reader.read(OTHER, usageRecord('2026-09-22T16:15:06.844Z', 100, 0))).toBeNull()
    expect(reader.read(SURFACE, usageRecord('2026-09-22T16:15:06.844Z', 100, 0))).not.toBeNull()
  })

  it('ignores entries that are neither a turn context nor a usage record', () => {
    const reader = new CodexCacheReader()
    reader.read(SURFACE, turnContext('gpt-5.6-terra'))
    expect(reader.read(SURFACE, { type: 'event_msg', payload: { type: 'token_count' } })).toBeNull()
    expect(reader.read(SURFACE, { type: 'response_item' })).toBeNull()
  })

  it('ignores a malformed or empty usage record', () => {
    const reader = new CodexCacheReader()
    reader.read(SURFACE, turnContext('gpt-5.6-terra'))
    expect(reader.read(SURFACE, { type: 'token_usage_record', timestamp: 'nope', payload: { usage: { input_tokens: 5 } } })).toBeNull()
    expect(reader.read(SURFACE, usageRecord('2026-09-22T16:15:06.844Z', 0, 0))).toBeNull()
    expect(reader.read(SURFACE, { type: 'token_usage_record', timestamp: '2026-09-22T16:15:06.844Z' })).toBeNull()
  })

  it('forgets a surface on request', () => {
    const reader = new CodexCacheReader()
    reader.read(SURFACE, turnContext('gpt-5.6-terra'))
    reader.forget(SURFACE)
    expect(reader.read(SURFACE, usageRecord('2026-09-22T16:15:06.844Z', 100, 0))).toBeNull()
  })
})
