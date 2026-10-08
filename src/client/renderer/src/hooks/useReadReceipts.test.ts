import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { READ_DWELL_MS, ReadDwell } from './useReadReceipts'

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('ReadDwell', () => {
  it('counts a part read once it has stayed in view, and only once', () => {
    const read: string[] = []
    const dwell = new ReadDwell((key) => read.push(key))
    dwell.seen('0:1', true)
    vi.advanceTimersByTime(READ_DWELL_MS - 1)
    expect(read).toEqual([])
    vi.advanceTimersByTime(1)
    expect(read).toEqual(['0:1'])
    dwell.seen('0:1', false)
    dwell.seen('0:1', true)
    vi.advanceTimersByTime(READ_DWELL_MS)
    expect(read).toEqual(['0:1'])
  })

  it('starts again when a part leaves view before the time is up, or the page is hidden', () => {
    const read: string[] = []
    const dwell = new ReadDwell((key) => read.push(key))
    dwell.seen('0:0', true)
    vi.advanceTimersByTime(READ_DWELL_MS / 2)
    dwell.seen('0:0', false)
    vi.advanceTimersByTime(READ_DWELL_MS)
    dwell.seen('0:0', true)
    vi.advanceTimersByTime(READ_DWELL_MS / 2)
    dwell.clear()
    vi.advanceTimersByTime(READ_DWELL_MS)
    expect(read).toEqual([])
  })
})
