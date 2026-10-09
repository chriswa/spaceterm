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

  it("tells of an unread reply once, and of its reading once the user's next message locks it", () => {
    const ledger = new ConsumptionLedger()
    ledger.delivered(0, ['Kevin asks whether to push.'], 'text')
    expect(ledger.note()).toMatch(/^A reply of yours was written .* not read it yet: "Kevin asks whether to push\."/)
    expect(ledger.note()).toBeUndefined()
    ledger.consume(0, 0, 0, Infinity)
    // Still open: what the user took in of it is told with their next message.
    expect(ledger.note()).toBeUndefined()
    ledger.settle('spoken', 100)
    expect(ledger.note()).toMatch(/^Since then, the user has read, or heard replayed, .*: "Kevin asks whether to push\."/)
    expect(ledger.note()).toBeUndefined()
  })

  it('tells only what is new of a cut-off reply taken in later', () => {
    const ledger = new ConsumptionLedger()
    ledger.delivered(0, ['Kevin is done.', 'The solver works.'], 'spoken')
    ledger.heard(0, ['Kevin is done.'.length, 'The '.length])
    // The cut-off note already said this much.
    expect(ledger.note()).toBeUndefined()
    ledger.settle('spoken', 100)
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
      { offset: 120, timestamp: '', kind: 'user', text: 'and Sally?' },
    ])
    expect(ledger.unread()).toEqual({ count: 1, first: 50 })
    expect(ledger.note()).toBeUndefined()
    ledger.consume(50, 0, 0, Infinity)
    expect(ledger.note()).toContain('"Sally is too."')
  })

  it("marks everything said since the user's last message taken in up to a point, and nothing after", () => {
    const ledger = new ConsumptionLedger()
    ledger.delivered(0, ['Old news.'], 'spoken')
    ledger.settle('spoken', 10)
    ledger.delivered(20, ['Kevin is done.', 'The solver works.'], 'spoken')
    ledger.heard(20, ['Kevin is done.'.length, 0])
    ledger.delivered(40, ['Sally asks.'], 'text')
    // Before their last message: locked.
    expect(ledger.mark(0, 0, 3)).toBeUndefined()
    expect(ledger.mark(20, 1, 'The solver'.length)).toEqual([
      { at: 20, lengths: ['Kevin is done.'.length, 'The solver'.length] },
      { at: 40, lengths: [0] },
    ])
    // Marked, the muted reply no longer waits: it is missed.
    expect(ledger.unread()).toEqual({ count: 0 })
    // Moved again: only what changed.
    expect(ledger.mark(40, 0, 'Sally asks.'.length)).toEqual([
      { at: 20, lengths: ['Kevin is done.'.length, 'The solver works.'.length] },
      { at: 40, lengths: ['Sally asks.'.length] },
    ])
  })

  it('tells of words marked as not taken in only once the turn is locked', () => {
    const ledger = new ConsumptionLedger()
    ledger.delivered(0, ['Kevin is done.', 'The solver works.'], 'spoken')
    ledger.mark(0, 0, 'Kevin is done.'.length)
    expect(ledger.note()).toBeUndefined()
    ledger.settle('typed', 50)
    expect(ledger.note()).toBe(
      'They stopped taking in your words after "Kevin is done.", and cut in there: they did not take in "The solver works.". ' +
      'What they say next answers what came before that point: a question in what they missed is still unasked. ' +
      'If what they missed still matters, tell them, or add it to your backlog if it would pull them off the topic.',
    )
    expect(ledger.note()).toBeUndefined()
  })

  it("settles what waits by how the user's next message came: typed is read, spoken is missed", () => {
    const typed = new ConsumptionLedger()
    typed.delivered(0, ['Kevin is done.'], 'text')
    expect(typed.settle('typed', 50)).toEqual({ read: [{ at: 0, part: 0, from: 0, to: 'Kevin is done.'.length }], lost: [] })
    expect(typed.note()).toBeUndefined()

    const spoken = new ConsumptionLedger()
    spoken.delivered(0, ['Kevin is done.', 'The solver works.'], 'spoken')
    spoken.heard(0, ['Kevin '.length, 0], true)
    expect(spoken.unread()).toEqual({ count: 1, first: 0 })
    expect(spoken.settle('spoken', 50)).toEqual({ read: [], lost: [{ at: 0, lengths: ['Kevin '.length, 0] }] })
    expect(spoken.unread()).toEqual({ count: 0 })
    // Told of the cut when it happened: nothing more to say.
    expect(spoken.note()).toBeUndefined()
  })

  it('reads everything waiting, in every turn, when the user marks it all read', () => {
    const ledger = new ConsumptionLedger()
    ledger.delivered(0, ['Kevin is done.'], 'text')
    ledger.settle('spoken', 10)
    ledger.delivered(20, ['Sally asks.'], 'text')
    ledger.delivered(40, ['Bob is up.'], 'text')
    expect(ledger.readAll()).toEqual([
      { at: 20, part: 0, from: 0, to: 'Sally asks.'.length },
      { at: 40, part: 0, from: 0, to: 'Bob is up.'.length },
    ])
    expect(ledger.unread()).toEqual({ count: 0 })
  })
})
