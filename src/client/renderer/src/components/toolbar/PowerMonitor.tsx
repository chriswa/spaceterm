import { useEffect, useState } from 'react'
import type { SystemMetricsSample } from '../../../../../shared/system-metrics'
import { usePowerMonitorStore } from '../../stores/powerMonitorStore'
import { useThemeStore } from '../../stores/themeStore'

/**
 * A live GPU / CPU / watts readout, for telling two canvas themes apart by
 * what they cost rather than by how warm the laptop feels an hour later.
 *
 * ## What it can and cannot attribute
 *
 * The CPU figure is Spaceterm's own processes. The GPU percentages and the
 * watts are whole-machine — macOS attributes neither per process without root
 * — so the way to use this is a controlled comparison: leave the window doing
 * the same thing, switch theme, and read the average once it settles. The
 * average resets itself on a theme switch for exactly that reason, and can be
 * reset by hand by clicking the readout.
 *
 * Diagnostic scaffolding, off by default, toggled from the debug menu.
 */

/** Samples arrive at 1 Hz, so this is a one-minute mean. */
const AVERAGE_WINDOW = 60

function mean(values: number[]): number | null {
  if (values.length === 0) return null
  return values.reduce((a, b) => a + b, 0) / values.length
}

export function PowerMonitor() {
  const enabled = usePowerMonitorStore(s => s.enabled)
  const themeId = useThemeStore(s => s.themeId)
  const [sample, setSample] = useState<SystemMetricsSample | null>(null)
  const [wattsHistory, setWattsHistory] = useState<number[]>([])

  useEffect(() => {
    window.api.system.setMetricsEnabled(enabled)
    if (!enabled) {
      setSample(null)
      setWattsHistory([])
      return
    }
    const unsubscribe = window.api.system.onMetrics((next) => {
      const watts = next.power?.watts
      if (watts != null) setWattsHistory(prev => [...prev, watts].slice(-AVERAGE_WINDOW))
      setSample(next)
    })
    return () => {
      unsubscribe()
      window.api.system.setMetricsEnabled(false)
    }
  }, [enabled])

  // Averaging across a theme switch would blend the thing being measured with
  // the thing it replaced, which is precisely the comparison being made.
  useEffect(() => { setWattsHistory([]) }, [themeId])

  if (!enabled) return null

  if (!sample) {
    return (
      <span className="toolbar__status-item toolbar__metric" data-tooltip="Power monitor — waiting for first sample" data-tooltip-no-flip>
        <span className="toolbar__metric-label">measuring…</span>
      </span>
    )
  }

  const busiestGpu = sample.gpus.reduce<SystemMetricsSample['gpus'][number] | null>(
    (best, gpu) => (best === null || gpu.utilization > best.utilization ? gpu : best),
    null,
  )
  const gpuTooltip = sample.gpus.length > 0
    ? 'GPU busy (whole machine) — ' + sample.gpus.map(g => `${g.shortName} ${g.utilization}%`).join(', ')
    : 'GPU busy — no accelerator reported statistics'

  const cpuTooltip =
    `Spaceterm CPU, % of one core — main ${sample.cpu.main.toFixed(0)}, ` +
    `renderer ${sample.cpu.renderers.toFixed(0)}, GPU process ${sample.cpu.gpuProcess.toFixed(0)}`

  const power = sample.power
  const avgWatts = mean(wattsHistory)

  return (
    <span
      className="toolbar__status-item toolbar__metric toolbar__power"
      onClick={() => setWattsHistory([])}
      data-tooltip="Click to restart the running average"
      data-tooltip-no-flip
    >
      <span className="toolbar__power-part" data-tooltip={gpuTooltip} data-tooltip-no-flip>
        {busiestGpu ? `${busiestGpu.shortName} ${busiestGpu.utilization}` : '—'}
        <span className="toolbar__metric-label">% gpu</span>
      </span>

      <span className="toolbar__power-part" data-tooltip={cpuTooltip} data-tooltip-no-flip>
        {sample.cpu.total.toFixed(0)}
        <span className="toolbar__metric-label">% cpu</span>
      </span>

      <span
        className="toolbar__power-part"
        data-tooltip={
          power?.watts != null
            ? `Whole-machine battery draw. Mean of the last ${wattsHistory.length}s${power.tempC != null ? `. Battery ${power.tempC.toFixed(1)}°C` : ''}`
            : 'On AC — battery draw is only measurable while discharging'
        }
        data-tooltip-no-flip
      >
        {power?.watts != null ? (
          <>
            {power.watts.toFixed(1)}
            <span className="toolbar__metric-label">W</span>
            {avgWatts != null && <span className="toolbar__power-mean">⌀{avgWatts.toFixed(1)}</span>}
          </>
        ) : (
          <span className="toolbar__metric-label">{power?.onAc ? 'on AC' : 'no battery'}</span>
        )}
      </span>
    </span>
  )
}
