import { describe, it, expect } from 'vitest'
import {
  LOCK_PX, LOCK_SHOW_PX, conversationLeft, endPress, holdPress, lockTarget, micLook, movePress, startPress,
  type MicInputs, type Press,
} from './mic-button'

/** A finger's track, from where it went down: each step a move, or `hold` for the long-press timer firing. */
function track(...steps: Array<[number, number] | 'hold'>): Press {
  let press = startPress(100, 500)
  for (const step of steps) press = step === 'hold' ? holdPress(press) : movePress(press, 100 + step[0], 500 + step[1])
  return press
}

describe('a press on the microphone', () => {
  it('is a tap when it barely moves and lets go before the long-press time', () => {
    expect(endPress(track([3, -4], [-2, 5]))).toBe('tap')
  })

  it('is a long press when held still, and moving afterwards does not make it a drag', () => {
    const held = track([2, -2], 'hold', [0, -LOCK_PX - 20])
    expect(endPress(held)).toBe('long')
    expect(lockTarget(held)).toBeNull()
  })

  it('locks the moment it rises past the threshold, before the finger lifts, and stays locked', () => {
    const reaching = track([0, -LOCK_PX + 1])
    expect(reaching.done).toBeNull()
    const locked = movePress(reaching, 100, 500 - LOCK_PX)
    expect(locked.done).toBe('lock')
    // Coming back down, or the long-press timer, changes nothing.
    expect(endPress(holdPress(movePress(locked, 100, 500)))).toBe('lock')
  })

  it('counts a sideways wander on the way up', () => {
    expect(endPress(track([20, -30], [30, -LOCK_PX]))).toBe('lock')
  })

  it('is nothing when dragged away without reaching the lock, nor once the timer fires', () => {
    expect(endPress(track([40, 0]))).toBe('none')
    expect(endPress(track([0, -30], [0, 0]))).toBe('none')
    expect(endPress(track([0, 30], 'hold'))).toBe('none')
  })

  it('shows the lock only once rising, filling as it nears, lit when reached', () => {
    expect(lockTarget(null)).toBeNull()
    expect(lockTarget(track([0, -(LOCK_SHOW_PX - 1)]))).toBeNull()
    const near = lockTarget(track([0, -(LOCK_SHOW_PX + LOCK_PX) / 2]))!
    expect(near.reached).toBe(false)
    expect(near.progress).toBeGreaterThan(0)
    expect(near.progress).toBeLessThan(1)
    expect(lockTarget(track([0, -LOCK_PX]))).toEqual({ progress: 1, reached: true })
  })
})

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
