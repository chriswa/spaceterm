import type { CacheWarmth } from './cache-warmth'

/**
 * When a Cursor surface's prompt cache goes cold.
 *
 * The weakest of the three readings, and deliberately still made. Cursor's
 * transcript reports no token usage at all — no cache counters, no model, and
 * no machine-readable timestamp — and neither does anything else it writes to
 * disk: `~/.cursor/chats/*​/*​/store.db` holds message blobs, and
 * `ai-code-tracking.db` has no token columns. So both halves of the answer have
 * to be supplied from outside the transcript.
 *
 * The lifetime is Cursor's, stated by their staff on their own forum: they take
 * each provider's default and do nothing to keep a cache warm — five minutes on
 * Anthropic models, thirty on GPT-5.6, twenty-four hours on most other OpenAI
 * models. They also tested longer Claude retention and did not adopt it.
 *
 * Which of those applies needs the model, and that is the part Cursor does not
 * give us: the model appears in `store.db` for a minority of conversations and
 * nowhere in the JSONL we watch. So this takes the shortest of the three. A
 * floor across every provider Cursor routes to is wrong in one direction only —
 * a Cursor session on an OpenAI model reads cold long before it truly is — and
 * that is the direction that costs nothing but a wasted glance. The reverse
 * would quietly tell you a cache was safe while it expired.
 *
 * The anchor is weak too. Cursor's entries carry no timestamp, so a surface is
 * dated by when its transcript was last seen to grow, which only holds while
 * Spaceterm is running — a restart leaves a Cursor surface with no anchor until
 * it moves again. That is why `index.ts` stamps live growth and skips backfill.
 */
export const CURSOR_CACHE_TTL_MS = 5 * 60_000

/**
 * The warmth to record for a Cursor surface seen moving at `now`.
 *
 * Always `estimated`, and with no token count, because neither is something
 * Cursor tells us.
 */
export function cursorCacheWarmth(now: number): CacheWarmth {
  return { warmUntil: now + CURSOR_CACHE_TTL_MS, estimated: true }
}
