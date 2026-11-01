/**
 * The user's position, as a client device reads it for an agent that asked
 * (`get_user_location`, `spaceterm-cli location`).
 *
 * The server holds no position of its own: it asks the connected clients when
 * an agent asks, and passes on the first good answer from the device the user
 * is most likely holding (src/server/location-broker.ts). Nothing is stored.
 */

export interface LocationFix {
  latitude: number
  longitude: number
  /** Radius of 68% confidence, in metres. */
  accuracyMeters: number
  /** Above sea level, when the device knows it. */
  altitudeMeters?: number
  /** When the device took the reading, ms since the epoch: a cached fix can be minutes old. */
  timestamp: number
}

/** How long a client spends finding a fix before it answers with why it could not. */
export const CLIENT_LOCATION_TIMEOUT_MS = 15_000
/** Clock slack allowed between a reading's stamp and the request it answers. */
const FRESHNESS_SLACK_MS = 1_000

/**
 * Whether a reading was taken for this request rather than cached before it.
 * A stale position passed off as current would mislead an agent, so a
 * reading that fails this is an error, not an answer.
 */
export function isFreshFix(fix: LocationFix, askedAt: number): boolean {
  return fix.timestamp >= askedAt - FRESHNESS_SLACK_MS
}

const STALE_ERROR = 'this device could only give a cached position, not a fresh one'

export function isLocationFix(value: unknown): value is LocationFix {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n)
  return finite(v.latitude) && Math.abs(v.latitude) <= 90
    && finite(v.longitude) && Math.abs(v.longitude) <= 180
    && finite(v.accuracyMeters) && v.accuracyMeters >= 0
    && finite(v.timestamp)
    && (v.altitudeMeters === undefined || finite(v.altitudeMeters))
}

/**
 * The part of the W3C `Geolocation` interface used here, declared structurally
 * because this file is also compiled without the DOM library (the preload).
 */
export interface GeolocationLike {
  getCurrentPosition(
    success: (position: {
      coords: { latitude: number; longitude: number; accuracy: number; altitude: number | null }
      timestamp: number
    }) => void,
    error: (error: { code: number; message: string }) => void,
    options: { enableHighAccuracy: boolean; timeout: number; maximumAge: number },
  ): void
}

/** The W3C error codes, as something an agent can repeat to the user. */
const GEOLOCATION_ERRORS: Record<number, string> = {
  1: 'location permission was denied on this device',
  2: 'this device could not determine its position',
  3: 'this device could not get a fresh position in time',
}

/**
 * One fix from the W3C Geolocation API — Electron's renderer, Safari, the
 * iPhone app's web view on an app too old to answer natively. Rejects with a
 * reason worded for the user.
 */
export function readGeolocation(geolocation: GeolocationLike | undefined, now: () => number = Date.now): Promise<LocationFix> {
  if (!geolocation) return Promise.reject(new Error('this device has no location service'))
  const askedAt = now()
  return new Promise((resolve, reject) => {
    geolocation.getCurrentPosition(
      (position) => {
        const fix: LocationFix = {
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracyMeters: position.coords.accuracy,
          ...(position.coords.altitude === null ? {} : { altitudeMeters: position.coords.altitude }),
          timestamp: position.timestamp,
        }
        if (isFreshFix(fix, askedAt)) resolve(fix)
        else reject(new Error(STALE_ERROR))
      },
      (error) => reject(new Error(GEOLOCATION_ERRORS[error.code] ?? (error.message || 'location failed'))),
      // No cached reading: only one taken now will do.
      { enableHighAccuracy: true, timeout: CLIENT_LOCATION_TIMEOUT_MS, maximumAge: 0 },
    )
  })
}
