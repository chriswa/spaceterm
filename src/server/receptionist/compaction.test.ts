import { describe, expect, it } from 'vitest'
import { compactionTrace, type Compaction } from './compaction'

const SENT = Date.parse('2026-10-18T14:37:58Z')
const MINUTE = 60_000

/** An idle compaction 55 minutes after the last message, which was 19 h 19 m before this one. */
const idle: Compaction = {
  trigger: 'idle',
  lastActivity: SENT - (19 * 60 + 19) * MINUTE,
  finishedBeforeMs: SENT - ((SENT - (19 * 60 + 19) * MINUTE) + 55 * MINUTE + 18_000),
  durationMs: 18_000,
  tokensBefore: 20_721,
  tokensAfter: 1_947,
  thresholdTokens: 40_000,
  costUsd: 0.0368,
  cachedTokens: 19_801,
  uncachedTokens: 2_762,
}

describe('compactionTrace', () => {
  it('says an idle compaction was one, how long the session sat idle, and how full it was against the window and the threshold', () => {
    const { text, detail } = compactionTrace(idle, 1_000_000, SENT, true)
    expect(text).toBe('Memory compacted (idle 55 minutes): 20.7k → 1.9k tokens, 2% (52% threshold) · idle 19 hours 19 minutes before this message')
    expect(detail).toContain('20,721 → 1,947 tokens of 1,000,000')
    expect(detail).toContain('Cost $0.037: 19,801 tokens read from cache, 2,762 uncached.')
    expect(detail).toContain('repeated to it word for word')
  })

  it('says a size compaction passed the threshold, and how long the message waited for it', () => {
    const size: Compaction = {
      ...idle, trigger: 'size', lastActivity: SENT - 30_000, finishedBeforeMs: 0, waitedMs: 6_000, durationMs: 20_000,
      tokensBefore: 41_266, tokensAfter: 2_882,
    }
    const { text, detail } = compactionTrace(size, 1_000_000, SENT, true)
    expect(text).toBe('Memory compacted (over the size threshold): 41.3k → 2.9k tokens, 4% (103% threshold) · idle 30 seconds before this message')
    expect(detail).toContain('which waited 6 seconds for it')
  })

  it('leaves out the window, and the idle time, when the daemon did not say them', () => {
    const { lastActivity: _, ...unknown } = idle
    expect(compactionTrace(unknown, undefined, SENT, false).text).toBe('Memory compacted (idle): 20.7k → 1.9k tokens, 52% threshold')
  })

  it('says a failed compaction failed, with its error in the detail', () => {
    const { text, detail } = compactionTrace({ ...idle, error: 'Not enough messages to compact.' }, 1_000_000, SENT, true)
    expect(text).toMatch(/^Memory compaction failed \(idle 55 minutes\) at 20\.7k tokens, 2% \(52% threshold\)/)
    expect(detail).toContain('Error: Not enough messages to compact.')
  })
})
