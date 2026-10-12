import { describe, it, expect } from 'vitest'
import { PageWork, meteredTransport, installPageWorkReport } from './page-work'
import { createGate } from './gate'
import type { ServerTransport, TransportHandlers } from '../shared/server-client'

const line = (msg: object) => JSON.stringify(msg) + '\n'

describe('PageWork', () => {
  it('counts each line of a chunk by its type, heaviest first', () => {
    const work = new PageWork()
    work.received(line({ type: 'snapshot', lines: 'x'.repeat(2000) }) + line({ type: 'node-updated' }))
    work.received(line({ type: 'snapshot', lines: 'y'.repeat(2000) }))
    const report = work.take()
    expect(report.messages).toBe(3)
    expect(Object.keys(report.byType)).toEqual(['snapshot', 'node-updated'])
    expect(report.byType.snapshot[0]).toBe(2)
    expect(report.kb).toBeGreaterThan(3.9)
  })

  it('starts afresh after each report', () => {
    const work = new PageWork()
    work.received(line({ type: 'a' }))
    work.handled(5)
    work.take()
    expect(work.take()).toEqual({ messages: 0, kb: 0, handlingMs: 0, byType: {} })
  })

  it('files a line that does not start with its type as other', () => {
    const work = new PageWork()
    work.received('{"seq":1,"type":"x"}\n')
    expect(Object.keys(work.take().byType)).toEqual(['(other)'])
  })
})

describe('meteredTransport', () => {
  it('passes data through and times its handling', () => {
    let handlers: TransportHandlers | null = null
    const inner: ServerTransport = { open: (h) => { handlers = h }, send: () => undefined, close: () => undefined }
    const work = new PageWork()
    let clock = 0
    const seen: string[] = []
    meteredTransport(inner, work, () => clock).open({
      onOpen: () => undefined,
      onClose: () => undefined,
      onData: (chunk) => { seen.push(chunk); clock += 7 },
    })
    handlers!.onData(line({ type: 'snapshot' }))
    expect(seen).toHaveLength(1)
    expect(work.take()).toMatchObject({ messages: 1, handlingMs: 7 })
  })
})

describe('installPageWorkReport', () => {
  it('reports the minute, with how much of it was in Control mode', () => {
    let clock = 0
    let tick = () => {}
    const mode = createGate(false)
    const events: Array<Record<string, unknown>> = []
    installPageWorkReport({
      work: new PageWork(),
      controlMode: mode,
      record: (_kind, detail) => events.push(detail),
      now: () => clock,
      every: (fn) => { tick = fn },
    })
    clock = 20_000
    mode.set(true)
    clock = 50_000
    mode.set(false)
    clock = 60_000
    tick()
    clock = 120_500
    tick()
    expect(events[0]).toMatchObject({ windowS: 60, controlModeS: 30, lateMs: 0 })
    expect(events[1]).toMatchObject({ windowS: 61, controlModeS: 0, lateMs: 500 })
  })
})
