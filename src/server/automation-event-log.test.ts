import { describe, it, expect } from 'vitest'
import { AutomationEventLog, MAX_EVENT_LOG_BYTES, MAX_EVENT_LOG_ENTRIES, type AutomationEventLogDeps } from './automation-event-log'
import { MAX_EVENT_PAYLOAD_BYTES } from '../shared/automation'

function memoryFile(initial = ''): AutomationEventLogDeps & { text: string; replaced: number } {
  return {
    text: initial,
    replaced: 0,
    read() { return this.text },
    append(text) { this.text += text },
    replace(text) { this.text = text; this.replaced++ }
  }
}

const heard = { kind: 'fired', matched: 1 } as const

describe('AutomationEventLog', () => {
  it('keeps what was sent with its time and outcome, oldest first', () => {
    const log = new AutomationEventLog(memoryFile())
    log.record({ eventId: 'custom_a', payload: { n: 1 }, outcome: heard }, 100)
    log.record({ eventId: 'custom_b', payload: undefined, source: 'my-mod', outcome: { kind: 'unheard', disabled: 0 } }, 200)
    expect(log.list()).toEqual([
      { seq: 1, at: 100, eventId: 'custom_a', payload: { n: 1 }, outcome: heard },
      { seq: 2, at: 200, eventId: 'custom_b', source: 'my-mod', outcome: { kind: 'unheard', disabled: 0 } }
    ])
  })

  it('comes back after a restart, numbering on from where it left off', () => {
    const file = memoryFile()
    new AutomationEventLog(file).record({ eventId: 'custom_a', payload: 1, outcome: heard }, 100)
    const reopened = new AutomationEventLog(file)
    expect(reopened.list().map((e) => e.eventId)).toEqual(['custom_a'])
    expect(reopened.record({ eventId: 'custom_b', payload: 2, outcome: heard }, 200).seq).toBe(2)
  })

  it('skips a line it cannot read, such as one a crash cut short', () => {
    const file = memoryFile('{"seq":1,"at":1,"eventId":"custom_a","outcome":{"kind":"fired","matched":1}}\n{"seq":2,"at"')
    expect(new AutomationEventLog(file).list().map((e) => e.seq)).toEqual([1])
  })

  it('can hold an id that is not a string, or absurdly long', () => {
    const log = new AutomationEventLog(memoryFile())
    const rejected = { kind: 'rejected', error: 'no' } as const
    expect(log.record({ eventId: 42, payload: undefined, outcome: rejected }, 1).eventId).toBe('42')
    expect(log.record({ eventId: undefined, payload: undefined, outcome: rejected }, 1).eventId).toBe('undefined')
    expect(log.record({ eventId: 'x'.repeat(10_000), payload: undefined, outcome: rejected }, 1).eventId.length).toBeLessThan(300)
  })

  it('keeps only the start of a payload too large to fire', () => {
    const log = new AutomationEventLog(memoryFile())
    const record = log.record({ eventId: 'custom_a', payload: 'x'.repeat(MAX_EVENT_PAYLOAD_BYTES * 2), outcome: { kind: 'rejected', error: 'big' } }, 1)
    expect(record.payload).toBeUndefined()
    expect(record.oversizedPayload?.bytes).toBeGreaterThan(MAX_EVENT_PAYLOAD_BYTES)
    expect(record.oversizedPayload?.preview.length).toBeLessThan(MAX_EVENT_PAYLOAD_BYTES)
  })

  it('forgets the oldest past the entry limit, and the file does not grow without end', () => {
    const file = memoryFile()
    const log = new AutomationEventLog(file)
    const total = MAX_EVENT_LOG_ENTRIES * 2 + 10
    for (let i = 0; i < total; i++) log.record({ eventId: `custom_${i}`, payload: undefined, outcome: heard }, i)
    expect(log.list()).toHaveLength(MAX_EVENT_LOG_ENTRIES)
    expect(log.list().at(-1)?.eventId).toBe(`custom_${total - 1}`)
    expect(file.replaced).toBeGreaterThan(0)
    expect(file.text.trim().split('\n').length).toBeLessThanOrEqual(MAX_EVENT_LOG_ENTRIES * 2)

    expect(new AutomationEventLog(file).list().map((e) => e.seq)).toEqual(log.list().map((e) => e.seq))
  })

  it('forgets the oldest past the byte limit', () => {
    const log = new AutomationEventLog(memoryFile())
    const payload = 'x'.repeat(MAX_EVENT_PAYLOAD_BYTES - 10)
    for (let i = 0; i < 200; i++) log.record({ eventId: 'custom_a', payload, outcome: heard }, i)
    const held = log.list()
    expect(JSON.stringify(held).length).toBeLessThanOrEqual(MAX_EVENT_LOG_BYTES + 1000)
    expect(held.length).toBeLessThan(200)
    expect(held.at(-1)?.at).toBe(199)
  })
})
