import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { SystemStatsDetail, SystemStatsPicture, useSystemStats } from './SystemStatsReadout'
import { UsageBars, UsageDetail, useUsageReport } from './UsageReadout'

/**
 * The Mac's readouts on the bottom bar's left, stacked against Control: the
 * AI usage over its system monitor. Tapping either opens one panel with
 * every set of figures; tapping again closes it, and so does touching
 * anything else on the page.
 *
 * The panel is portalled to the body: the bar is a stacking context under
 * Control's transcript, so anything left inside it is drawn under that too.
 */
export function MacReadouts() {
  const usage = useUsageReport()
  const stats = useSystemStats()
  const [open, setOpen] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const root = useRef<HTMLDivElement>(null)
  const panel = useRef<HTMLDivElement>(null)

  const hasUsage = usage !== null && usage.bars.length > 0
  const hasStats = stats !== null && stats.widgets.length > 0

  // The panel's times only show minutes.
  useEffect(() => {
    if (!open) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [open])

  // Captured, so a canvas pan or a button that stops its own events still closes it.
  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node
      if (!root.current?.contains(target) && !panel.current?.contains(target)) setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [open])

  if (!hasUsage && !hasStats) return null

  return (
    <div ref={root} className="m-bar__readouts" onClick={() => setOpen((o) => !o)}>
      {/* A portal's clicks still bubble to the readouts, so a tap on it closes it. */}
      {open && createPortal(
        <div ref={panel} className="m-detail" role="dialog" aria-label="Mac readouts">
          {hasStats && <SystemStatsDetail snapshot={stats} />}
          {hasUsage && <UsageDetail snapshot={usage} now={now} />}
        </div>,
        document.body
      )}
      {hasUsage && <UsageBars snapshot={usage} />}
      {hasStats && <SystemStatsPicture snapshot={stats} />}
    </div>
  )
}
