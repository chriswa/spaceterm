import { describe, it, expect, beforeEach } from 'vitest'
import { installFakeBridge, type FakeBridge } from '../testing/fake-bridge'
import { modChannel } from './mod-channel'

type WeatherMsg =
  | { event: 'reading'; payload: { tempC: number } }
  | { event: 'failed'; payload: { reason: string } }

let bridge: FakeBridge

beforeEach(() => { bridge = installFakeBridge() })

describe('a mod channel', () => {
  it('sends under its own modId', () => {
    modChannel<WeatherMsg>('weather').send('reading', { tempC: 12 })
    expect(bridge.callsTo('mods.send')[0].args).toEqual(['weather', 'reading', { tempC: 12 }])
  })

  it('delivers only the event asked for', () => {
    const seen: unknown[] = []
    modChannel<WeatherMsg>('weather').on('reading', (p) => seen.push(p))

    bridge.emit.modMessage('weather', 'reading', { tempC: 12 })
    bridge.emit.modMessage('weather', 'failed', { reason: 'offline' })

    expect(seen).toEqual([{ tempC: 12 }])
  })

  it('never sees another mod\'s traffic', () => {
    const seen: unknown[] = []
    modChannel<WeatherMsg>('weather').onAny((m) => seen.push(m))

    bridge.emit.modMessage('summary-chat', 'status', { state: 'thinking' })

    expect(seen).toEqual([])
  })

  it('stops after unsubscribing', () => {
    const seen: unknown[] = []
    const stop = modChannel<WeatherMsg>('weather').on('reading', (p) => seen.push(p))
    stop()

    bridge.emit.modMessage('weather', 'reading', { tempC: 12 })

    expect(seen).toEqual([])
  })
})
