import { describe, it, expect } from 'vitest'
import { conversationLeft, micLook, type MicInputs } from './mic-button'

const QUIET: MicInputs = {
  error: false, own: 'idle', composer: 'idle', capturing: false, transcribing: false,
  hold: 'off', handsFree: 'off', conversation: false,
}

describe('what the microphone looks like', () => {
  it('is grey when closed, and says how closely hands-free listens', () => {
    expect(micLook(QUIET)).toBe('off')
    expect(micLook({ ...QUIET, hold: 'preparing' })).toBe('preparing')
    expect(micLook({ ...QUIET, hold: 'held', handsFree: 'listening' })).toBe('armed')
    expect(micLook({ ...QUIET, hold: 'held', handsFree: 'listening', conversation: true })).toBe('conversation')
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
    expect(micLook({ ...QUIET, own: 'starting' })).toBe('starting')
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
