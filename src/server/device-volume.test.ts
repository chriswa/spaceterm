import { describe, expect, it } from 'vitest'
import { deviceVolume, parseVolumeSettings, PhoneVolumeRequests, type MacVolumeProbes, type VolumeTarget } from './device-volume'
import type { VolumeReading } from '../shared/device-volume'

/** A Mac whose volume settings are `state`, changed by the scripts that set them. */
function fakeMac(state: { volume: number | 'missing value'; muted: boolean }): MacVolumeProbes & { scripts: string[] } {
  const scripts: string[] = []
  return {
    scripts,
    osascript: async (script) => {
      scripts.push(script)
      const set = /^set volume output volume (\d+) without output muted$/.exec(script)
      if (set) {
        state.volume = Number(set[1])
        state.muted = false
        return ''
      }
      if (script === 'get volume settings') return `output volume:${state.volume}, input volume:50, alert volume:100, output muted:${state.muted}\n`
      throw new Error(`unexpected script: ${script}`)
    },
  }
}

const MAC: VolumeTarget = { kind: 'mac' }

describe('parseVolumeSettings', () => {
  it('reads the output volume and whether it is muted', () => {
    expect(parseVolumeSettings('output volume:25, input volume:50, alert volume:100, output muted:true')).toEqual({ percent: 25, muted: true })
    expect(parseVolumeSettings('output volume:70, input volume:50, alert volume:100, output muted:false\n')).toEqual({ percent: 70, muted: false })
  })

  it('explains an output with no volume of its own', () => {
    expect(() => parseVolumeSettings('output volume:missing value, input volume:50, alert volume:100, output muted:missing value'))
      .toThrow('has no volume of its own')
  })

  it('rejects anything else', () => {
    expect(() => parseVolumeSettings('execution error')).toThrow('could not be read')
  })
})

describe('deviceVolume on the Mac', () => {
  it('reads the Mac\'s system volume, saying when it is muted', async () => {
    expect(await deviceVolume(MAC, undefined, fakeMac({ volume: 25, muted: true }))).toBe('device_volume: the Mac\'s system volume is 25%, muted.')
    expect(await deviceVolume(MAC, undefined, fakeMac({ volume: 40, muted: false }))).toBe('device_volume: the Mac\'s system volume is 40%.')
  })

  it('sets it, unmuting it, and reports the volume read back', async () => {
    const mac = fakeMac({ volume: 25, muted: true })
    expect(await deviceVolume(MAC, 60, mac)).toBe('device_volume set the Mac\'s system volume to 60%, and it is no longer muted.')
    expect(mac.scripts).toContain('set volume output volume 60 without output muted')
    expect(await deviceVolume(MAC, 30, mac)).toBe('device_volume set the Mac\'s system volume to 30%.')
  })

  it('says why it could not, never rejecting', async () => {
    expect(await deviceVolume(MAC, undefined, fakeMac({ volume: 'missing value', muted: false })))
      .toMatch(/^device_volume could not read the Mac's system volume: .*has no volume of its own/)
    const broken: MacVolumeProbes = { osascript: async () => { throw new Error('could not run osascript: ENOENT') } }
    expect(await deviceVolume(MAC, 50, broken)).toBe('device_volume could not set the Mac\'s system volume: could not run osascript: ENOENT.')
  })
})

describe('deviceVolume on a phone', () => {
  it('asks the phone, and never the Mac', async () => {
    const asked: Array<number | undefined> = []
    const phone: VolumeTarget = { kind: 'phone', label: 'Phone', ask: async (set) => { asked.push(set); return { percent: set ?? 55 } } }
    const mac = fakeMac({ volume: 10, muted: false })
    expect(await deviceVolume(phone, undefined, mac)).toBe('device_volume: the phone\'s system volume (Phone) is 55%.')
    expect(await deviceVolume(phone, 35, mac)).toBe('device_volume set the phone\'s system volume (Phone) to 35%.')
    expect(asked).toEqual([undefined, 35])
    expect(mac.scripts).toEqual([])
  })

  it('passes on the phone\'s reason for failing', async () => {
    const phone: VolumeTarget = { kind: 'phone', label: 'Phone', ask: async () => { throw new Error('iOS did not change the volume; it is still at 50 percent') } }
    expect(await deviceVolume(phone, 80)).toBe('device_volume could not set the phone\'s system volume (Phone): iOS did not change the volume; it is still at 50 percent.')
  })

  it('says why there is no device to ask', async () => {
    expect(await deviceVolume({ kind: 'unavailable', reason: 'no device holds Control' }, undefined)).toBe('device_volume could not reach a device: no device holds Control.')
  })
})

describe('PhoneVolumeRequests', () => {
  function requests() {
    const sent: Array<{ clientId: string; requestId: string; set: number | undefined }> = []
    const timers: Array<() => void> = []
    const broker = new PhoneVolumeRequests({
      send: (clientId, requestId, set) => sent.push({ clientId, requestId, set }),
      schedule: (_ms, fn) => { timers.push(fn); return () => { timers.splice(timers.indexOf(fn), 1) } },
    })
    return { broker, sent, timers }
  }

  it('resolves with the asked client\'s answer, ignoring any other client', async () => {
    const { broker, sent } = requests()
    const reading = broker.ask('phone', 40)
    expect(sent).toEqual([{ clientId: 'phone', requestId: expect.any(String), set: 40 }])
    broker.answer('mac', sent[0].requestId, { percent: 1 })
    broker.answer('phone', sent[0].requestId, { percent: 40 })
    await expect(reading).resolves.toEqual({ percent: 40 } satisfies VolumeReading)
  })

  it('rejects with the phone\'s error, at the deadline, or when it disconnects', async () => {
    const { broker, sent, timers } = requests()
    const failed = broker.ask('phone', undefined)
    broker.answer('phone', sent[0].requestId, new Error('no app'))
    await expect(failed).rejects.toThrow('no app')

    const late = broker.ask('phone', undefined)
    timers[0]()
    await expect(late).rejects.toThrow('did not answer in time')

    const gone = broker.ask('phone', 10)
    broker.disconnected('phone')
    await expect(gone).rejects.toThrow('disconnected before answering')
    expect(timers).toEqual([])
  })
})
