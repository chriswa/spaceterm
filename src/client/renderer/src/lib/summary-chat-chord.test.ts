import { describe, it, expect } from 'vitest'
import { pressSummaryChatChord, type SummaryChatChordDeps } from './summary-chat-chord'
import { summaryChatChordFor } from './keyboard'
import { asNodeId } from '../../../../shared/ids'
import type { NodeId } from '../../../../shared/ids'
import type { SummaryChatMode, SummaryChatToggleResult } from '../../../../shared/api'

const NODE = asNodeId('node-1234abcd')

function chord(result: SummaryChatToggleResult) {
  const events: string[] = []
  const pressed: Array<{ nodeId: NodeId | undefined; mode: SummaryChatMode }> = []
  const deps: SummaryChatChordDeps = {
    toggle: async (nodeId, mode) => { pressed.push({ nodeId, mode }); return result },
    started: () => events.push('started-cue'),
    cancelled: () => events.push('cancelled-cue'),
    rejected: (message) => events.push(`rejected:${message}`),
  }
  return { deps, events, pressed }
}

describe('pressSummaryChatChord', () => {
  it('confirms a summary it started', async () => {
    const c = chord({ outcome: 'started' })
    await pressSummaryChatChord(NODE, 'summary', c.deps)

    expect(c.pressed).toEqual([{ nodeId: NODE, mode: 'summary' }])
    expect(c.events).toEqual(['started-cue'])
  })

  it('plays the abort cue when the press stopped something instead', async () => {
    // The press that cancels is made *while* something is talking, so it needs
    // its own sound: a start chirp there tells the listener the opposite of
    // what happened.
    const c = chord({ outcome: 'cancelled' })
    await pressSummaryChatChord(NODE, 'summary', c.deps)

    expect(c.events).toEqual(['cancelled-cue'])
  })

  it('presses with no surface at all, because that press can still cancel', async () => {
    const c = chord({ outcome: 'cancelled' })
    await pressSummaryChatChord(undefined, 'summary', c.deps)

    expect(c.pressed).toEqual([{ nodeId: undefined, mode: 'summary' }])
    expect(c.events).toEqual(['cancelled-cue'])
  })

  it('reports the server\'s reason for a rejected press', async () => {
    const c = chord({ outcome: 'rejected', message: 'This surface has no transcript to summarize yet.' })
    await pressSummaryChatChord(NODE, 'summary', c.deps)

    expect(c.events).toEqual(['rejected:This surface has no transcript to summarize yet.'])
  })

  it('still explains itself when the server sent no reason', async () => {
    const c = chord({ outcome: 'rejected' })
    await pressSummaryChatChord(undefined, 'summary', c.deps)

    expect(c.events).toEqual(['rejected:Focus an agent terminal to start Summary Chat.'])
  })

  it('carries the mode the listener pressed through to the server', async () => {
    const c = chord({ outcome: 'started' })
    await pressSummaryChatChord(NODE, 'verbatim', c.deps)

    expect(c.pressed).toEqual([{ nodeId: NODE, mode: 'verbatim' }])
  })

  // The mode only decides what a press that *starts* something produces. A
  // press that lands on something audible is a request for silence whichever
  // chord made it, so it must still get the abort chirp rather than the
  // confirming one.
  it('plays the abort cue for a verbatim press that stopped something', async () => {
    const c = chord({ outcome: 'cancelled' })
    await pressSummaryChatChord(NODE, 'verbatim', c.deps)

    expect(c.events).toEqual(['cancelled-cue'])
  })
})

describe('summaryChatChordFor', () => {
  const event = (over: Partial<KeyboardEvent> = {}) =>
    ({ key: 'x', metaKey: true, ctrlKey: true, shiftKey: false, repeat: false, ...over }) as KeyboardEvent

  it('reads Cmd+Ctrl+X as a summary', () => {
    expect(summaryChatChordFor(event())).toBe('summary')
  })

  // macOS reports the *shifted* key, so this is what the event actually looks
  // like when the chord is pressed — a check against `'x'` alone would miss the
  // verbatim chord entirely and it would silently do nothing.
  it('reads Cmd+Ctrl+Shift+X as a verbatim read, uppercase key and all', () => {
    expect(summaryChatChordFor(event({ key: 'X', shiftKey: true }))).toBe('verbatim')
  })

  // Caps Lock produces an uppercase key with no Shift held. The listener
  // pressed the summary chord and must get the summary chord.
  it('decides the mode from Shift, not from the case of the key', () => {
    expect(summaryChatChordFor(event({ key: 'X' }))).toBe('summary')
  })

  it('leaves bare Cmd+X alone, because that is Cut', () => {
    expect(summaryChatChordFor(event({ ctrlKey: false }))).toBeNull()
  })

  it('ignores autorepeat, which would otherwise toggle for as long as the key is held', () => {
    expect(summaryChatChordFor(event({ repeat: true }))).toBeNull()
  })

  it('ignores autorepeat on the verbatim chord too', () => {
    expect(summaryChatChordFor(event({ key: 'X', shiftKey: true, repeat: true }))).toBeNull()
  })

  it('needs the Command key', () => {
    expect(summaryChatChordFor(event({ metaKey: false }))).toBeNull()
  })

  it('is no longer the old Cmd+P chord', () => {
    expect(summaryChatChordFor(event({ key: 'p' }))).toBeNull()
  })

  it('is not any other letter', () => {
    expect(summaryChatChordFor(event({ key: 'o' }))).toBeNull()
  })
})
