import { app } from 'electron'
import { execFile } from 'child_process'
import { promisify } from 'util'
import * as logger from './logger'
import type { SystemMetricsSample } from '../../shared/system-metrics'
import { parseBatteryPower, parseGpuUtilization } from './ioreg-parse'

const execFileAsync = promisify(execFile)

/**
 * Sampling loop behind the renderer's power monitor.
 *
 * The shape delivered to the renderer — and the caveats about what is
 * whole-machine and what is ours — lives in `src/shared/system-metrics.ts`,
 * since both sides of the bridge need it. Reading the numbers out of `ioreg`
 * output is `./ioreg-parse`. This file is only the timer.
 */

/* ------------------------------------------------------------------ */
/*  Sampling                                                           */
/* ------------------------------------------------------------------ */

/** ~6ms of CPU per sample pair, measured — well under the signal being read. */
const SAMPLE_INTERVAL_MS = 1000

async function readIoreg(args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('ioreg', args, { maxBuffer: 4 * 1024 * 1024 })
    return stdout
  } catch (err: unknown) {
    logger.log('[metrics] ioreg failed: ' + (err instanceof Error ? err.message : String(err)))
    return null
  }
}

function sampleCpu(): SystemMetricsSample['cpu'] {
  const cpu = { total: 0, gpuProcess: 0, renderers: 0, main: 0 }
  for (const metric of app.getAppMetrics()) {
    const percent = metric.cpu?.percentCPUUsage ?? 0
    cpu.total += percent
    if (metric.type === 'GPU') cpu.gpuProcess += percent
    else if (metric.type === 'Tab') cpu.renderers += percent
    else if (metric.type === 'Browser') cpu.main += percent
  }
  return cpu
}

async function collectSample(intervalMs: number): Promise<SystemMetricsSample> {
  const [gpuOut, batteryOut] = await Promise.all([
    readIoreg(['-r', '-d', '1', '-w', '0', '-c', 'IOAccelerator']),
    readIoreg(['-rn', 'AppleSmartBattery', '-w', '0']),
  ])
  return {
    intervalMs,
    cpu: sampleCpu(),
    gpus: gpuOut ? parseGpuUtilization(gpuOut) : [],
    power: batteryOut ? parseBatteryPower(batteryOut) : null,
  }
}

let timer: NodeJS.Timeout | null = null
let lastSampleAt = 0

/**
 * Begin sampling, delivering each reading to `send`.
 *
 * Idempotent: calling it while already running is a no-op, so the renderer may
 * re-subscribe on reload without stacking timers. Nothing is sampled — and no
 * `ioreg` is spawned — until this is called, which is what keeps a debug
 * readout from costing anything while it is switched off.
 */
export function startSystemMetrics(send: (sample: SystemMetricsSample) => void): void {
  if (timer) return
  logger.log('[metrics] system metrics sampling started')
  lastSampleAt = Date.now()
  let inFlight = false
  timer = setInterval(() => {
    // A slow `ioreg` must not queue samples behind itself; skip instead.
    if (inFlight) return
    inFlight = true
    const now = Date.now()
    const intervalMs = now - lastSampleAt
    lastSampleAt = now
    collectSample(intervalMs)
      .then(send)
      .catch((err: unknown) => {
        logger.log('[metrics] sample failed: ' + (err instanceof Error ? err.message : String(err)))
      })
      .finally(() => { inFlight = false })
  }, SAMPLE_INTERVAL_MS)
}

export function stopSystemMetrics(): void {
  if (!timer) return
  clearInterval(timer)
  timer = null
  logger.log('[metrics] system metrics sampling stopped')
}
