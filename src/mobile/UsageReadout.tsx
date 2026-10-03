import { useEffect, useState } from 'react'
import type { UsageBar, UsagePalette, UsageSnapshot } from '../shared/usage-report'

/**
 * AI usage in the canvas's corner, drawn as AI Spend Tracker draws it in the
 * menu bar (TrayBars.swift): one bar per window, filling bottom-up — a dim
 * column for time elapsed, a bright stripe in its right-hand lane for usage —
 * on black, framed by a hairline that turns white at 100%. Tight gaps within a
 * provider, wider between. Only the bars, always.
 *
 * Tap for each bar's name and figures, and how old the reading is.
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

export function UsageReadout() {
  const [snapshot, setSnapshot] = useState<UsageSnapshot | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [open, setOpen] = useState(false)

  useEffect(() => {
    let live = true
    window.api.node.usageReportStatus().then((s) => { if (live && s) setSnapshot(s) }, () => undefined)
    const off = window.api.node.onUsageReport(setSnapshot)
    return () => { live = false; off() }
  }, [])

  // The details' age only shows minutes.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [])

  if (!snapshot || snapshot.bars.length === 0) return null

  return (
    <div className="m-usage" onClick={() => setOpen((o) => !o)}>
      {open && (
        <div className="m-usage__detail">
          {snapshot.bars.map((b) => (
            <div key={b.label} style={{ color: rgb(PALETTE_RGB[b.palette]) }}>
              {b.error ? b.label : `${b.label} ${pct(b.usage)} · ${pct(b.time)} elapsed`}
            </div>
          ))}
          {snapshot.updatedAt !== null && (
            <div className="m-usage__when">
              Read {new Date(snapshot.updatedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} ({ageText(now - snapshot.updatedAt)} ago)
            </div>
          )}
        </div>
      )}
      <span className="m-usage__bars">
        {snapshot.bars.map((b) => <Bar key={b.label} bar={b} />)}
      </span>
    </div>
  )
}
