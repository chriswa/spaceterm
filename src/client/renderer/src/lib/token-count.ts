/**
 * A token count written for the corner of a card.
 *
 * Two significant figures at most and never a unit longer than one character,
 * because this number sits next to a countdown in a caption read from across
 * the canvas. Its job is to separate a session worth interrupting your work for
 * from one that can expire unwatched — 20k against 500k — and no decision that
 * comparison feeds changes on the last three digits.
 */

const THOUSAND = 1_000
const MILLION = 1_000_000

/**
 * `tokens` written short: `840`, `20k`, `185k`, `1.2M`.
 *
 * Rounded rather than truncated, unlike the time spans beside it. A span is
 * truncated so it reads as a lower bound you can rely on; a size is a magnitude
 * being compared against its neighbours, where the nearest value is simply the
 * more accurate one.
 *
 * Fractional only in the millions. `1.2M` and `840k` are the same width and the
 * same precision, but `1M` alone would lose the difference between a session
 * just over the line and one three times the size.
 */
export function formatTokensShort(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens < 0) return '0'
  if (tokens < THOUSAND) return `${Math.round(tokens)}`
  if (tokens < MILLION) return `${Math.round(tokens / THOUSAND)}k`
  return `${(tokens / MILLION).toFixed(1)}M`
}
