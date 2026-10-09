import { describe, expect, it } from 'vitest'
import { openReplies, partViews, segments, words } from './control-consumption'
import type { ControlTranscriptEntry } from '../../../../shared/protocol'

const at = ''

describe('partViews', () => {
  it('leaves out a reply heard whole', () => {
    expect(partViews([{ offset: 0, timestamp: at, kind: 'reply', parts: [{ from: 'Control', text: 'Done.' }] }])).toEqual(new Map())
  })

  it('takes a cut-off reply as missed after the mark, and a muted one as waiting, less what has been taken in since', () => {
    const entries: ControlTranscriptEntry[] = [
      { offset: 0, timestamp: at, kind: 'reply', parts: [{ from: 'Control', text: 'Kevin is done.' }] },
      { offset: 10, timestamp: at, kind: 'heard', of: 0, parts: [6] },
      { offset: 20, timestamp: at, kind: 'reply', parts: [{ from: 'Control', text: 'Sally asks.' }], delivery: 'text' },
      { offset: 30, timestamp: at, kind: 'consumed', of: 20, part: 0, from: 0, to: 6, how: 'replayed' },
    ]
    expect(partViews(entries)).toEqual(new Map([
      [0, [{ missing: [[6, 14]], why: 'missed' }]],
      [20, [{ missing: [[6, 11]], why: 'waiting' }]],
    ]))
  })

  it('takes the rest of a reply muted midway as waiting, until a later mark says where the user stopped', () => {
    const entries: ControlTranscriptEntry[] = [
      { offset: 0, timestamp: at, kind: 'reply', parts: [{ from: 'Control', text: 'Kevin is done.' }] },
      { offset: 10, timestamp: at, kind: 'heard', of: 0, parts: [6], unread: true },
    ]
    expect(partViews(entries).get(0)).toEqual([{ missing: [[6, 14]], why: 'waiting' }])
    entries.push({ offset: 20, timestamp: at, kind: 'heard', of: 0, parts: [9] })
    expect(partViews(entries).get(0)).toEqual([{ missing: [[9, 14]], why: 'missed' }])
  })
})

describe('openReplies', () => {
  const reply = (offset: number): ControlTranscriptEntry => ({ offset, timestamp: at, kind: 'reply', parts: [{ from: 'Control', text: 'Hi.' }] })
  const user = (offset: number): ControlTranscriptEntry => ({ offset, timestamp: at, kind: 'user', text: 'hi' })

  it('is what Control said since the user last did', () => {
    expect([...openReplies([reply(0), user(10), reply(20), reply(30)], false)]).toEqual([20, 30])
  })

  it('is nothing while the user\'s last message is not loaded, since the turn may go back further', () => {
    expect([...openReplies([reply(20), reply(30)], false)]).toEqual([])
    expect([...openReplies([reply(20), reply(30)], true)]).toEqual([20, 30])
  })
})

describe('segments', () => {
  it('splits a part into what was taken in and what was not', () => {
    expect(segments('Kevin is done.', { missing: [[6, 9]], why: 'missed' })).toEqual([
      { text: 'Kevin ', from: 0, kind: 'taken' }, { text: 'is ', from: 6, kind: 'missed' }, { text: 'done.', from: 9, kind: 'taken' },
    ])
  })

  it('lights the word the voice is on, and dims what it has yet to say', () => {
    expect(segments('Kevin is done.', undefined, 6)).toEqual([
      { text: 'Kevin ', from: 0, kind: 'taken' }, { text: 'is', from: 6, kind: 'said' }, { text: ' done.', from: 8, kind: 'unsaid' },
    ])
    expect(segments('Kevin is done.', undefined, 14)).toEqual([{ text: 'Kevin is done.', from: 0, kind: 'taken' }])
  })
})

describe('words', () => {
  it('gives each word where it ends in the part', () => {
    expect(words({ text: 'is done.', from: 6, kind: 'missed' })).toEqual([{ text: 'is', end: 8 }, { text: ' ' }, { text: 'done.', end: 14 }])
  })
})
