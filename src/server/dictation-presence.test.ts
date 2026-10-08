import { describe, it, expect } from 'vitest'
import { DictationPresence, MAC_DICTATION_LIMIT_MS } from './dictation-presence'

function harness() {
  const changes: boolean[] = []
  const timers: Array<{ ms: number; fn: () => void; cancelled: boolean }> = []
  const presence = new DictationPresence((speaking) => changes.push(speaking), {
    schedule: (ms, fn) => {
      const timer = { ms, fn, cancelled: false }
      timers.push(timer)
      return () => { timer.cancelled = true }
    },
  })
  return { presence, changes, timers }
}

describe('DictationPresence', () => {
  it('reports a Mac dictation starting and ending', () => {
    const h = harness()
    h.presence.mac({ active: true, launch: 'a', seq: 1 })
    h.presence.mac({ active: false, launch: 'a', seq: 2 })
    expect(h.changes).toEqual([true, false])
  })

  it('stays held while either device is dictating', () => {
    const h = harness()
    h.presence.mac({ active: true, launch: 'a', seq: 1 })
    h.presence.phone(true)
    h.presence.phone(false)
    expect(h.presence.speaking).toBe(true)
    h.presence.mac({ active: false, launch: 'a', seq: 2 })
    expect(h.changes).toEqual([true, false])
  })

  it('drops a report older than one already taken, so an overtaken stop cannot strand a start', () => {
    const h = harness()
    h.presence.mac({ active: false, launch: 'a', seq: 2 })
    h.presence.mac({ active: true, launch: 'a', seq: 1 })
    expect(h.presence.speaking).toBe(false)
    expect(h.changes).toEqual([])
  })

  it('takes a relaunched Voice Operator\'s first report, which clears a dictation the old one never ended', () => {
    const h = harness()
    h.presence.mac({ active: true, launch: 'a', seq: 7 })
    h.presence.mac({ active: false, launch: 'b', seq: 0 })
    expect(h.changes).toEqual([true, false])
  })

  it('lets a Mac dictation go after the limit when its end never comes', () => {
    const h = harness()
    h.presence.mac({ active: true, launch: 'a', seq: 1 })
    expect(h.timers.map(timer => timer.ms)).toEqual([MAC_DICTATION_LIMIT_MS])
    h.timers[0].fn()
    expect(h.changes).toEqual([true, false])
  })

  it('calls off the limit once the dictation ends', () => {
    const h = harness()
    h.presence.mac({ active: true, launch: 'a', seq: 1 })
    h.presence.mac({ active: false, launch: 'a', seq: 2 })
    expect(h.timers[0].cancelled).toBe(true)
  })
})
