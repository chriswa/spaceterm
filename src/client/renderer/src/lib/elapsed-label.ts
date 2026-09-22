/**
 * A span of time written in the shortest form that still reads as an answer —
 * how long a surface has been quiet, how long its prompt cache has left.
 *
 * Single resolution, deliberately: one unit, never "1h 20m". The caption is
 * read from across the canvas alongside dozens of others, and its job is to
 * separate "just now" from "this morning" from "last week" at a glance — a
 * second component buys precision nobody is reading at that distance and costs
 * the scannability the whole row depends on.
 *
 * Rounded to the nearest whole unit, not truncated. Truncating reads as a lower
 * bound you can rely on, which is a nice property, but it puts a boundary
 * exactly where the numbers live: a cache refreshed to a full hour truncates to
 * `1h` for one second and `59m` for the remaining fifty-nine minutes, so a
 * surface an agent is actively working in flickers between the two every time
 * it sends a message. Rounding moves that boundary to the middle of the unit,
 * where nothing lands repeatedly — the same cache now holds at `1h` until it
 * genuinely falls below 59½ minutes.
 *
 * Days are the last unit. Weeks, months and years each need the reader to do
 * arithmetic to compare them against the days beside them, and a surface nobody
 * has touched in 40 days is already saying everything `40d` says.
 */

const SECOND_MS = 1_000
const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

/**
 * How often the captions are recomputed.
 *
 * A second, set by the cache countdown — the one part of a caption that shows
 * seconds, and the part anyone actually watches as it runs out. The elapsed
 * half still changes only on a minute boundary, so most ticks re-derive the
 * identical string for it; that waste is the price of the countdown moving when
 * it should, and it is bounded by the elapsed captions having their own memo
 * (see `useCoarseClock`), so a tick never re-wraps a name on the canvas.
 */
export const ELAPSED_TICK_MS = 1_000

/**
 * `elapsedMs` written as one unit: `0m` under a minute, then `3m`, `1h`, `2d`.
 *
 * `0m` rather than a count of seconds. An age is read to place a surface in the
 * day — it spoke a moment ago, this morning, last week — and no part of that
 * answer changes on the second; a number ticking away under a card would draw
 * the eye across the canvas to report nothing. A deadline is read for the
 * opposite reason and does show seconds — see {@link formatCountdownShort}.
 *
 * A negative span — a timestamp from the future, which clock skew between the
 * server and this client can produce — reads as `0m`, the nearest true thing.
 */
export function formatElapsedShort(elapsedMs: number): string {
  const minutes = Math.round(elapsedMs / MINUTE_MS)
  return minutes < 1 ? '0m' : fromMinutes(elapsedMs, minutes)
}

/**
 * `remainingMs` written as one unit, with seconds: `22s`, `3m`, `1h`.
 *
 * The same ladder as {@link formatElapsedShort} with one more rung at the
 * bottom, because a deadline is read for what it is about to do rather than for
 * where it sits in the day. A five-minute cache spends a fifth of its life
 * under a minute, and `0m` for the whole of that last stretch would hide the
 * only part worth watching.
 *
 * The rung is taken at the same half-unit boundary as the rest, so seconds show
 * up to half a minute and `1m` covers the rest of it.
 *
 * Only ever called on a positive span: an expired cache shows the surface's age
 * instead of a countdown at zero.
 */
export function formatCountdownShort(remainingMs: number): string {
  const minutes = Math.round(remainingMs / MINUTE_MS)
  if (minutes >= 1) return fromMinutes(remainingMs, minutes)
  return `${Math.max(0, Math.round(remainingMs / SECOND_MS))}s`
}

/**
 * The shared ladder from a minute up, given the span and its span in whole
 * minutes so the caller's rounding is not repeated.
 *
 * Each rung re-rounds from the original span rather than dividing the rung
 * below, so a span lands on the same unit however it is reached: 59 minutes 40
 * seconds rounds to 60 minutes, which is not a minutes answer, and rounds again
 * to `1h` rather than being printed as `60m`.
 */
function fromMinutes(ms: number, minutes: number): string {
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(ms / HOUR_MS)
  if (hours < 24) return `${hours}h`
  return `${Math.round(ms / DAY_MS)}d`
}
