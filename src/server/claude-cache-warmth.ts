import type { CacheTouch } from './cache-warmth'
import type { SessionFileEntry } from './session-file-watcher'

/**
 * When a Claude surface's Anthropic prompt cache goes cold.
 *
 * Every assistant entry in a Claude transcript reports the request's token
 * usage, and inside it `cache_creation` splits the tokens written by the TTL
 * they were written at — `ephemeral_5m_input_tokens` or
 * `ephemeral_1h_input_tokens`. So the TTL is something the transcript states
 * outright, not something to infer from timing.
 *
 * A request writes at exactly one TTL; the two buckets are never both non-zero
 * on one entry. Claude Code chooses per request and can change its mind
 * mid-session — an account in usage overage drops from the hour to five
 * minutes and back — which is why the TTL is re-read from the newest write
 * rather than decided once for the session.
 *
 * The most generous of the three agents. Codex has to be taken from OpenAI's
 * documented floor and Cursor from a floor across every provider it routes to
 * — see `codex-cache-warmth.ts` and `cursor-cache-warmth.ts`. Only here is the
 * lifetime a reading.
 */

const FIVE_MINUTES_MS = 5 * 60_000
const ONE_HOUR_MS = 60 * 60_000

/**
 * What one Claude transcript entry says about the cache, or `null` for an entry
 * that says nothing — a user turn, a tool result, a summary line.
 *
 * `ttlMs` is absent on an entry that read the cache without writing to it. That
 * request still touched the cache, and a hit refreshes the entry's lifetime, so
 * it moves the deadline forward; it just does not restate how long that
 * lifetime is. See `CacheWarmthTracker` for how the last stated one carries.
 *
 * `tokens` is the whole cached prefix after the request — what was read back
 * plus what this request added — which is the context that would have to be
 * paid for again if the cache went cold.
 *
 * Sidechain entries are ignored. A subagent runs against its own cache, and
 * when that expires it says nothing about the surface the human is typing into.
 */
export function readClaudeCacheTouch(entry: SessionFileEntry): CacheTouch | null {
  if (entry.isSidechain === true) return null

  const usage = (entry.message as { usage?: Record<string, unknown> } | undefined)?.usage
  if (!usage) return null

  const at = new Date(String(entry.timestamp)).getTime()
  if (!Number.isFinite(at)) return null

  const read = count(usage.cache_read_input_tokens)
  const written = usage.cache_creation as Record<string, unknown> | undefined
  const hour = count(written?.ephemeral_1h_input_tokens)
  const fiveMinute = count(written?.ephemeral_5m_input_tokens)
  const tokens = read + hour + fiveMinute

  if (hour > 0) return { at, ttlMs: ONE_HOUR_MS, tokens }
  if (fiveMinute > 0) return { at, ttlMs: FIVE_MINUTES_MS, tokens }
  if (read > 0) return { at, tokens }

  // Wrote nothing and read nothing: there is no cache to expire.
  return null
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}
