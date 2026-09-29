/**
 * Spans of time written for the captions under agent surfaces: how long a
 * surface has been quiet, and how long its prompt cache has left.
 *
 * Ages are one unit, never "1h 20m". The caption is read from across the canvas
 * alongside dozens of others, and its job is to separate "just now" from "this
 * morning" from "last week" at a glance — a second component buys precision
 * nobody is reading at that distance and costs the scannability the whole row
 * depends on. They are rounded to the nearest whole unit, so a boundary sits in
 * the middle of a unit rather than exactly on it.
 *
 * Days are the last unit. Weeks, months and years each need the reader to do
 * arithmetic to compare them against the days beside them, and a surface nobody
 * has touched in 40 days is already saying everything `40d` says.
 *
 * Countdowns are a clock instead — see {@link formatCountdownClock}.
 */

const SECOND_MS = 1_000
const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

/**
 * How often the captions are recomputed.
 *
 * A second, set by the cache countdown — the one caption that shows seconds,
 * and the one anyone actually watches as it runs out. An age still changes
 * only on a minute boundary, so most ticks re-derive the identical string for
 * it; that waste is the price of the countdown moving when
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
 * opposite reason and does show seconds — see {@link formatCountdownClock}.
 *
 * A negative span — a timestamp from the future, which clock skew between the
 * server and this client can produce — reads as `0m`, the nearest true thing.
 */
export function formatElapsedShort(elapsedMs: number): string {
  const minutes = Math.round(elapsedMs / MINUTE_MS)
  return minutes < 1 ? '0m' : fromMinutes(elapsedMs, minutes)
}

/**
 * `remainingMs` written as a ticking clock: `4:32`, `0:07`, `58:00`.
 *
 * A clock rather than a unit, so a countdown and an age never share a shape:
 * an age is a coarse `14m`, a deadline is `m:ss` with its seconds visibly
 * moving, which is how a timer on any appliance says it is running out.
 *
 * Minutes are not rolled up into hours. No cache lives much past an hour, and
 * `60:00` falling to `59:59` keeps the caption one width, where `1:00:00`
 * would shrink by three characters on its first tick.
 *
 * Seconds are rounded down. The `now` this is measured against is quantised
 * down to the second, so it runs up to a second behind the real clock and the
 * span is up to a second long; rounding up on top of that shows a fresh
 * hour-long cache as `60:01`.
 */
export function formatCountdownClock(remainingMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(remainingMs / SECOND_MS))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

/**
 * `remainingMs` as rounded whole minutes — `4m`, `60m` — for the toolbar, where
 * a row of ticking seconds is more motion than the bar can carry.
 *
 * Never `0m`: the last half minute of a live cache reads `1m`, since `0m`
 * would say it had already gone cold.
 */
export function formatCountdownMinutes(remainingMs: number): string {
  return `${Math.max(1, Math.round(remainingMs / MINUTE_MS))}m`
}

/**
 * A surface's prompt-cache countdown, or `null` once the cache is cold or was
 * never reported. `format` writes the remaining span — the canvas uses
 * `formatCountdownClock`, the toolbar `formatCountdownMinutes`.
 *
 * A deadline the server could only estimate is marked `4:32?`. That is Cursor:
 * it will not say which provider served a request, so its lifetime is a floor
 * across all of them rather than a reading. The question mark is what keeps
 * its surfaces from being compared against Claude's as though the two numbers
 * were equally good.
 */
export function cacheCountdownText(
  cacheWarmUntil: number | undefined,
  estimated: boolean | undefined,
  now: number,
  format: (remainingMs: number) => string
): string | null {
  const warmFor = cacheWarmUntil === undefined ? 0 : cacheWarmUntil - now
  if (warmFor <= 0) return null
  return `${format(warmFor)}${estimated ? '?' : ''}`
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
