/**
 * Pure formatting for usage-quota indicators.
 *
 * Split out of the toolbar as plain `.ts` so it can be tested without React or
 * jsdom, and so `now` can be injected — the projection and the countdown are
 * both functions of the clock, and pinning them to `Date.now()` made three
 * genuinely tricky behaviours (expired window, too-early projection, sub-minute
 * rounding) untestable.
 *
 * Nothing here is GitHub-specific. It applies to any "X used of Y, resets at T"
 * quota, which is the shape a mod feeding its own usage meter would have.
 */

export const ONE_HOUR_MS = 60 * 60 * 1000

/**
 * How much of a window must elapse before a projection is shown.
 *
 * Extrapolating from the first minute of a window turns a single request into
 * a predicted 6000, which is worse than showing nothing.
 */
export const PROJECTION_MIN_ELAPSED_MS = 10 * 60 * 1000

/**
 * Project current utilization forward to the end of the window, or null when
 * there is not enough to go on: the window has expired, too little of it has
 * elapsed, or nothing has been used yet.
 */
export function projectUsage(
  utilization: number,
  resetsAt: string,
  windowMs: number,
  now: number = Date.now()
): number | null {
  const resetMs = new Date(resetsAt).getTime()
  if (isNaN(resetMs)) return null
  const remainingMs = resetMs - now
  if (remainingMs <= 0) return null                        // window expired
  const elapsedMs = windowMs - remainingMs
  if (elapsedMs < PROJECTION_MIN_ELAPSED_MS) return null   // too early to say
  if (utilization <= 0) return null                        // nothing to project
  return utilization * (windowMs / elapsedMs)
}

/**
 * Colour for a utilization percentage: white below half, warming through
 * yellow and orange, red at the cap.
 */
export function utilizationColor(pct: number): string {
  if (pct >= 100) return '#ff3b30'
  if (pct <= 50) return '#ffffff'
  if (pct <= 75) {
    // white → yellow
    const t = (pct - 50) / 25
    return `rgb(255,255,${Math.round(255 * (1 - t))})`
  }
  // 75–99: yellow → orange
  const t = (pct - 75) / 24
  return `rgb(255,${Math.round(255 - 90 * t)},0)`
}

/** Time until a reset, as a short human string: `now`, `45m`, `2h`, `1h 5m`. */
export function formatDelta(resetAt: string, now: number = Date.now()): string {
  const diffMs = new Date(resetAt).getTime() - now
  if (isNaN(diffMs) || diffMs <= 0) return 'now'
  // Round up: "0m" would read as expired when there are still 30 seconds left.
  const totalMinutes = Math.ceil(diffMs / 60_000)
  if (totalMinutes < 60) return `${totalMinutes}m`
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`
}
