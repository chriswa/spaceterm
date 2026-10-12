import { describe, it, expect } from 'vitest'
import { outputKind } from './audio-output'

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
