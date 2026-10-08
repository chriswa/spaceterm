import { describe, expect, it } from 'vitest'
import { partViews, runs } from './control-consumption'
import type { ControlTranscriptEntry } from '../../../../shared/protocol'

const at = ''

describe('partViews', () => {
  it('leaves out a reply heard whole', () => {
    expect(partViews([{ offset: 0, timestamp: at, kind: 'reply', parts: [{ from: 'Control', text: 'Done.' }] }])).toEqual(new Map())
  })

  it('takes a cut-off reply as heard up to the mark, and a muted one as unread, less what has been read since', () => {
    const entries: ControlTranscriptEntry[] = [
      { offset: 0, timestamp: at, kind: 'reply', parts: [{ from: 'Control', text: 'Kevin is done.' }] },
      { offset: 10, timestamp: at, kind: 'heard', of: 0, parts: [6] },
      { offset: 20, timestamp: at, kind: 'reply', parts: [{ from: 'Control', text: 'Sally asks.' }], delivery: 'text' },
      { offset: 30, timestamp: at, kind: 'consumed', of: 20, part: 0, from: 0, to: 6, how: 'replayed' },
    ]
    expect(partViews(entries)).toEqual(new Map([
      [0, [{ missing: [[6, 14]], why: 'unheard' }]],
      [20, [{ missing: [[6, 11]], why: 'unread' }]],
    ]))
  })

  it('takes the rest of a reply muted midway as unread', () => {
    const entries: ControlTranscriptEntry[] = [
      { offset: 0, timestamp: at, kind: 'reply', parts: [{ from: 'Control', text: 'Kevin is done.' }] },
      { offset: 10, timestamp: at, kind: 'heard', of: 0, parts: [6], unread: true },
    ]
    expect(partViews(entries).get(0)).toEqual([{ missing: [[6, 14]], why: 'unread' }])
  })
})

describe('runs', () => {
  it('splits a part into what was taken in and what was missed', () => {
    expect(runs('Kevin is done.', [[6, 9]])).toEqual([
      { text: 'Kevin ', missing: false }, { text: 'is ', missing: true }, { text: 'done.', missing: false },
    ])
  })
})
