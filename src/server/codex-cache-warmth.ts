import type { CacheTouch } from './cache-warmth'
import type { SessionFileEntry } from './session-file-watcher'
import type { PtySessionId } from '../shared/ids'

/**
 * When a Codex surface's OpenAI prompt cache goes cold.
 *
 * Nothing in a Codex rollout states a lifetime. OpenAI's caching is implicit —
 * no breakpoints to buy, no TTL to choose — so `token_usage_record` reports
 * `cached_input_tokens` and stops there. The lifetime has to come from OpenAI's
 * documentation instead, and it is per model:
 *
 *  - GPT-5.6 and later: a cached prefix stays eligible "for at least 30 minutes
 *    after the most recent write or reuse", and `prompt_cache_options.ttl`
 *    accepts only `"30m"`. One number, and reuse refreshes it.
 *  - Earlier models: 5–10 minutes idle under `in_memory`, or up to 24 hours
 *    under `24h` retention, defaulting by the org's data-retention policy.
 *    Codex records neither the setting nor anything to infer it from.
 *
 * So only the first case is answerable, and an older model gets no countdown
 * rather than a number spanning five minutes to a day. Every rollout on this
 * machine is GPT-5.6, so in practice this is the whole story.
 *
 * A floor rather than a reading: OpenAI says "at least", and may hold a prefix
 * longer. The countdown therefore runs out early — it can call a cache cold
 * while it is in fact still warm, never the reverse — which is the safe
 * direction when the number is there to decide what to rescue.
 */

/** OpenAI's documented minimum lifetime for a GPT-5.6+ cached prefix. */
export const CODEX_CACHE_TTL_MS = 30 * 60_000

/**
 * The cache lifetime OpenAI documents for `model`, or `undefined` when it is
 * not a model whose lifetime is a single number.
 *
 * Compares the version rather than matching `gpt-5.6` literally, so a later
 * model inherits the rule instead of silently losing its countdown. An
 * unparseable or older name returns `undefined`.
 */
export function codexCacheTtlMs(model: string | undefined): number | undefined {
  const version = model?.match(/^gpt-(\d+)(?:\.(\d+))?/)
  if (!version) return undefined
  const major = Number(version[1])
  const minor = Number(version[2] ?? 0)
  if (major > 5 || (major === 5 && minor >= 6)) return CODEX_CACHE_TTL_MS
  return undefined
}

/**
 * Reads Codex rollout entries into cache touches, tracking the model per
 * surface because the lifetime depends on it and the two facts arrive in
 * different entries.
 *
 * Codex writes a `turn_context` at the start of each turn naming the model, and
 * a `token_usage_record` per request carrying the usage. A rollout can change
 * model partway through — the user picks a different one — so the model is
 * re-read from every `turn_context` rather than taken once from the first.
 */
export class CodexCacheReader {
  private readonly modelBySurface = new Map<PtySessionId, string>()

  read = (surfaceId: PtySessionId, entry: SessionFileEntry): CacheTouch | null => {
    const payload = entry.payload as Record<string, unknown> | undefined

    if (entry.type === 'turn_context') {
      if (typeof payload?.model === 'string') this.modelBySurface.set(surfaceId, payload.model)
      return null
    }

    if (entry.type !== 'token_usage_record') return null

    const at = new Date(String(entry.timestamp)).getTime()
    if (!Number.isFinite(at)) return null

    const usage = payload?.usage as Record<string, unknown> | undefined
    const prompt = usage?.input_tokens
    if (typeof prompt !== 'number' || !Number.isFinite(prompt) || prompt <= 0) return null

    const ttlMs = codexCacheTtlMs(this.modelBySurface.get(surfaceId))
    if (ttlMs === undefined) return null

    // The whole prompt, not just `cached_input_tokens`. OpenAI caches the
    // longest matching prefix and this request's prompt is now that prefix, so
    // the total is what a cold cache would make you pay for again — and on the
    // first request of a session, where nothing was read back, it is the only
    // number that is not zero.
    return { at, ttlMs, tokens: prompt }
  }

  forget(surfaceId: PtySessionId): void {
    this.modelBySurface.delete(surfaceId)
  }
}
