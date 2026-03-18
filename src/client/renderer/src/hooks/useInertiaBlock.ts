import { useCallback, useEffect, useRef } from 'react'
import { INERTIA_BLOCK_TIMEOUT, INERTIA_ANGLE_THRESHOLD, INERTIA_RATE_TOLERANCE, INERTIA_RECENT_THRESHOLD } from '../lib/constants'

/** Shortest signed angle between two angles in radians. */
function angleDiff(a: number, b: number): number {
  let d = a - b
  if (d > Math.PI) d -= 2 * Math.PI
  else if (d < -Math.PI) d += 2 * Math.PI
  return Math.abs(d)
}

function deg(rad: number): string { return (rad * 180 / Math.PI).toFixed(1) }

// ── Rolling debug log (3-second window) ─────────────────────────────────────

const DEBUG_BUFFER_MAX_AGE_MS = 3000

interface LogEntry { time: number; line: string }

const logBuffer: LogEntry[] = []

function debugLog(line: string) {
  const now = performance.now()
  logBuffer.push({ time: now, line })
  while (logBuffer.length > 0 && now - logBuffer[0].time > DEBUG_BUFFER_MAX_AGE_MS) {
    logBuffer.shift()
  }
}

/** Dump the rolling buffer as a timestamped string and clear it. */
export function dumpInertiaLog(): string {
  const lines = logBuffer.map(e => {
    const sec = (e.time / 1000).toFixed(3)
    return `${sec}  ${e.line}`
  })
  logBuffer.length = 0
  return lines.join('\n')
}

// ── Hook ────────────────────────────────────────────────────────────────────

/** Gap between events longer than this resets the peak — it's a new gesture. */
const PEAK_RESET_GAP = 500

interface BlockState {
  baselineAngle: number
  baselineRate: number // peak px/ms from the gesture — the ceiling for inertia
  timer: number
}

/**
 * Suppresses residual scroll momentum after a focus-related camera flyTo.
 *
 * All speed comparisons use rate (px/ms) so they're frame-rate-independent.
 * The baseline uses the **peak** rate from the current scroll gesture (not
 * the instantaneous rate at click time) so that late-in-gesture clicks still
 * have a high enough ceiling to absorb the remaining inertia.
 */
export function useInertiaBlock() {
  // Continuously updated on every wheel event — captures pre-click scroll state.
  // peakRate tracks the max rate in the current gesture (resets after a 500ms gap).
  const latestRef = useRef<{ angle: number; rate: number; peakRate: number; time: number } | null>(null)

  const blockRef = useRef<BlockState | null>(null)

  const clear = useCallback(() => {
    if (blockRef.current) {
      debugLog(`[block] CLEAR`)
      clearTimeout(blockRef.current.timer)
      blockRef.current = null
    }
  }, [])

  const activate = useCallback(() => {
    clear()
    const latest = latestRef.current
    const age = latest ? performance.now() - latest.time : Infinity
    debugLog(`[activate] latest=${latest ? `rate=${latest.rate.toFixed(3)} peakRate=${latest.peakRate.toFixed(3)} angle=${deg(latest.angle)} age=${age.toFixed(0)}ms` : 'none'} threshold=${INERTIA_RECENT_THRESHOLD}ms`)
    if (latest && age < INERTIA_RECENT_THRESHOLD) {
      blockRef.current = {
        baselineAngle: latest.angle,
        baselineRate: latest.peakRate,
        timer: window.setTimeout(clear, INERTIA_BLOCK_TIMEOUT)
      }
      debugLog(`[activate] BLOCK CREATED baselineRate=${latest.peakRate.toFixed(3)} baselineAngle=${deg(latest.angle)}`)
    } else {
      debugLog(`[activate] NO BLOCK (not recent enough)`)
    }
  }, [clear])

  const check = useCallback((deltaX: number, deltaY: number): boolean => {
    const now = performance.now()
    const dt = latestRef.current ? now - latestRef.current.time : 16
    const speed = Math.hypot(deltaX, deltaY)
    const rate = speed / Math.max(dt, 1) // px/ms

    // Only update angle from events with meaningful deltas — tiny events
    // (e.g. dx=0 dy=-1) have unreliable angles that poison the baseline.
    const angle = speed >= 3
      ? Math.atan2(deltaY, deltaX)
      : (latestRef.current?.angle ?? Math.atan2(deltaY, deltaX))

    // Track peak rate within the current gesture; reset after a gap
    const peakRate = (latestRef.current && dt < PEAK_RESET_GAP)
      ? Math.max(latestRef.current.peakRate, rate)
      : rate
    latestRef.current = { angle, rate, peakRate, time: now }

    const block = blockRef.current
    if (!block) {
      debugLog(`[wheel] dx=${deltaX.toFixed(1)} dy=${deltaY.toFixed(1)} rate=${rate.toFixed(3)} peak=${peakRate.toFixed(3)} dt=${dt.toFixed(0)}ms angle=${deg(angle)} → PASS (no block)`)
      return false
    }

    clearTimeout(block.timer)
    block.timer = window.setTimeout(clear, INERTIA_BLOCK_TIMEOUT)

    const ad = angleDiff(angle, block.baselineAngle)
    const rateThreshold = block.baselineRate + Math.max(INERTIA_RATE_TOLERANCE, block.baselineRate * 0.5)

    // Only trust angle from events with meaningful deltas
    if (speed >= 3 && ad > INERTIA_ANGLE_THRESHOLD) {
      debugLog(`[wheel] dx=${deltaX.toFixed(1)} dy=${deltaY.toFixed(1)} rate=${rate.toFixed(3)} dt=${dt.toFixed(0)}ms angle=${deg(angle)} → UNBLOCK (angleDiff=${deg(ad)})`)
      clear()
      return false
    }

    if (rate > rateThreshold) {
      debugLog(`[wheel] dx=${deltaX.toFixed(1)} dy=${deltaY.toFixed(1)} rate=${rate.toFixed(3)} dt=${dt.toFixed(0)}ms angle=${deg(angle)} → UNBLOCK (rate ${rate.toFixed(3)} > threshold ${rateThreshold.toFixed(3)}, baseline=${block.baselineRate.toFixed(3)})`)
      clear()
      return false
    }

    debugLog(`[wheel] dx=${deltaX.toFixed(1)} dy=${deltaY.toFixed(1)} rate=${rate.toFixed(3)} dt=${dt.toFixed(0)}ms angle=${deg(angle)} → BLOCK (angleDiff=${deg(ad)} rateThreshold=${rateThreshold.toFixed(3)})`)
    return true
  }, [clear])

  useEffect(() => () => clear(), [clear])

  return { activate, check }
}
