/**
 * A device's own system volume — the phone's or the Mac's, not Spotify's —
 * for Control's device_volume tool. See src/server/device-volume.ts.
 */
export interface VolumeReading {
  /** 0–100. */
  percent: number
  /** Only the Mac says; a phone has no system mute an app can read. */
  muted?: boolean
}

export function isVolumeReading(value: unknown): value is VolumeReading {
  if (typeof value !== 'object' || value === null) return false
  const { percent, muted } = value as Record<string, unknown>
  return typeof percent === 'number' && Number.isFinite(percent) && percent >= 0 && percent <= 100 &&
    (muted === undefined || typeof muted === 'boolean')
}
