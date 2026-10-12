import { describe, it, expect, afterEach, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { OUTPUT_SETTLE_MS, outputKind, useAudioOutput } from './audio-output'

const route = (output: string, outputType: string) =>
  act(() => window.spacetermNativeMicrophone?.state({ running: false, output, outputType }))

afterEach(() => {
  vi.useRealTimers()
  delete (window as { webkit?: unknown }).webkit
})

describe('outputKind', () => {
  it('tells the speaker, the earpiece and headphones apart', () => {
    expect(outputKind('Speaker')).toBe('speaker')
    expect(outputKind('Receiver')).toBe('earpiece')
    expect(outputKind('BluetoothA2DPOutput')).toBe('headphones')
    expect(outputKind('BluetoothHFP')).toBe('headphones')
    expect(outputKind('BluetoothLE')).toBe('headphones')
    expect(outputKind('Headphones')).toBe('headphones')
    expect(outputKind('AirPlay')).toBe('other')
  })
})

describe('useAudioOutput', () => {
  it('shows the first route at once, and a new one only once it has held', () => {
    vi.useFakeTimers()
    window.webkit = { messageHandlers: { nativeMicrophone: { postMessage: () => {} } } }
    const { result } = renderHook(() => useAudioOutput())
    route('AirPods', 'BluetoothA2DPOutput')
    expect(result.current?.type).toBe('BluetoothA2DPOutput')

    // Pressing the microphone: the earpiece for a moment, then AirPods' voice link.
    route('Receiver', 'Receiver')
    act(() => { vi.advanceTimersByTime(700) })
    route('AirPods', 'BluetoothHFP')
    act(() => { vi.advanceTimersByTime(OUTPUT_SETTLE_MS - 1) })
    expect(result.current?.type).toBe('BluetoothA2DPOutput')
    act(() => { vi.advanceTimersByTime(1) })
    expect(result.current?.type).toBe('BluetoothHFP')

    // AirPods put away: the speaker, once it has held.
    route('Speaker', 'Speaker')
    act(() => { vi.advanceTimersByTime(OUTPUT_SETTLE_MS) })
    expect(result.current?.name).toBe('Speaker')
  })
})
