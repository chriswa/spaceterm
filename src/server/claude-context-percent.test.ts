import { describe, it, expect } from 'vitest'
import { ClaudeContextPercent, readStatusLineRemainingPercent } from './claude-context-percent'
import type { SessionFileEntry } from './session-file-watcher'
import type { PtySessionId } from '../shared/ids'

const SURFACE = 'surface-1' as PtySessionId
const SESSION = '4c406d55-cdd9-414f-a395-0ed8198b661d'

/** Status lines copied from a real `/compact` on a 1M-token session (hook-logs). */
const BEFORE_COMPACT = {
  total_input_tokens: 951731, total_output_tokens: 445, context_window_size: 1000000,
  current_usage: { input_tokens: 2, output_tokens: 445, cache_creation_input_tokens: 243, cache_read_input_tokens: 951486 },
  used_percentage: 95, remaining_percentage: 5,
}
const ZEROED = {
  total_input_tokens: 0, total_output_tokens: 0, context_window_size: 1000000,
  current_usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  used_percentage: 0, remaining_percentage: 100,
}
const AFTER_NEXT_REQUEST = {
  total_input_tokens: 111944, total_output_tokens: 7, context_window_size: 1000000,
  current_usage: { input_tokens: 2, output_tokens: 7, cache_creation_input_tokens: 80753, cache_read_input_tokens: 31189 },
  used_percentage: 11, remaining_percentage: 89,
}

function assistant(inputTokens: number, extra: Record<string, unknown> = {}): SessionFileEntry {
  return {
    type: 'assistant',
    sessionId: SESSION,
    message: { usage: { input_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: inputTokens - 2, output_tokens: 100 } },
    ...extra,
  }
}

function boundary(postTokens: number, sessionId = SESSION): SessionFileEntry {
  return { type: 'system', subtype: 'compact_boundary', sessionId, compactMetadata: { trigger: 'manual', preTokens: 952176, postTokens } }
}

/** A session that started at 62k tokens and was compacted from 95% down to 37k of conversation. */
const TRANSCRIPT = [assistant(62321), assistant(500000), assistant(951731), boundary(37202)]

describe('readStatusLineRemainingPercent', () => {
  it('takes a stated percentage', () => {
    expect(readStatusLineRemainingPercent(BEFORE_COMPACT)).toBe(5)
    expect(readStatusLineRemainingPercent({ used_percentage: 30 })).toBe(70)
  })

  it('works one out from usage when none is stated', () => {
    const percent = readStatusLineRemainingPercent({ context_window_size: 200000, current_usage: { input_tokens: 50000 } })
    expect(percent).toBe(75)
  })
})

describe('ClaudeContextPercent', () => {
  it('estimates from the transcript instead of showing a compacted session as empty', () => {
    const tracker = new ClaudeContextPercent()
    tracker.observeStatusLine(SURFACE, SESSION, BEFORE_COMPACT)
    const fromTranscript = tracker.observeTranscript(SURFACE, TRANSCRIPT, { reset: true })
    const fromStatusLine = tracker.observeStatusLine(SURFACE, SESSION, ZEROED)

    // Kept conversation plus the session's baseline: about 10% used, not 0% or 95%.
    for (const percent of [fromTranscript, fromStatusLine]) {
      expect(percent).not.toBeNull()
      expect(percent!).toBeGreaterThan(85)
      expect(percent!).toBeLessThan(95)
    }
  })

  it('handles the zeroed status line arriving before the transcript does', () => {
    const tracker = new ClaudeContextPercent()
    tracker.observeTranscript(SURFACE, TRANSCRIPT.slice(0, 3), { reset: true })
    tracker.observeStatusLine(SURFACE, SESSION, ZEROED)
    const percent = tracker.observeTranscript(SURFACE, [boundary(37202)], { reset: false })
    expect(percent).toBeGreaterThan(85)
    expect(percent).toBeLessThan(95)
  })

  it('hands back to the status line once a request reports real usage', () => {
    const tracker = new ClaudeContextPercent()
    tracker.observeStatusLine(SURFACE, SESSION, BEFORE_COMPACT)
    tracker.observeTranscript(SURFACE, TRANSCRIPT, { reset: true })
    expect(tracker.observeStatusLine(SURFACE, SESSION, AFTER_NEXT_REQUEST)).toBe(89)
    expect(tracker.observeTranscript(SURFACE, [assistant(111944)], { reset: false })).toBeNull()
  })

  it('ignores a compaction that a later request already superseded', () => {
    const tracker = new ClaudeContextPercent()
    tracker.observeStatusLine(SURFACE, SESSION, BEFORE_COMPACT)
    expect(tracker.observeTranscript(SURFACE, [...TRANSCRIPT, assistant(111944)], { reset: true })).toBeNull()
    expect(tracker.observeStatusLine(SURFACE, SESSION, ZEROED)).toBe(100)
  })

  it('leaves a brand-new session at 0% used', () => {
    const tracker = new ClaudeContextPercent()
    expect(tracker.observeStatusLine(SURFACE, SESSION, ZEROED)).toBe(100)
  })

  it('does not carry a compaction into a different session, as after /clear', () => {
    const tracker = new ClaudeContextPercent()
    tracker.observeStatusLine(SURFACE, SESSION, BEFORE_COMPACT)
    tracker.observeTranscript(SURFACE, TRANSCRIPT, { reset: true })
    expect(tracker.observeStatusLine(SURFACE, 'another-session', ZEROED)).toBe(100)
  })

  it('ignores sidechain entries', () => {
    const tracker = new ClaudeContextPercent()
    tracker.observeStatusLine(SURFACE, SESSION, BEFORE_COMPACT)
    tracker.observeTranscript(SURFACE, TRANSCRIPT, { reset: true })
    expect(tracker.observeTranscript(SURFACE, [assistant(5000, { isSidechain: true })], { reset: false })).toBeNull()
    expect(tracker.observeStatusLine(SURFACE, SESSION, ZEROED)).toBeLessThan(95)
  })
})
