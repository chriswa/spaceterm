import { describe, it, expect } from 'vitest'
import { bracketedPaste, DISMISS_QUESTION_DELAY_MS, shipIt, SHIP_IT_SUBMIT_DELAY_MS } from './ship-it'

function harness() {
  const written: string[] = []
  const scheduled: Array<{ fn: () => void; ms: number }> = []
  return {
    written,
    scheduled,
    deps: {
      write: (data: string) => written.push(data),
      schedule: (fn: () => void, ms: number) => scheduled.push({ fn, ms })
    }
  }
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
  it('pastes, then submits after the delay rather than with the paste', () => {
    const h = harness()
    shipIt(h.deps, 'go', true)
    expect(h.written).toEqual(['\x1b[200~go\x1b[201~'])
    expect(h.scheduled.map((s) => s.ms)).toEqual([SHIP_IT_SUBMIT_DELAY_MS])

    h.scheduled[0].fn()
    expect(h.written).toEqual(['\x1b[200~go\x1b[201~', '\r'])
  })

  it('pastes without submitting when asked not to', () => {
    const h = harness()
    shipIt(h.deps, 'draft', false)
    expect(h.written).toEqual(['\x1b[200~draft\x1b[201~'])
    expect(h.scheduled).toEqual([])
  })
})

describe('shipIt to an agent waiting on a question', () => {
  it('presses Escape first, then pastes and submits once the prompt is back', () => {
    const h = harness()
    shipIt(h.deps, 'hello', true, { dismissQuestion: true })
    expect(h.written).toEqual(['\x1b'])
    expect(h.scheduled.map((s) => s.ms)).toEqual([DISMISS_QUESTION_DELAY_MS])
    h.scheduled[0].fn()
    expect(h.written).toEqual(['\x1b', bracketedPaste('hello')])
    h.scheduled[1].fn()
    expect(h.written.at(-1)).toBe('\r')
  })
})
