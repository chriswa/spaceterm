import { useEffect, useState } from 'react'
import { useGhRateLimitStore } from '../../stores/ghRateLimitStore'
import { DeltaSparkline } from './DeltaSparkline'
import { ONE_HOUR_MS, projectUsage, utilizationColor, formatDelta } from './usage-format'

/** How often to re-render so the countdown to reset stays honest. */
const COUNTDOWN_REFRESH_MS = 30_000

/**
 * GitHub GraphQL rate-limit meter, with a sparkline of the recent request rate
 * and a linear projection to the end of the window.
 *
 * MODDING.md names this "the best first mod": a poller shelling out to a CLI,
 * a ring buffer, one protocol message, one store and one widget. Three of the
 * five are already their own modules (`gh-rate-limit.ts`, `ring-buffer.ts`,
 * `DeltaSparkline`); this file is the fourth. It reads its own store and takes
 * no props, which is what makes it a *standalone* toolbar widget — see
 * `registry.tsx` for why that distinction is load-bearing.
 */
export function GhRateLimitIndicator() {
  const data = useGhRateLimitStore(s => s.data)
  const usedHistory = useGhRateLimitStore(s => s.usedHistory)
  const slotMinutes = useGhRateLimitStore(s => s.slotMinutes)
  const [, setTick] = useState(0)

  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), COUNTDOWN_REFRESH_MS)
    return () => clearInterval(id)
  }, [])

  // No reading yet — `gh` may be missing or unauthenticated, which the startup
  // capability report explains in the log.
  if (!data) return null

  const pct = data.limit > 0 ? (data.used / data.limit) * 100 : 0
  const projected = projectUsage(pct, data.resetAt, ONE_HOUR_MS)

  return (
    <span
      className="toolbar__status-item toolbar__metric"
      style={{ position: 'relative' }}
      data-tooltip={`GitHub GraphQL rate limit • resets in ${formatDelta(data.resetAt)}`}
      data-tooltip-no-flip
    >
      <DeltaSparkline history={usedHistory} color="#60a5fa" slotMinutes={slotMinutes} formatPeak={(v) => `${Math.round(v)} req`} />
      <span className="toolbar__metric-label">GH </span>
      <span style={{ color: utilizationColor(pct) }}>{Math.round(pct)}<span className="toolbar__metric-label">%</span></span>
      {projected != null && (
        <span style={{ color: '#888' }} data-tooltip="GitHub rate limit linear extrapolation">
          {' '}({Math.round(projected)}<span className="toolbar__metric-label">%</span>)
        </span>
      )}
    </span>
  )
}
