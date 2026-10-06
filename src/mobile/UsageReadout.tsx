import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import type { UsageBar, UsagePalette, UsageSnapshot } from '../shared/usage-report'

/**
 * AI usage on the bottom bar, drawn as AI Spend Tracker draws it in the
 * menu bar (TrayBars.swift): one bar per window, filling bottom-up — a dim
 * column for time elapsed, a bright stripe in its right-hand lane for usage —
 * on black, framed by a hairline that turns white at 100%. Tight gaps within a
 * provider, wider between. Only the bars, always.
 *
 * Scaled down, whole, when there are more bars than the bar's left zone is
 * wide. The tap-for-details table is `UsageDetail`, shown by MacReadouts.tsx.
 */

/** The tracker's brand colours (PieChart.palette); time is the same at half brightness. */
const PALETTE_RGB: Record<UsagePalette, [number, number, number]> = {
  claude: [217, 119, 87],
  codex: [61, 147, 214],
  cursor: [172, 124, 224],
  devin: [214, 61, 110],
  jev: [38, 184, 201],
  scoped: [224, 168, 46],
  spend: [52, 199, 89]
}
const rgb = ([r, g, b]: [number, number, number], k = 1) => `rgb(${Math.round(r * k)}, ${Math.round(g * k)}, ${Math.round(b * k)})`
const pct = (f: number) => `${Math.round(f * 100)}%`

/** "moments", "4m", "1h 5m" — how long ago, as in "4m ago". */
export function ageText(ms: number): string {
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return 'moments'
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

function Bar({ bar }: { bar: UsageBar }) {
  const colour = PALETTE_RGB[bar.palette]
  if (bar.error) {
    return <span className="m-usage__error" style={{ color: rgb(colour) }} aria-label={bar.label}>⚠︎</span>
  }
  return (
    <span
      className={`m-usage__bar${bar.usage >= 1 ? ' m-usage__bar--maxed' : ''}`}
      style={{ marginLeft: bar.startsGroup ? 5 : 2 }}
      aria-label={`${bar.label}: ${pct(bar.usage)} used, ${pct(bar.time)} of the window gone`}
    >
      <span className="m-usage__time" style={{ height: pct(Math.min(1, bar.time)), background: rgb(colour, 0.5) }} />
      <span className="m-usage__used" style={{ height: pct(Math.min(1, bar.usage)), background: rgb(colour) }} />
    </span>
  )
}

/** Their natural size, and the scale that fits it in the bottom bar's zone around `wrap`. */
interface Fit { width: number; height: number; scale: number }

/** `shown` re-measures when the bars first appear (they render nothing until a reading arrives). */
function useFitToZone(wrap: RefObject<HTMLElement | null>, bars: RefObject<HTMLElement | null>, shown: boolean): Fit | null {
  const [fit, setFit] = useState<Fit | null>(null)
  useLayoutEffect(() => {
    const zone = wrap.current?.closest('.m-bar__zone')
    const content = bars.current
    if (!zone || !content) return
    // The zone's width is the grid's (min-width: 0), not its content's, so
    // scaling the bars never feeds back into the space they are given.
    const measure = () => {
      const width = content.offsetWidth
      const height = content.offsetHeight
      const scale = width > 0 ? Math.min(1, zone.clientWidth / width) : 1
      setFit((f) => (f && f.width === width && f.height === height && f.scale === scale ? f : { width, height, scale }))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(zone)
    observer.observe(content)
    return () => observer.disconnect()
  }, [wrap, bars, shown])
  return fit
}

/** "now", "45m", "4h", "28d" — how long until, in its largest whole unit. */
export function remainingText(ms: number): string {
  const minutes = Math.ceil(ms / 60_000)
  if (minutes <= 0) return 'now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`
}

/** The tracker's latest reading, as the server sends it; null until there is one. */
export function useUsageReport(): UsageSnapshot | null {
  const [snapshot, setSnapshot] = useState<UsageSnapshot | null>(null)
  useEffect(() => {
    let live = true
    window.api.node.usageReportStatus().then((s) => { if (live && s) setSnapshot(s) }, () => undefined)
    const off = window.api.node.onUsageReport(setSnapshot)
    return () => { live = false; off() }
  }, [])
  return snapshot
}

export function UsageBars({ snapshot }: { snapshot: UsageSnapshot }) {
  const wrap = useRef<HTMLDivElement>(null)
  const bars = useRef<HTMLSpanElement>(null)
  const fit = useFitToZone(wrap, bars, snapshot.bars.length > 0)
  const shrunk = fit !== null && fit.scale < 1
  if (snapshot.bars.length === 0) return null
  return (
    <div
      ref={wrap}
      className="m-usage"
      // A transform leaves the layout box at full size, so the box is given the scaled size.
      style={shrunk ? { width: fit.width * fit.scale, height: fit.height * fit.scale } : undefined}
    >
      <span ref={bars} className="m-usage__bars" style={shrunk ? { transform: `scale(${fit.scale})` } : undefined}>
        {snapshot.bars.map((b) => <Bar key={b.label} bar={b} />)}
      </span>
    </div>
  )
}

/** Each bar's figures, one row apiece, and how old the reading is. */
export function UsageDetail({ snapshot, now }: { snapshot: UsageSnapshot; now: number }) {
  return (
    <div className="m-detail__set">
      <table className="m-detail__table">
        <thead>
          <tr><th /><th>used</th><th>elapsed</th><th>resets</th></tr>
        </thead>
        <tbody>
          {snapshot.bars.map((b) => (
            <tr key={b.label} style={{ color: rgb(PALETTE_RGB[b.palette]) }}>
              <td className="m-detail__name">{b.label}</td>
              {b.error ? <td colSpan={3} /> : (
                <>
                  <td>{pct(b.usage)}</td>
                  <td>{pct(b.time)}</td>
                  <td>{b.resetsAt === undefined ? '' : remainingText(b.resetsAt - now)}</td>
                </>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      {snapshot.updatedAt !== null && (
        <div className="m-detail__when">
          Read {new Date(snapshot.updatedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} ({ageText(now - snapshot.updatedAt)} ago)
        </div>
      )}
    </div>
  )
}
