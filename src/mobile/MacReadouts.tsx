import { useEffect, useRef, useState } from 'react'
import { SystemStatsDetail, SystemStatsPicture, useSystemStats } from './SystemStatsReadout'
import { UsageBars, UsageDetail, useUsageReport } from './UsageReadout'
import { ProviderStatusChips, ProviderStatusDetail } from './ProviderStatusReadout'
import { providerState } from './provider-status'
import { useApprovalsStore } from './approvals-store'

/**
 * The Mac's readouts on the bottom bar's left, stacked against Control: the
 * AI usage over its system monitor, with opProxy's time left beside the
 * monitor (ProviderStatusReadout.tsx) — not beside the usage, whose width
 * depends on the server. Tapping any of them opens one panel with every set
 * of figures; tapping again closes it, and so does touching anything else on
 * the page.
 */
export function MacReadouts() {
  const usage = useUsageReport()
  const stats = useSystemStats()
  const sources = useApprovalsStore((s) => s.snapshot.sources)
  const [open, setOpen] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const root = useRef<HTMLDivElement>(null)

  const hasUsage = usage !== null && usage.bars.length > 0
  const hasStats = stats !== null && stats.widgets.length > 0
  const hasProvider = sources.some((s) => providerState(s) !== null)

  // Every time shown is in minutes.
  useEffect(() => {
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [open])

  // Captured, so a canvas pan or a button that stops its own events still closes it.
  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [open])

  if (!hasUsage && !hasStats && !hasProvider) return null

  return (
    <div ref={root} className="m-bar__readouts" onClick={() => setOpen((o) => !o)}>
      {open && (
        <div className="m-detail" role="dialog" aria-label="Mac readouts">
          {hasStats && <SystemStatsDetail snapshot={stats} />}
          {hasProvider && <ProviderStatusDetail sources={sources} now={now} />}
          {hasUsage && <UsageDetail snapshot={usage} now={now} />}
        </div>
      )}
      {hasUsage && <UsageBars snapshot={usage} />}
      {(hasStats || hasProvider) && (
        <div className="m-bar__readouts-row">
          {hasProvider && <ProviderStatusChips sources={sources} now={now} />}
          {hasStats && <SystemStatsPicture snapshot={stats} />}
        </div>
      )}
    </div>
  )
}
