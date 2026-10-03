import { describe, it, expect } from 'vitest'
import { AudioStats } from './dictation'

describe('AudioStats', () => {
  it('tells a microphone that sent nothing from one that sent silence', () => {
    expect(new AudioStats().describe(48000)).toBe('0 blocks, 0.0s, peak silent')
    const zeros = new AudioStats()
    zeros.push(new Float32Array(48000))
    expect(zeros.describe(48000)).toBe('1 blocks, 1.0s, peak silent')
  })

  it('reports the loudest sample in dBFS', () => {
    const stats = new AudioStats()
    stats.push(Float32Array.from([0.01, -0.5, 0.1]))
    expect(stats.peak).toBe(0.5)
    expect(stats.describe(48000)).toMatch(/peak -6 dBFS$/)
  })
})
