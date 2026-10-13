import { describe, it, expect } from 'vitest'
import { DownlinkWatch, QUIET_MS, messageType } from './downlink-watch'

function setup() {
  let now = 0
  let tick = () => undefined as void
  const records: Array<[string, Record<string, unknown>]> = []
  const watch = new DownlinkWatch({ record: (kind, detail) => records.push([kind, detail]), now: () => now, every: (fn) => { tick = fn } })
  return { watch, records, advance: (ms: number) => { now += ms; tick() } }
}

describe('DownlinkWatch', () => {
  it('records a quiet spell once, and the gap when the Mac is heard from again', () => {
    const { watch, records, advance } = setup()
    watch.opened()
    advance(QUIET_MS - 1)
    watch.received('{"type":"system-stats"}')
    advance(QUIET_MS)
    advance(5000)
    expect(records.filter(([k]) => k === 'downlink-quiet')).toHaveLength(1)
    watch.received('{"type":"speech-audio","pcm":"..."}')
    const gap = records.find(([k]) => k === 'downlink-gap')![1]
    expect(gap.gapMs).toBe(QUIET_MS + 5000)
    expect(gap.type).toBe('speech-audio')
  })

  it('says how long since the Mac was heard from when the page is shown', () => {
    const { watch, records, advance } = setup()
    watch.opened()
    advance(3000)
    watch.shown()
    expect(records.at(-1)).toEqual(['downlink-on-visible', { open: true, sinceDataMs: 3000, openMs: 3000 }])
  })
})

describe('messageType', () => {
  it('reads the type from the front of the line', () => {
    expect(messageType('{"type":"speech-audio","id":"x"}')).toBe('speech-audio')
    expect(messageType('garbage')).toBe('?')
  })
})
