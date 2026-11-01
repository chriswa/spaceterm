import { afterEach, describe, expect, it, vi } from 'vitest'
import { currentLocation } from './native-location'

const fix = { latitude: 49.28, longitude: -123.12, accuracyMeters: 12, timestamp: 1_700_000_000_000 }

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
          ok({ coords: { latitude: fix.latitude, longitude: fix.longitude, accuracy: 12, altitude: null }, timestamp: fix.timestamp }),
      },
    })
    await expect(currentLocation()).resolves.toEqual(fix)
  })

  it('says why when the browser refuses', async () => {
    vi.stubGlobal('navigator', {
      geolocation: { getCurrentPosition: (_ok: unknown, fail: (e: unknown) => void) => fail({ code: 1, message: 'User denied' }) },
    })
    await expect(currentLocation()).rejects.toThrow('location permission was denied on this device')
  })
})
