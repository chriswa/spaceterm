import { describe, it, expect } from 'vitest'
import { parseBatteryPower, parseGpuUtilization } from './ioreg-parse'

/**
 * Fixtures are trimmed from real output on a dual-GPU Intel MacBook Pro. The
 * shapes that matter and are easy to get wrong are all here: the accelerator
 * that publishes no statistics, the near-identical `"Device Utilization % at
 * cur p-state"` key, and the unsigned-64 wraparound that a discharging
 * battery's amperage arrives as.
 */

const GPU_FIXTURE = `+-o AMDRadeonX4000_AMDBaffinGraphicsAccelerator  <class AMDRadeonX4000_AMDBaffinGraphicsAccelerator, id 0x10000052f, registered, matched, active, busy 0 (131 ms), retain 80>
  {
    "IOClass" = "AMDRadeonX4000_AMDBaffinGraphicsAccelerator"
    "PerformanceStatistics" = {"textureCount"=2263,"Device Utilization % at cur p-state"=19,"Device Unit 0 Utilization %"=10,"Device Utilization %"=6}
  }
+-o AMDRadeonX4000_AMDBaffinGraphicsAccelerator  <class AMDRadeonX4000_AMDBaffinGraphicsAccelerator, id 0x10000052f, registered, matched, active, busy 0 (131 ms), retain 79>
  {
    "IOClass" = "AMDRadeonX4000_AMDBaffinGraphicsAccelerator"
    "PerformanceStatistics" = {"textureCount"=17,"Device Utilization %"=11}
  }
+-o IntelAccelerator  <class IntelAccelerator, id 0x1000004f6, registered, matched, active, busy 0 (270 ms), retain 90>
  {
    "IOClass" = "IntelAccelerator"
    "PerformanceStatistics" = {"Device Utilization % at cur p-state"=29,"Device Utilization %"=27}
  }
+-o AppleParavirtGPU  <class AppleParavirtGPU, id 0x100000abc, registered, matched, active, busy 0 (0 ms), retain 5>
  {
    "IOClass" = "AppleParavirtGPU"
  }
`

/** Discharging: amperage is 2^64 - 1418, i.e. -1418 mA. */
const BATTERY_DISCHARGING = `+-o AppleSmartBattery  <class AppleSmartBattery, id 0x100000350, registered, matched, active, busy 0 (0 ms), retain 6>
  {
    "Voltage" = 11114
    "LegacyBatteryInfo" = {"Amperage"=18446744073709550198,"Voltage"=11114,"Cycle Count"=1080}
    "BatteryData" = {"Voltage"=11228,"Temperature"=9999,"SystemPower"=1940}
    "Temperature" = 3023
    "InstantAmperage" = 18446744073709550198
    "Amperage" = 18446744073709550198
    "CurrentCapacity" = 1769
    "MaxCapacity" = 3465
    "IsCharging" = No
    "ExternalConnected" = No
  }
`

const BATTERY_ON_AC = `+-o AppleSmartBattery  <class AppleSmartBattery, id 0x100000350, registered, matched, active, busy 0 (0 ms), retain 6>
  {
    "Voltage" = 12604
    "Temperature" = 3110
    "InstantAmperage" = 1834
    "Amperage" = 1811
    "CurrentCapacity" = 3100
    "MaxCapacity" = 3465
    "IsCharging" = Yes
    "ExternalConnected" = Yes
  }
`

describe('parseGpuUtilization', () => {
  it('reports one entry per accelerator, taking its busiest client', () => {
    expect(parseGpuUtilization(GPU_FIXTURE)).toEqual([
      { name: 'AMDRadeonX4000_AMDBaffinGraphicsAccelerator', shortName: 'AMD', utilization: 11 },
      { name: 'IntelAccelerator', shortName: 'Intel', utilization: 27 },
    ])
  })

  it('skips an accelerator that publishes no performance statistics', () => {
    const names = parseGpuUtilization(GPU_FIXTURE).map(g => g.name)
    expect(names).not.toContain('AppleParavirtGPU')
  })

  it('returns nothing for output with no accelerator records', () => {
    expect(parseGpuUtilization('')).toEqual([])
  })
})

describe('parseBatteryPower', () => {
  it('reads a discharging battery as positive watts', () => {
    const power = parseBatteryPower(BATTERY_DISCHARGING)
    // 1.418 A × 11.114 V
    expect(power?.watts).toBeCloseTo(15.76, 2)
    expect(power?.onAc).toBe(false)
    expect(power?.charging).toBe(false)
  })

  it('takes the top-level Temperature, not the one nested in BatteryData', () => {
    expect(parseBatteryPower(BATTERY_DISCHARGING)?.tempC).toBeCloseTo(30.23, 2)
  })

  it('reports charge as a percentage of current capacity', () => {
    expect(parseBatteryPower(BATTERY_DISCHARGING)?.percent).toBe(51)
  })

  it('reports no watts on AC — a charging current is not the machine\'s draw', () => {
    const power = parseBatteryPower(BATTERY_ON_AC)
    expect(power?.watts).toBeNull()
    expect(power?.onAc).toBe(true)
    expect(power?.charging).toBe(true)
  })

  it('returns null when there is no battery to read', () => {
    expect(parseBatteryPower('')).toBeNull()
  })
})
