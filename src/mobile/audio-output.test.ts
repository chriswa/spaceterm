import { describe, it, expect, vi } from 'vitest'
import { followOutput, outputKind } from './audio-output'

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

describe('followOutput', () => {
  it('shows the earpiece only once it has stayed, not on the way between AirPods links', () => {
    vi.useFakeTimers()
    let send: (o: { name: string; type: string } | undefined) => void = () => {}
    const shown: Array<string | undefined> = []
    const stop = followOutput((fn) => { send = fn; return () => {} }, (o) => shown.push(o?.type), 1000)
    send({ name: 'AirPods', type: 'BluetoothA2DPOutput' })
    send({ name: 'Receiver', type: 'Receiver' })
    vi.advanceTimersByTime(500)
    send({ name: 'AirPods', type: 'BluetoothHFP' })
    vi.advanceTimersByTime(2000)
    expect(shown).toEqual(['BluetoothA2DPOutput', 'BluetoothHFP'])
    send({ name: 'Receiver', type: 'Receiver' })
    vi.advanceTimersByTime(1000)
    expect(shown.at(-1)).toBe('Receiver')
    stop()
    vi.useRealTimers()
  })
})
