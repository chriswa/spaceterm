import { describe, it, expect } from 'vitest'
import { bracketedPaste, DISMISS_QUESTION_DELAY_MS, shipIt, SHIP_IT_SUBMIT_DELAY_MS } from './ship-it'

/** Writes stay unflushed until `flush` is called, as a busy socket's would. */
function harness() {
  const written: string[] = []
  const unflushed: Array<() => void> = []
  const scheduled: Array<{ fn: () => void; ms: number }> = []
  return {
    written,
    scheduled,
    flush: () => unflushed.splice(0).forEach((flushed) => flushed()),
    deps: {
      write: (data: string) => {
        written.push(data)
        return new Promise<void>((flushed) => unflushed.push(flushed))
      },
      schedule: (fn: () => void, ms: number) => scheduled.push({ fn, ms })
    }
  }
}

/** Let `shipIt` get as far as it can without a timer firing or a write flushing. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve))

/** Whether `promise` has resolved by now. */
async function resolved(promise: Promise<void>): Promise<boolean> {
  let done = false
  void promise.then(() => { done = true })
  await settle()
  return done
}

describe('bracketedPaste', () => {
  it('wraps the text in paste markers', () => {
    expect(bracketedPaste('hello')).toBe('\x1b[200~hello\x1b[201~')
  })

  it('turns every newline into a carriage return, CRLF included', () => {
    // A bare \n inside the paste submits Claude Code's prompt early.
    expect(bracketedPaste('one\ntwo\r\nthree')).toBe('\x1b[200~one\rtwo\rthree\x1b[201~')
  })
})

describe('shipIt', () => {
  it('pastes, then submits after the delay rather than with the paste', async () => {
    const h = harness()
    void shipIt(h.deps, 'go', true)
    expect(h.written).toEqual(['\x1b[200~go\x1b[201~'])
    expect(h.scheduled.map((s) => s.ms)).toEqual([SHIP_IT_SUBMIT_DELAY_MS])

    h.scheduled[0].fn()
    await settle()
    expect(h.written).toEqual(['\x1b[200~go\x1b[201~', '\r'])
  })

  it('pastes without submitting when asked not to', () => {
    const h = harness()
    void shipIt(h.deps, 'draft', false)
    expect(h.written).toEqual(['\x1b[200~draft\x1b[201~'])
    expect(h.scheduled).toEqual([])
  })
})

describe('shipIt to an agent waiting on a question', () => {
  it('presses Escape first, then pastes and submits once the prompt is back', async () => {
    const h = harness()
    void shipIt(h.deps, 'hello', true, { dismissQuestion: true })
    expect(h.written).toEqual(['\x1b'])
    expect(h.scheduled.map((s) => s.ms)).toEqual([DISMISS_QUESTION_DELAY_MS])
    h.scheduled[0].fn()
    await settle()
    expect(h.written).toEqual(['\x1b', bracketedPaste('hello')])
    h.scheduled[1].fn()
    await settle()
    expect(h.written.at(-1)).toBe('\r')
  })
})

describe('shipIt settling', () => {
  // Shutdown waits on this; resolving before the return has left the process loses the submit.
  it('resolves only once the submitting return has been flushed', async () => {
    const h = harness()
    const shipping = shipIt(h.deps, 'go', true)
    h.flush()
    h.scheduled[0].fn()
    await settle()
    expect(h.written.at(-1)).toBe('\r')
    expect(await resolved(shipping)).toBe(false)
    h.flush()
    expect(await resolved(shipping)).toBe(true)
  })

  it('resolves after the dismissing Escape, the paste and the flushed return', async () => {
    const h = harness()
    const shipping = shipIt(h.deps, 'hello', true, { dismissQuestion: true })
    h.scheduled[0].fn()
    await settle()
    expect(await resolved(shipping)).toBe(false)
    h.scheduled[1].fn()
    await settle()
    expect(await resolved(shipping)).toBe(false)
    h.flush()
    expect(await resolved(shipping)).toBe(true)
  })

  it('resolves once the paste is flushed when not submitting', async () => {
    const h = harness()
    const shipping = shipIt(h.deps, 'draft', false)
    expect(await resolved(shipping)).toBe(false)
    h.flush()
    expect(await resolved(shipping)).toBe(true)
  })
})
