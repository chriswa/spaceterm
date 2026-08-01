const SPARKLINE_W = 60
const SPARKLINE_H = 20
const SPARKLINE_PAD = 2

/**
 * A sparkline of the *rate of change* of a monotonic counter, drawn floating
 * above whatever it is attached to.
 *
 * Nothing about it is GitHub-specific — it takes a slot-keyed history and a
 * slot width, so any minute-keyed monotonic series works. MODDING.md names the
 * rate-limit sparkline as the best first mod precisely because this half is
 * already generic; what is left is the data feed.
 */
export interface DeltaSparklineProps {
  /** Counter reading per slot; null for a slot with no reading. */
  history: (number | null)[]
  /** Stroke colour, e.g. `#60a5fa`. The fill is derived at 50% alpha. */
  color: string
  /** Width of each history slot, in minutes. */
  slotMinutes: number
  /** Renders the per-minute peak for the tooltip. */
  formatPeak: (perMinute: number) => string
}

export function DeltaSparkline({ history, color, slotMinutes, formatPeak }: DeltaSparklineProps) {
  // Per-minute rate for each slot transition. A missing reading on either side
  // contributes zero rather than a spike.
  const allDeltas: number[] = []
  for (let i = 1; i < history.length; i++) {
    const prev = history[i - 1]
    const cur = history[i]
    allDeltas.push(prev != null && cur != null ? (cur - prev) / slotMinutes : 0)
  }

  // A flat line says nothing; draw nothing rather than a decorative zero.
  if (!allDeltas.some(d => d !== 0)) return null

  const maxD = Math.max(...allDeltas)
  const peakIdx = allDeltas.indexOf(maxD)
  const range = maxD || 1
  const bottomY = SPARKLINE_H - SPARKLINE_PAD

  const points = allDeltas.map((d, i) => ({
    x: SPARKLINE_PAD + (i / (allDeltas.length - 1)) * (SPARKLINE_W - 2 * SPARKLINE_PAD),
    y: SPARKLINE_PAD + (1 - d / range) * (SPARKLINE_H - 2 * SPARKLINE_PAD),
  }))

  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ')
  const area = line + ` L ${points[points.length - 1].x} ${bottomY} L ${points[0].x} ${bottomY} Z`
  const slotsAgo = allDeltas.length - 1 - peakIdx
  const peakTime = new Date(Date.now() - slotsAgo * slotMinutes * 60_000)
  const timeStr = peakTime.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }).toLowerCase()
  const peakTooltip = `Recent peak: ${formatPeak(maxD)}/min @ ${timeStr}`

  // Derive fill with 50% opacity from the stroke color
  const fillColor = color.startsWith('#')
    ? `${color}80`   // hex + 50% alpha
    : color.replace('rgb(', 'rgba(').replace(')', ', 0.5)')

  return (
    <svg
      width={SPARKLINE_W}
      height={SPARKLINE_H}
      viewBox={`0 0 ${SPARKLINE_W} ${SPARKLINE_H}`}
      data-tooltip={peakTooltip}
      style={{
        position: 'absolute',
        bottom: '100%',
        left: '50%',
        transform: 'translateX(-50%)',
        marginBottom: 2,
      }}
    >
      <path d={area} fill={fillColor} />
      <path
        d={line}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity={0.8}
      />
    </svg>
  )
}
