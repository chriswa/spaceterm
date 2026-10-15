import { describe, it, expect } from 'vitest'
import { conversationLeft, micLook, turnFill, type MicInputs } from './mic-button'

const QUIET: MicInputs = {
  error: false, own: 'idle', composer: 'idle', capturing: false, transcribing: false,
  hold: 'off', handsFree: 'off', conversation: false, checking: false,
}

describe('what the microphone looks like', () => {
  it('is grey when closed, and says how closely hands-free listens', () => {
    expect(micLook(QUIET)).toBe('off')
    expect(micLook({ ...QUIET, hold: 'preparing' })).toBe('preparing')
    expect(micLook({ ...QUIET, hold: 'held', handsFree: 'listening' })).toBe('armed')
    expect(micLook({ ...QUIET, hold: 'held', handsFree: 'listening', conversation: true })).toBe('conversation')
    // Speech heard, its check under way: neither the armed look nor yet orange.
    expect(micLook({ ...QUIET, hold: 'held', handsFree: 'listening', checking: true })).toBe('checking')
  })

  it('is not orange until sound arrives: a tap first shows the microphone connecting, then retrying', () => {
    expect(micLook({ ...QUIET, own: 'starting' })).toBe('connecting')
    expect(micLook({ ...QUIET, composer: 'starting' })).toBe('connecting')
    expect(micLook({ ...QUIET, own: 'retrying' })).toBe('retrying')
    expect(micLook({ ...QUIET, own: 'starting', hold: 'held', handsFree: 'listening' })).toBe('connecting')
  })

  it('is orange whenever a voice is leaving the phone, whatever started it', () => {
    const sources: Partial<MicInputs>[] = [
      { own: 'listening' },
      { composer: 'listening' },
      { capturing: true },
      { hold: 'held', handsFree: 'hearing', conversation: true },
    ]
    for (const source of sources) expect(micLook({ ...QUIET, ...source })).toBe('hearing')
  })

  it('waits for the words in the same orange, however they were spoken', () => {
    for (const source of [{ own: 'sending' }, { composer: 'transcribing' }, { transcribing: true }, { hold: 'held', handsFree: 'sending' }] as Partial<MicInputs>[]) {
      expect(micLook({ ...QUIET, ...source })).toBe('transcribing')
    }
  })

  it('lets hearing outrank waiting, and an error outrank everything', () => {
    expect(micLook({ ...QUIET, capturing: true, transcribing: true })).toBe('hearing')
    expect(micLook({ ...QUIET, error: true, capturing: true })).toBe('error')
  })
})

describe('the conversation window’s ring', () => {
  it('drains from full to empty over the window, whatever length it was tuned to', () => {
    expect(conversationLeft(15, 15)).toBe(1)
    expect(conversationLeft(5, 10)).toBe(0.5)
    expect(conversationLeft(0, 15)).toBe(0)
    expect(conversationLeft(null, 15)).toBe(0)
  })
})

describe('the turn ring', () => {
  it('rises with the answer, the threshold at the top', () => {
    expect(turnFill(0, 0.6)).toBe(0)
    expect(turnFill(0.15, 0.6)).toBeCloseTo(0.25)
    expect(turnFill(0.3, 0.6)).toBeLessThan(turnFill(0.45, 0.6))
  })

  it('is whole at the threshold, just short of it, or past it', () => {
    expect(turnFill(0.6, 0.6)).toBe(1)
    expect(turnFill(0.58, 0.6)).toBe(1)
    expect(turnFill(0.9, 0.6)).toBe(1)
  })
})
