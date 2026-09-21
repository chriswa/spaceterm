/**
 * "How long since this surface last said anything", in the shortest form that
 * still reads as an answer.
 *
 * Single resolution, deliberately: one unit, never "1h 20m". The caption is
 * read from across the canvas alongside dozens of others, and its job is to
 * separate "just now" from "this morning" from "last week" at a glance — a
 * second component buys precision nobody is reading at that distance and costs
 * the scannability the whole row depends on.
 *
 * Truncating rather than rounding for the same reason: a surface that says `1h`
 * has been quiet for at least an hour, whatever the minutes say, and the number
 * only ever moves forward. Rounding would let `1h` appear 31 minutes in and
 * make the caption a worse lower bound than the one it looks like.
 *
 * Days are the last unit. Weeks, months and years each need the reader to do
 * arithmetic to compare them against the days beside them, and a surface nobody
 * has touched in 40 days is already saying everything `40d` says.
 */

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

/**
 * How often the captions are recomputed.
 *
 * The finest increment shown is a whole minute, so this only has to be small
 * enough that a change lands promptly — not small enough to track seconds. At
 * ten seconds a caption is at most that late and the canvas re-lays its labels
 * six times a minute instead of sixty.
 */
export const ELAPSED_TICK_MS = 10_000

/**
 * `elapsedMs` written as one unit: `0m` under a minute, then `3m`, `1h`, `2d`.
 *
 * `0m` rather than a word like "now" so every caption on the canvas has the
 * same shape — a number and a unit. A column of them is then scanned as a
 * column of numbers, and the one surface that just spoke does not have to be
 * read differently from the rest to be understood.
 *
 * A negative span — a timestamp from the future, which clock skew between the
 * server and this client can produce — reads as `0m`, the nearest true thing.
 */
export function formatElapsedShort(elapsedMs: number): string {
  if (elapsedMs < MINUTE_MS) return '0m'
  if (elapsedMs < HOUR_MS) return `${Math.floor(elapsedMs / MINUTE_MS)}m`
  if (elapsedMs < DAY_MS) return `${Math.floor(elapsedMs / HOUR_MS)}h`
  return `${Math.floor(elapsedMs / DAY_MS)}d`
}
