import { describe, expect, it } from 'vitest'
import { TURN_TONE_ENDING_SECONDS, TURN_TONE_ON, TURN_TONE_SECONDS, turnTone, turnTonePitch } from './turn-tone'

describe('turnTonePitch', () => {
  it('rises with the probability, from A3 to A6, in whole semitones', () => {
    expect(turnTonePitch(0)).toBe(220)
    expect(turnTonePitch(1)).toBe(1760)
    expect(turnTonePitch(0.4)).toBeLessThan(turnTonePitch(0.6))
    expect(turnTonePitch(0.5)).toBe(turnTonePitch(0.505))
    expect(turnTonePitch(-1)).toBe(220)
    expect(turnTonePitch(2)).toBe(1760)
  })
})

describe('turnTone', () => {
  it('holds the answer that ended the dictation longer', () => {
    expect(turnTone(0.9, true).seconds).toBe(TURN_TONE_ENDING_SECONDS)
    expect(turnTone(0.9, false).seconds).toBe(TURN_TONE_SECONDS)
    expect(turnTone(0.3, false).frequency).toBe(turnTonePitch(0.3))
  })

  it('is off by default', () => {
    expect(TURN_TONE_ON).toBe(false)
  })
})
