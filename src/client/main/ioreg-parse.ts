import type { GpuUtilization, PowerSample } from '../../shared/system-metrics'

/**
 * Readers for the two `ioreg` dumps the power monitor samples.
 *
 * Split from `system-metrics.ts` so it can be tested: that module imports
 * `electron` for `app.getAppMetrics()`, and a suite importing it would need an
 * Electron runtime to check a regex. Everything here is string in, numbers out.
 */

/**
 * `ioreg` prints unsigned 64-bit words, so a negative current — which is what
 * discharging looks like — arrives as a number just under 2^64.
 */
function toSigned64(raw: string): number | null {
  let value: bigint
  try {
    value = BigInt(raw)
  } catch {
    return null
  }
  if (value >= 1n << 63n) value -= 1n << 64n
  return Number(value)
}

function shortenAcceleratorName(ioClass: string): string {
  if (ioClass.startsWith('AMDRadeon')) return 'AMD'
  if (ioClass.startsWith('Intel')) return 'Intel'
  if (ioClass.startsWith('AGX')) return 'Apple'
  if (ioClass.startsWith('NV')) return 'NVIDIA'
  return ioClass
}

/**
 * Pull `Device Utilization %` out of `ioreg -r -d 1 -w 0 -c IOAccelerator`.
 *
 * Each accelerator is one `+-o <name> <class …>` block. A dual-GPU MacBook
 * lists both, and *which* of them is busy is the single biggest battery
 * variable on that hardware — a theme that wakes the discrete GPU costs far
 * more than one the integrated GPU can keep up with. So both are returned
 * rather than collapsed to a maximum.
 *
 * The same accelerator appears once per client, so the highest reading for a
 * class wins; an accelerator with no client publishes no `PerformanceStatistics`
 * at all and is skipped.
 */
export function parseGpuUtilization(ioregOutput: string): GpuUtilization[] {
  const byName = new Map<string, number>()
  // Split on the record header rather than parsing the whole plist grammar:
  // everything needed is a flat `"key"=value` inside one block.
  for (const block of ioregOutput.split(/^\+-o /m).slice(1)) {
    const name = block.slice(0, block.indexOf(' ')).trim()
    if (!name) continue
    const match = /"Device Utilization %"=(\d+)/.exec(block)
    if (!match) continue
    byName.set(name, Math.max(byName.get(name) ?? 0, Number(match[1])))
  }
  return [...byName].map(([name, utilization]) => ({
    name,
    shortName: shortenAcceleratorName(name),
    utilization,
  }))
}

/**
 * Derive discharge power from `ioreg -rn AppleSmartBattery -w 0`.
 *
 * Watts are amps × volts: the battery reports current in mA and terminal
 * voltage in mV, so the product is the whole machine's draw — screen, CPU, GPU
 * and all. On AC there is no discharge to measure and `watts` is `null` rather
 * than 0, since 0 would read as "costs nothing".
 *
 * Keys are matched with the ` = ` separator that only top-level properties
 * use. The same names recur inside the `BatteryData` and `LegacyBatteryInfo`
 * dictionaries written as `"Key"=value`, with different meanings.
 */
export function parseBatteryPower(ioregOutput: string): PowerSample | null {
  const readNumber = (key: string): number | null => {
    const match = new RegExp(`"${key}" = (-?\\d+)`).exec(ioregOutput)
    return match ? toSigned64(match[1]) : null
  }
  const readBool = (key: string): boolean | null => {
    const match = new RegExp(`"${key}" = (Yes|No)`).exec(ioregOutput)
    return match ? match[1] === 'Yes' : null
  }

  const voltageMv = readNumber('Voltage')
  if (voltageMv === null) return null

  // InstantAmperage tracks the current sub-second draw; Amperage is smoothed
  // over minutes. The instantaneous one is what makes a shader switch visible
  // without waiting for the average to catch up.
  const amperageMa = readNumber('InstantAmperage') ?? readNumber('Amperage')
  const onAc = readBool('ExternalConnected') ?? false
  const charging = readBool('IsCharging') ?? false
  const tempRaw = readNumber('Temperature')
  const current = readNumber('CurrentCapacity')
  const max = readNumber('MaxCapacity')

  // Negative amperage means discharging. On AC the sign flips and the figure
  // describes the charger rather than the load, so there is nothing to report.
  const discharging = !onAc && amperageMa !== null && amperageMa < 0
  const watts = discharging ? (Math.abs(amperageMa) / 1000) * (voltageMv / 1000) : null

  return {
    watts,
    onAc,
    charging,
    tempC: tempRaw === null ? null : tempRaw / 100,
    percent: current !== null && max ? Math.round((current / max) * 100) : null,
  }
}
