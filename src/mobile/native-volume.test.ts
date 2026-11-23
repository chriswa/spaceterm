import { afterEach, describe, expect, it } from 'vitest'
import { deviceVolume } from './native-volume'

afterEach(() => {
  delete window.webkit
})

function app(answer: (message: unknown) => unknown, extra: Record<string, { postMessage(m: unknown): unknown }> = {}): unknown[] {
  const posted: unknown[] = []
  window.webkit = {
    messageHandlers: {
      ...extra,
      nativeVolume: { postMessage: async (m: unknown) => { posted.push(m); return answer(m) } },
    },
  }
  return posted
}

describe('deviceVolume', () => {
  it('reads the volume from the iPhone app', async () => {
    const posted = app(() => ({ percent: 62 }))
    await expect(deviceVolume()).resolves.toEqual({ percent: 62 })
    expect(posted).toEqual([{}])
  })

  it('asks the app to set it, and gives back what the app read afterwards', async () => {
    const posted = app((m) => ({ percent: (m as { set: number }).set }))
    await expect(deviceVolume(30)).resolves.toEqual({ percent: 30 })
    expect(posted).toEqual([{ set: 30 }])
  })

  it('passes on the app\'s reason for failing', async () => {
    app(() => ({ error: 'iOS did not change the volume; it is still at 50 percent' }))
    await expect(deviceVolume(80)).rejects.toThrow('iOS did not change the volume')
  })

  it('says to install the app again when the app predates it, and that a browser cannot', async () => {
    window.webkit = { messageHandlers: { nativeMicrophone: { postMessage: () => undefined } } }
    await expect(deviceVolume()).rejects.toThrow('install the iPhone app again')
    delete window.webkit
    await expect(deviceVolume()).rejects.toThrow('only from the Spaceterm iPhone app')
  })
})
