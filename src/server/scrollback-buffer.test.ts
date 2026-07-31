import { describe, expect, it } from 'vitest'
import { ScrollbackBuffer } from './scrollback-buffer'

/**
 * ScrollbackBuffer accumulates raw PTY bytes and evicts the oldest half once it
 * passes 1MB. These mirror the module's constants; they are not exported, so a
 * change there should fail these tests loudly rather than silently weaken them.
 */
const MAX_SIZE = 1024 * 1024
const TRIM_TARGET = 512 * 1024

/** Filler with no newlines and no escape sequences, so it cannot affect trims. */
function filler(n: number): string {
  return 'x'.repeat(n)
}

describe('ScrollbackBuffer', () => {
  it('returns what was written', () => {
    const b = new ScrollbackBuffer()
    b.write('hello ')
    b.write('world')
    expect(b.getContents()).toBe('hello world')
  })

  it('starts empty', () => {
    expect(new ScrollbackBuffer().getContents()).toBe('')
  })

  it('clears', () => {
    const b = new ScrollbackBuffer()
    b.write('data')
    b.clear()
    expect(b.getContents()).toBe('')
  })

  it('does not trim below the threshold', () => {
    const b = new ScrollbackBuffer()
    const data = filler(MAX_SIZE - 10)
    b.write(data)
    expect(b.getContents()).toBe(data)
  })

  it('trims to the target once the threshold is passed', () => {
    const b = new ScrollbackBuffer()
    b.write(filler(MAX_SIZE + 100))
    // No newline to align to, so the cut lands exactly at the target.
    expect(b.getContents().length).toBe(TRIM_TARGET)
  })

  it('keeps the most recent bytes when trimming', () => {
    const b = new ScrollbackBuffer()
    b.write(filler(MAX_SIZE))
    b.write('THE-TAIL')
    expect(b.getContents().endsWith('THE-TAIL')).toBe(true)
  })

  it('aligns the cut to a newline when one is within the scan limit', () => {
    const b = new ScrollbackBuffer()
    // Place a newline just after where the raw cut would land, so the buffer
    // should start on the following line rather than mid-line.
    b.write(filler(MAX_SIZE + 100 - TRIM_TARGET) + '\n' + filler(TRIM_TARGET - 1))
    const contents = b.getContents()
    expect(contents.startsWith('\n')).toBe(false)
    expect(contents.includes('\n')).toBe(false)
  })

  it('cuts at the raw offset when no newline is within the scan limit', () => {
    const b = new ScrollbackBuffer()
    // Total must exceed MAX_SIZE for a trim to happen at all. The cut lands at
    // length - TRIM_TARGET (524_388 here) and scans 10_000 bytes forward for a
    // newline; the only one is at 600_000, well past that window, so the cut
    // stays at the raw offset.
    const total = MAX_SIZE + 100
    b.write(filler(600_000) + '\n' + filler(total - 600_000 - 1))
    expect(b.getContents().length).toBe(TRIM_TARGET)
  })

  // ─── ANSI preservation (see ANSI_PRESERVATION_BUG.md) ────────────────────────

  it('re-establishes SGR state that was evicted by a trim', () => {
    const b = new ScrollbackBuffer()
    b.write('\x1b[31m')
    b.write(filler(MAX_SIZE + 100))
    // Without this, the client replays the tail with a default pen and every
    // subsequent frame is mis-coloured.
    expect(b.getContents().startsWith('\x1b[0;31m')).toBe(true)
  })

  it('re-establishes the alternate screen buffer that was evicted by a trim', () => {
    const b = new ScrollbackBuffer()
    b.write('\x1b[?1049h')
    b.write(filler(MAX_SIZE + 100))
    // Losing this leaves the client on the main buffer while the application
    // draws to the alternate one — every cursor position after it is wrong.
    expect(b.getContents().startsWith('\x1b[?1049h')).toBe(true)
  })

  it('re-establishes the scroll region that was evicted by a trim', () => {
    const b = new ScrollbackBuffer()
    b.write('\x1b[2;24r')
    b.write(filler(MAX_SIZE + 100))
    expect(b.getContents().startsWith('\x1b[2;24r')).toBe(true)
  })

  it('re-establishes the line-drawing charset that was evicted by a trim', () => {
    const b = new ScrollbackBuffer()
    b.write('\x1b(0')
    b.write(filler(MAX_SIZE + 100))
    expect(b.getContents().startsWith('\x1b(0')).toBe(true)
  })

  it('adds no prefix when nothing has been evicted', () => {
    const b = new ScrollbackBuffer()
    b.write('\x1b[31mstyled but small')
    expect(b.getContents()).toBe('\x1b[31mstyled but small')
  })

  it('does not carry state that was already turned off before the cut', () => {
    const b = new ScrollbackBuffer()
    b.write('\x1b[31m\x1b[0m')
    b.write(filler(MAX_SIZE + 100))
    expect(b.getContents().startsWith('\x1b')).toBe(false)
  })

  it('carries state forward across two separate trims', () => {
    const b = new ScrollbackBuffer()
    b.write('\x1b[?1049h')
    b.write(filler(MAX_SIZE + 100))
    // Second trim: the first trim's evicted state must survive it, even though
    // the sequence itself is long gone from the chunk list.
    b.write(filler(MAX_SIZE + 100))
    expect(b.getContents().startsWith('\x1b[?1049h')).toBe(true)
  })

  it('lets state set after a trim override state carried from before it', () => {
    const b = new ScrollbackBuffer()
    b.write('\x1b[31m')
    b.write(filler(MAX_SIZE + 100))
    b.write('\x1b[32m')
    b.write(filler(MAX_SIZE + 100))
    const contents = b.getContents()
    expect(contents.startsWith('\x1b[0;32m')).toBe(true)
  })

  it('drops carried state on clear', () => {
    const b = new ScrollbackBuffer()
    b.write('\x1b[31m')
    b.write(filler(MAX_SIZE + 100))
    b.clear()
    expect(b.getContents()).toBe('')
  })
})
