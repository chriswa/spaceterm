import { afterEach, describe, expect, it, vi } from 'vitest'
import { currentLocation } from './native-location'

// Stamped ahead of every request in this file, so it always counts as fresh.
const fix = { latitude: 49.28, longitude: -123.12, accuracyMeters: 12, timestamp: Date.now() + 60_000 }

afterEach(() => {
  delete window.webkit
  delete window.spacetermNativeLocation
  vi.unstubAllGlobals()
})

describe('currentLocation', () => {
  it('asks the iPhone app when it is there, and takes its fix', async () => {
    const posted: Array<{ id: string }> = []
    window.webkit = { messageHandlers: { nativeLocation: { postMessage: (m) => posted.push(m as { id: string }) } } }
    const reading = currentLocation()
    expect(posted).toHaveLength(1)
    window.spacetermNativeLocation?.reply(posted[0].id, { fix })
    await expect(reading).resolves.toEqual(fix)
  })

  it('passes on the app’s reason for having no fix', async () => {
    const posted: Array<{ id: string }> = []
    window.webkit = { messageHandlers: { nativeLocation: { postMessage: (m) => posted.push(m as { id: string }) } } }
    const reading = currentLocation()
    window.spacetermNativeLocation?.reply(posted[0].id, { error: 'location permission was denied on this device' })
    await expect(reading).rejects.toThrow('denied')
  })

  it('uses the browser’s location service outside the app', async () => {
    vi.stubGlobal('navigator', {
      geolocation: {
        getCurrentPosition: (ok: (p: unknown) => void) =>
          ok({ coords: { latitude: fix.latitude, longitude: fix.longitude, accuracy: 12, altitude: null }, timestamp: Date.now() }),
      },
    })
    await expect(currentLocation()).resolves.toMatchObject({ latitude: fix.latitude, longitude: fix.longitude, accuracyMeters: 12 })
  })

  it('says why when the browser refuses', async () => {
    vi.stubGlobal('navigator', {
      geolocation: { getCurrentPosition: (_ok: unknown, fail: (e: unknown) => void) => fail({ code: 1, message: 'User denied' }) },
    })
    await expect(currentLocation()).rejects.toThrow('location permission was denied on this device')
  })
})

describe('currentLocation freshness', () => {
  it('refuses a cached fix from the app rather than passing it off as current', async () => {
    const posted: Array<{ id: string }> = []
    window.webkit = { messageHandlers: { nativeLocation: { postMessage: (m) => posted.push(m as { id: string }) } } }
    const reading = currentLocation()
    window.spacetermNativeLocation?.reply(posted[0].id, { fix: { ...fix, timestamp: Date.now() - 10 * 60_000 } })
    await expect(reading).rejects.toThrow('cached position')
  })

  it('takes a fix the app read just now', async () => {
    const posted: Array<{ id: string }> = []
    window.webkit = { messageHandlers: { nativeLocation: { postMessage: (m) => posted.push(m as { id: string }) } } }
    const reading = currentLocation()
    const now = { ...fix, timestamp: Date.now() }
    window.spacetermNativeLocation?.reply(posted[0].id, { fix: now })
    await expect(reading).resolves.toEqual(now)
  })

  it('refuses a cached reading from the browser, and asks it for none', async () => {
    let options: { maximumAge: number } | undefined
    vi.stubGlobal('navigator', {
      geolocation: {
        getCurrentPosition: (ok: (p: unknown) => void, _fail: unknown, o: { maximumAge: number }) => {
          options = o
          ok({ coords: { latitude: 1, longitude: 2, accuracy: 5, altitude: null }, timestamp: Date.now() - 120_000 })
        },
      },
    })
    await expect(currentLocation()).rejects.toThrow('cached position')
    expect(options?.maximumAge).toBe(0)
  })
})
