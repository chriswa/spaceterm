import { describe, expect, it } from 'vitest'
import { ConsumptionLedger } from './consumption'

describe('ConsumptionLedger', () => {
  it('takes a spoken reply as heard, and has nothing to tell', () => {
    const ledger = new ConsumptionLedger()
    ledger.delivered(0, ['Kevin is done.'], 'spoken')
    expect(ledger.note()).toBeUndefined()
    expect(ledger.unread()).toEqual({ count: 0 })
  })

  it('counts a written reply unread until all of it is read', () => {
    const ledger = new ConsumptionLedger()
    ledger.delivered(10, ['Kevin is done.', 'The tests pass.'], 'text')
    expect(ledger.unread()).toEqual({ count: 1, first: 10 })
    expect(ledger.consume(10, 0, 0, Infinity)).toEqual({ from: 0, to: 'Kevin is done.'.length })
    expect(ledger.unread().count).toBe(1)
    ledger.consume(10, 1, 0, Infinity)
    expect(ledger.unread()).toEqual({ count: 0 })
    // Read before Control was told it was not: it never needs to hear of it.
    expect(ledger.note()).toBeUndefined()
  })

  it('says nothing new of what was already taken in', () => {
    const ledger = new ConsumptionLedger()
    ledger.delivered(0, ['Kevin is done.'], 'spoken')
    expect(ledger.consume(0, 0, 0, 5)).toBeUndefined()
    expect(ledger.consume(7, 0, 0, 5)).toBeUndefined()
  })

  it('tells of an unread reply once, and of its reading later', () => {
    const ledger = new ConsumptionLedger()
    ledger.delivered(0, ['Kevin asks whether to push.'], 'text')
    expect(ledger.note()).toMatch(/^A reply of yours was written .* not read it yet: "Kevin asks whether to push\."/)
    expect(ledger.note()).toBeUndefined()
    ledger.consume(0, 0, 0, Infinity)
    expect(ledger.note()).toMatch(/^Since then, the user has read, or heard replayed, .*: "Kevin asks whether to push\."/)
    expect(ledger.note()).toBeUndefined()
  })

  it('tells only what is new of a cut-off reply taken in later', () => {
    const ledger = new ConsumptionLedger()
    ledger.delivered(0, ['Kevin is done.', 'The solver works.'], 'spoken')
    ledger.heard(0, ['Kevin is done.'.length, 'The '.length])
    // The cut-off note already said this much.
    expect(ledger.note()).toBeUndefined()
    ledger.consume(0, 1, 0, 'The solver'.length)
    expect(ledger.note()).toContain('"solver"')
    ledger.consume(0, 1, 0, Infinity)
    expect(ledger.note()).toContain('"works."')
  })

  it('counts the rest of a reply muted midway as unread, not lost', () => {
    const ledger = new ConsumptionLedger()
    ledger.delivered(0, ['Kevin is done.'], 'spoken')
    ledger.heard(0, ['Kevin '.length], true)
    expect(ledger.unread()).toEqual({ count: 1, first: 0 })
    expect(ledger.unreadParts()).toEqual([{ at: 0, part: 0, from: 'Kevin '.length, to: 'Kevin is done.'.length, text: 'is done.' }])
  })

  it('leaves out of its note what Control was told some other way', () => {
    const ledger = new ConsumptionLedger()
    ledger.delivered(0, ['Kevin is done.'], 'text')
    expect(ledger.note()).toBeDefined()
    ledger.consume(0, 0, 0, Infinity, true)
    expect(ledger.note()).toBeUndefined()
  })

  it('restores from the record, believing what was taken in', () => {
    const ledger = new ConsumptionLedger()
    ledger.restore([
      { offset: 0, timestamp: '', kind: 'reply', parts: [{ from: 'Control', text: 'Kevin is done.' }], delivery: 'text' },
      { offset: 50, timestamp: '', kind: 'reply', parts: [{ from: 'Control', text: 'Sally is too.' }], delivery: 'text' },
      { offset: 90, timestamp: '', kind: 'consumed', of: 0, part: 0, from: 0, to: 14, how: 'read' },
    ])
    expect(ledger.unread()).toEqual({ count: 1, first: 50 })
    expect(ledger.note()).toBeUndefined()
    ledger.consume(50, 0, 0, Infinity)
    expect(ledger.note()).toContain('"Sally is too."')
  })
})
