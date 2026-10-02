import { describe, it, expect } from 'vitest'
import { Downsampler, insertDictation, pcmToBase64 } from './pcm'

describe('Downsampler', () => {
  it('turns 48 kHz into a third as many 16 kHz samples, across block boundaries', () => {
    const d = new Downsampler(48_000)
    // 1000 samples split unevenly; the total out must not depend on the split.
    const a = d.push(new Float32Array(397).fill(0.5))
    const b = d.push(new Float32Array(603).fill(0.5))
    expect(a.length + b.length).toBe(333)
  })

  it('handles a rate that is not a whole multiple', () => {
    const d = new Downsampler(44_100)
    const out = d.push(new Float32Array(44_100))
    expect(Math.abs(out.length - 16_000)).toBeLessThanOrEqual(1)
  })

  it('maps full scale to the int16 limits and clips beyond it', () => {
    const d = new Downsampler(16_000)
    expect(Array.from(d.push(Float32Array.from([1, -1, 2, -2, 0])))).toEqual([32767, -32768, 32767, -32768, 0])
  })

  it('refuses to upsample', () => {
    expect(() => new Downsampler(8_000)).toThrow()
  })
})

describe('pcmToBase64', () => {
  it('encodes little-endian bytes', () => {
    // 0x0201 → bytes 01 02; 0x0403 → 03 04
    expect(pcmToBase64(Int16Array.from([0x0201, 0x0403]))).toBe(btoa('\x01\x02\x03\x04'))
  })
})

describe('insertDictation', () => {
  it('drops Wispr’s trailing space into an empty draft', () => {
    expect(insertDictation('', 0, 'Hello there. ')).toEqual({ text: 'Hello there.', cursor: 12 })
  })

  it('separates the transcript from the words either side of the cursor', () => {
    expect(insertDictation('fix thebug', 7, 'flaky ')).toEqual({ text: 'fix the flaky bug', cursor: 14 })
  })

  it('leaves the draft alone when nothing was heard', () => {
    expect(insertDictation('keep', 4, '  ')).toEqual({ text: 'keep', cursor: 4 })
  })
})
