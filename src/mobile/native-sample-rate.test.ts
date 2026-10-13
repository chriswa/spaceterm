import { describe, it, expect, vi } from 'vitest'

describe('onNativeSampleRate', () => {
  it('follows the running microphone link\'s rate, and forgets it when the microphone stops', async () => {
    vi.resetModules()
    ;(window as unknown as { webkit: unknown }).webkit = { messageHandlers: { nativeMicrophone: { postMessage: () => {} } } }
    delete (window as unknown as { spacetermNativeMicrophone?: unknown }).spacetermNativeMicrophone
    const { onNativeSampleRate } = await import('./native-microphone')
    const rates: Array<number | undefined> = []
    const stop = onNativeSampleRate((rate) => rates.push(rate))
    window.spacetermNativeMicrophone?.state({ running: true, input: 'AirPods', sampleRate: 24000 })
    window.spacetermNativeMicrophone?.state({ running: true, input: 'AirPods', sampleRate: 24000 })
    window.spacetermNativeMicrophone?.state({ running: true, input: 'AirPods', sampleRate: 48000 })
    window.spacetermNativeMicrophone?.state({ running: false })
    expect(rates).toEqual([undefined, 24000, 48000, undefined])
    stop()
  })
})
