import type { SessionFileEntry } from './session-file-watcher'
import type { PtySessionId } from '../shared/ids'

/**
 * How long an agent surface's prompt cache has left, and how much context is
 * riding on it.
 *
 * Both halves matter for the same decision. A surface whose cache expires in
 * two minutes is only worth interrupting your work for if there is enough in it
 * to be worth saving; a 20k session going cold costs nothing, a 500k one is
 * real money. The countdown ranks by urgency and the token count by stake.
 *
 * Agent-agnostic. What one transcript entry says about the cache is the part
 * that differs per agent — see `claude-cache-warmth.ts` and
 * `codex-cache-warmth.ts` — and this folds those readings into a deadline.
 */

/** What one transcript entry says about the cache. */
export interface CacheTouch {
  /** epoch ms of the request. */
  at: number
  /**
   * The lifetime the request's cache entry was given, when the entry states
   * one. Absent on a request that read the cache without restating its TTL:
   * the read refreshes the entry's lifetime, so the deadline moves, but how
   * long that lifetime is has to come from the last request that said.
   */
  ttlMs?: number
  /** Tokens the cache holds after this request, when the entry reports it. */
  tokens?: number
}

export interface CacheWarmth {
  /** epoch ms the cache goes cold. */
  warmUntil: number
  tokens?: number
  /**
   * True when the deadline is a guess rather than a reading, and the caption
   * should say so.
   *
   * Only Cursor sets it. Claude states its lifetime per request, and Codex's is
   * a single documented number for the model it names — near enough to a
   * reading to be shown as one. Cursor's is a floor across every provider it
   * routes to, picked because it will not say which one served the request, so
   * it can be wrong by hours rather than by the minutes of slack in the others.
   */
  estimated?: boolean
}

/** Reads one transcript entry for `surfaceId`, or returns null if it says nothing. */
export type CacheTouchReader = (surfaceId: PtySessionId, entry: SessionFileEntry) => CacheTouch | null

/**
 * Folds transcript entries into the "cache goes cold at" deadline for each
 * surface, remembering the last TTL each one stated.
 *
 * The memory is what the class is for. A batch can be all cache *reads* — no
 * lifetime of their own — and on its own such a batch cannot say whether the
 * deadline it is pushing forward is five minutes out or an hour. The TTL from
 * the newest request that stated one is the answer, and it has to survive from
 * one batch to the next to be available.
 */
export class CacheWarmthTracker {
  private readonly ttlBySurface = new Map<PtySessionId, number>()

  constructor(private readonly read: CacheTouchReader) {}

  /**
   * The surface's new warmth, or `undefined` when `entries` said nothing about
   * the cache and the caller should leave the current value be.
   *
   * "Said nothing" and "the cache is cold" are deliberately different answers.
   * Expiry needs no signal to announce it — a deadline already in the past is
   * exactly what an expired cache looks like — so silence here only ever means
   * there is no news, never that the old news has been withdrawn.
   *
   * `reset` forgets the remembered TTL first, for the backfill that re-reads a
   * transcript from its first line: the state being rebuilt is the file's, and
   * anything left over from a previous watch on this surface is a different
   * session's.
   */
  observe(
    surfaceId: PtySessionId,
    entries: readonly SessionFileEntry[],
    opts?: { reset?: boolean },
  ): CacheWarmth | undefined {
    if (opts?.reset) this.ttlBySurface.delete(surfaceId)

    // Compared by timestamp rather than taken in file order: a batch is written
    // in the order the requests finished, which retries and parallel tool calls
    // are enough to put out of order.
    let newest: CacheTouch | undefined
    let newestStatedTtl: { at: number; ttlMs: number } | undefined
    for (const entry of entries) {
      const touch = this.read(surfaceId, entry)
      if (!touch) continue
      if (!newest || touch.at > newest.at) newest = touch
      if (touch.ttlMs !== undefined && (!newestStatedTtl || touch.at > newestStatedTtl.at)) {
        newestStatedTtl = { at: touch.at, ttlMs: touch.ttlMs }
      }
    }
    if (newestStatedTtl) this.ttlBySurface.set(surfaceId, newestStatedTtl.ttlMs)
    if (!newest) return undefined

    const ttlMs = newest.ttlMs ?? this.ttlBySurface.get(surfaceId)
    // A read-only touch on a surface we have never seen a lifetime for: the
    // cache is warm, but for how much longer is genuinely unknown, and a guess
    // here would be indistinguishable from a reading.
    if (ttlMs === undefined) return undefined

    return { warmUntil: newest.at + ttlMs, tokens: newest.tokens }
  }

  forget(surfaceId: PtySessionId): void {
    this.ttlBySurface.delete(surfaceId)
  }
}
