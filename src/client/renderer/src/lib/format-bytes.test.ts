import { describe, it, expect } from 'vitest'
import { formatBytes } from './format-bytes'

const KB = 1024
const MB = 1024 * KB
const GB = 1024 * MB

describe('formatBytes', () => {
  it('picks the largest unit that leaves a value under 1024', () => {
    expect(formatBytes(4 * GB)).toEqual({ value: '4.00', unit: 'GB' })
    expect(formatBytes(512 * MB)).toEqual({ value: '512', unit: 'MB' })
    expect(formatBytes(7 * KB)).toEqual({ value: '7.00', unit: 'KB' })
  })

  it('always renders three significant figures', () => {
    expect(formatBytes(4.2837 * GB).value).toBe('4.28')
    expect(formatBytes(41.837 * GB).value).toBe('41.8')
    expect(formatBytes(418.37 * GB).value).toBe('418')
  })

  // The reason the format exists: small changes must not change the width.
  it('keeps its width across a run of nearby readings', () => {
    const widths = new Set<number>()
    for (let mb = 700; mb < 800; mb++) widths.add(formatBytes(mb * MB).value.length)
    expect(widths).toEqual(new Set([3]))
  })

  it('carries a value that rounds up to 1024 into the next unit', () => {
    expect(formatBytes(1023.7 * MB)).toEqual({ value: '1.00', unit: 'GB' })
  })

  it('shows raw bytes whole, without false precision', () => {
    expect(formatBytes(999)).toEqual({ value: '999', unit: 'B' })
  })

  it('treats zero and nonsense as zero bytes', () => {
    expect(formatBytes(0)).toEqual({ value: '0', unit: 'B' })
    expect(formatBytes(-5)).toEqual({ value: '0', unit: 'B' })
    expect(formatBytes(NaN)).toEqual({ value: '0', unit: 'B' })
  })
})
