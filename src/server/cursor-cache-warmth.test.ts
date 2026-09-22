import { describe, it, expect } from 'vitest'
import { CURSOR_CACHE_TTL_MS, cursorCacheWarmth } from './cursor-cache-warmth'

describe('cursorCacheWarmth', () => {
  it('projects the shortest lifetime Cursor could be running', () => {
    // Cursor takes each provider's default and keeps no cache warm: five
    // minutes on Anthropic, thirty on GPT-5.6, twenty-four hours on other
    // OpenAI models. It will not say which served a request, so this is the
    // floor across all of them.
    expect(CURSOR_CACHE_TTL_MS).toBe(5 * 60_000)
    expect(cursorCacheWarmth(1_000_000).warmUntil).toBe(1_000_000 + 5 * 60_000)
  })

  it('marks itself an estimate, so the caption can say so', () => {
    expect(cursorCacheWarmth(0).estimated).toBe(true)
  })

  it('reports no size, because Cursor reports no token counts anywhere', () => {
    expect(cursorCacheWarmth(0).tokens).toBeUndefined()
  })
})
