import { describe, it, expect } from 'vitest'
import { micLevel, noteMicLevel } from './mic-level'

describe('the voice’s level', () => {
  it('rises at once with speech, and falls away once nothing new is heard', () => {
    noteMicLevel(new Float32Array(128), 0)
    expect(micLevel(0)).toBe(0)
    noteMicLevel(new Float32Array(128).fill(0.1), 1000)
    const speaking = micLevel(1000)
    expect(speaking).toBeGreaterThan(0.5)
    expect(micLevel(1100)).toBeLessThan(speaking)
    expect(micLevel(3000)).toBe(0)
  })
})
