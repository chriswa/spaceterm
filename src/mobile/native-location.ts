import { CLIENT_LOCATION_TIMEOUT_MS, isFreshFix, isLocationFix, readGeolocation, type LocationFix } from '../shared/location'

/**
 * The phone's position, for an agent that asked for the user's.
 *
 * Inside the iPhone app it comes from Core Location (`NativeLocation.swift`),
 * which asks for permission once, for the app. The web view's own
 * `navigator.geolocation` would ask on every page load.
 *
 * Only a reading taken after the request is an answer (`isFreshFix`): a
 * cached one, from a phone in the background or one that has not moved, is
 * an error, as an agent would take a stale place for where the user is now.
 * In Safari, or an app built before this existed, it is the browser's.
 *
 *   page → app:  `{id}`
 *   app → page:  `spacetermNativeLocation.reply(id, {fix} | {error})`
 */

interface NativeLocationReply {
  fix?: unknown
  error?: string
}

interface NativeLocationHost {
  reply(id: string, answer: NativeLocationReply): void
}

declare global {
  interface Window {
    spacetermNativeLocation?: NativeLocationHost
  }
}

type Handler = { postMessage(message: unknown): void }

const pending = new Map<string, (answer: NativeLocationReply) => void>()
let nextId = 0

/** Slightly longer than the app's own limit, so its reason for failing arrives first. */
const NATIVE_TIMEOUT_MS = CLIENT_LOCATION_TIMEOUT_MS + 2_000

function nativeHandler(): Handler | undefined {
  return window.webkit?.messageHandlers?.nativeLocation
}

function readNative(handler: Handler): Promise<LocationFix> {
  window.spacetermNativeLocation ??= {
    reply: (id, answer) => {
      const settle = pending.get(id)
      pending.delete(id)
      settle?.(answer)
    },
  }
  const id = String(++nextId)
  const askedAt = Date.now()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error('the iPhone app took too long to find its position'))
    }, NATIVE_TIMEOUT_MS)
    pending.set(id, (answer) => {
      clearTimeout(timer)
      // The app checks this too; an app built before it did would answer with a cached fix.
      if (isLocationFix(answer.fix) && !isFreshFix(answer.fix, askedAt)) reject(new Error('the iPhone app could only give a cached position, not a fresh one'))
      else if (isLocationFix(answer.fix)) resolve(answer.fix)
      else reject(new Error(answer.error ?? 'the iPhone app gave no position'))
    })
    handler.postMessage({ id })
  })
}

export function currentLocation(): Promise<LocationFix> {
  const handler = nativeHandler()
  return handler ? readNative(handler) : readGeolocation(typeof navigator === 'undefined' ? undefined : navigator.geolocation)
}
