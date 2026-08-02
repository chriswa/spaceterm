/**
 * The power/utilisation readout pushed from main to the renderer's power monitor.
 *
 * ## Why the numbers have different scopes, and why the type says so
 *
 * Only `cpu` is *ours*. `gpus` and `power` are whole-machine figures read out
 * of the macOS IORegistry, because there is no per-process GPU time or power
 * attribution without `powermetrics`, which needs root. Comparing two canvas
 * themes with these numbers therefore means holding the rest of the machine
 * still between measurements — the field names carry the scope so a reader of
 * the toolbar is not misled into thinking the watts are Spaceterm's alone.
 *
 * Sampled in `src/client/main/system-metrics.ts`; rendered by the
 * `power-monitor` toolbar widget.
 */
export interface SystemMetricsSample {
  /** Milliseconds the CPU percentages are averaged over. */
  intervalMs: number
  /** Spaceterm's own processes, split by role. Percent of one core. */
  cpu: {
    total: number
    gpuProcess: number
    renderers: number
    main: number
  }
  /** Whole-machine GPU busy percentage, one entry per accelerator. */
  gpus: GpuUtilization[]
  /** Whole-machine battery draw. `null` if the battery could not be read. */
  power: PowerSample | null
}

export interface GpuUtilization {
  /** IORegistry class, e.g. `AMDRadeonX4000_AMDBaffinGraphicsAccelerator`. */
  name: string
  /** Short display name, e.g. `AMD` / `Intel`. */
  shortName: string
  /** Percent of the device busy, 0–100. */
  utilization: number
}

export interface PowerSample {
  /** Whole-machine discharge in watts. `null` on AC — nothing is discharging. */
  watts: number | null
  onAc: boolean
  charging: boolean
  /** Battery temperature in °C. The only temperature readable without root. */
  tempC: number | null
  /** Charge remaining, 0–100. */
  percent: number | null
}
