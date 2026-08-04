import { describe, it, expect } from 'vitest'
import { pressSummaryChatChord, type SummaryChatChordDeps } from './summary-chat-chord'
import { isSummaryChatChord } from './keyboard'
import { asNodeId } from '../../../../shared/ids'
import type { NodeId } from '../../../../shared/ids'
import type { SummaryChatToggleResult } from '../../../../shared/api'

const NODE = asNodeId('node-1234abcd')

function chord(result: SummaryChatToggleResult) {
  const events: string[] = []
  const pressed: Array<NodeId | undefined> = []
  const deps: SummaryChatChordDeps = {
    toggle: async (nodeId) => { pressed.push(nodeId); return result },
    started: () => events.push('started-cue'),
    cancelled: () => events.push('cancelled-cue'),
    rejected: (message) => events.push(`rejected:${message}`),
  }
  return { deps, events, pressed }
}

describe('pressSummaryChatChord', () => {
  it('confirms a summary it started', async () => {
    const c = chord({ outcome: 'started' })
    await pressSummaryChatChord(NODE, c.deps)

    expect(c.pressed).toEqual([NODE])
    expect(c.events).toEqual(['started-cue'])
  })

  it('plays the abort cue when the press stopped something instead', async () => {
    // The press that cancels is made *while* something is talking, so it needs
    // its own sound: a start chirp there tells the listener the opposite of
    // what happened.
    const c = chord({ outcome: 'cancelled' })
    await pressSummaryChatChord(NODE, c.deps)

    expect(c.events).toEqual(['cancelled-cue'])
  })

  it('presses with no surface at all, because that press can still cancel', async () => {
    const c = chord({ outcome: 'cancelled' })
    await pressSummaryChatChord(undefined, c.deps)

    expect(c.pressed).toEqual([undefined])
    expect(c.events).toEqual(['cancelled-cue'])
  })

  it('reports the server\'s reason for a rejected press', async () => {
    const c = chord({ outcome: 'rejected', message: 'This surface has no transcript to summarize yet.' })
    await pressSummaryChatChord(NODE, c.deps)

    expect(c.events).toEqual(['rejected:This surface has no transcript to summarize yet.'])
  })

  it('still explains itself when the server sent no reason', async () => {
    const c = chord({ outcome: 'rejected' })
    await pressSummaryChatChord(undefined, c.deps)

    expect(c.events).toEqual(['rejected:Focus an agent terminal to start Summary Chat.'])
  })
})

describe('isSummaryChatChord', () => {
  const event = (over: Partial<KeyboardEvent> = {}) =>
    ({ key: 'p', metaKey: true, repeat: false, ...over }) as KeyboardEvent

  it('matches Cmd+P', () => {
    expect(isSummaryChatChord(event())).toBe(true)
  })

  it('matches Cmd+Ctrl+P, which is the same chord to anyone holding Control', () => {
    expect(isSummaryChatChord(event({ ctrlKey: true }))).toBe(true)
  })

  it('ignores autorepeat, which would otherwise toggle for as long as the key is held', () => {
    expect(isSummaryChatChord(event({ repeat: true }))).toBe(false)
  })

  it('needs the Command key', () => {
    expect(isSummaryChatChord(event({ metaKey: false }))).toBe(false)
  })

  it('is not any other letter', () => {
    expect(isSummaryChatChord(event({ key: 'o' }))).toBe(false)
  })
})
