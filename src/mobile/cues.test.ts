import { describe, it, expect } from 'vitest'
import { cueSamples } from './cues'

describe('cueSamples', () => {
  it('lasts as long as Voice Operator’s cue: natural duration halved', () => {
    // listeningStarted is 0.09 + 0.11 s at natural speed → 0.1 s at 2×.
    expect(cueSamples('listeningStarted').length).toBe(Math.floor(0.045 * 44_100) + Math.floor(0.055 * 44_100))
  })

  it('fades in from silence and stays within full scale', () => {
    const s = cueSamples('pasted')
    expect(s[0]).toBe(0)
    expect(Math.max(...Array.from(s).map(Math.abs))).toBeLessThanOrEqual(1)
  })

  it('plays a rest as silence', () => {
    const s = cueSamples('captureFailed')
    const firstNote = Math.floor(0.1 * 44_100)
    const rest = s.slice(firstNote, firstNote + Math.floor(0.035 * 44_100))
    expect(rest.every((v) => v === 0)).toBe(true)
  })

  it('rises for start and falls for finish, like the desktop', () => {
    // Zero crossings per sample over each half approximate pitch.
    const crossings = (s: Float32Array) => s.slice(1).filter((v, i) => Math.sign(v) !== Math.sign(s[i]) && v !== 0).length
    const start = cueSamples('listeningStarted')
    const half = Math.floor(0.045 * 44_100)
    expect(crossings(start.slice(half)) / (start.length - half)).toBeGreaterThan(crossings(start.slice(0, half)) / half)
  })
})

describe('the approval chime', () => {
  it('is opProxy’s: 1.1 s, peaking at 0.8, from silence', () => {
    const s = cueSamples('approvalRequested')
    expect(s.length).toBe(Math.floor(1.1 * 44_100))
    expect(s[0]).toBe(0)
    expect(Math.max(...Array.from(s).map(Math.abs))).toBeCloseTo(0.8, 5)
  })

  it('rings out rather than stopping dead', () => {
    const s = cueSamples('approvalRequested')
    const rms = (a: Float32Array) => Math.sqrt(a.reduce((sum, v) => sum + v * v, 0) / a.length)
    const window = Math.floor(0.05 * 44_100)
    const early = rms(s.slice(Math.floor(0.15 * 44_100), Math.floor(0.15 * 44_100) + window))
    const late = rms(s.slice(Math.floor(0.8 * 44_100), Math.floor(0.8 * 44_100) + window))
    expect(late).toBeGreaterThan(0)
    expect(late).toBeLessThan(early / 2)
  })
})
