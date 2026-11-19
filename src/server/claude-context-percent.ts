import type { PtySessionId } from '../shared/ids'
import type { SessionFileEntry } from './session-file-watcher'

/**
 * Claude Code reserves this many tokens as a buffer before triggering autocompact.
 * The effective context window = context_window_size - this buffer.
 * UPDATE THIS when Claude Code changes its compaction threshold.
 */
const CLAUDE_AUTOCOMPACT_BUFFER_TOKENS = 0

/**
 * How much of the context window a status line says is left, in percent, or
 * `null` when it says nothing usable.
 *
 * Cursor's status line states `remaining_percentage` / `used_percentage`
 * outright, and so does a current Claude Code; an older Claude Code gives only
 * `current_usage` and `context_window_size`.
 */
export function readStatusLineRemainingPercent(cw: Record<string, unknown>): number | null {
  const remaining = cw.remaining_percentage
  if (isNumber(remaining)) return remaining
  const used = cw.used_percentage
  if (isNumber(used)) return 100 - used

  const usage = cw.current_usage as Record<string, number> | undefined
  const contextWindowSize = cw.context_window_size
  if (usage && isNumber(contextWindowSize) && contextWindowSize > 0) {
    return (1 - usageTotal(usage) / (contextWindowSize - CLAUDE_AUTOCOMPACT_BUFFER_TOKENS)) * 100
  }
  return null
}

/**
 * A status line whose token counts are all zero: what Claude Code sends from
 * the moment a session is compacted until its next API call, because it only
 * knows a context size from a response. Also what a brand-new session sends,
 * where zero is true.
 */
function isZeroedReading(cw: Record<string, unknown>): boolean {
  const usage = cw.current_usage as Record<string, unknown> | null | undefined
  if (usage && usageTotal(usage) > 0) return false
  return !(count(cw.total_input_tokens) > 0) && !(count(cw.total_output_tokens) > 0)
}

interface SurfaceContext {
  /** The context window the last status line stated. */
  windowTokens?: number
  /**
   * The session's first request: the system prompt and tool definitions, plus
   * a first message. A compaction's `postTokens` counts only the conversation
   * kept, so this is what has to be added back to it.
   */
  baselineTokens?: number
  /** The newest compaction no request has followed yet, and the session it belongs to. */
  compacted?: { sessionId: string | undefined; tokens: number }
}

/**
 * The footer's context % for Claude surfaces, kept honest across a compaction.
 *
 * After `/compact` (or autocompact), Claude Code's status line reports zero
 * tokens until the next request, which the footer would show as 0% used. The
 * transcript knows better: its `compact_boundary` entry records `postTokens`,
 * the size of the conversation that was kept. Until a real reading arrives,
 * that plus the session's baseline stands in for it.
 *
 * The estimate runs low by the size of the next turn's input, which a real
 * reading supplies a moment later.
 */
export class ClaudeContextPercent {
  private readonly surfaces = new Map<PtySessionId, SurfaceContext>()

  /** The remaining % to show for this status line, or `null` to leave the footer alone. */
  observeStatusLine(surfaceId: PtySessionId, sessionId: unknown, cw: Record<string, unknown>): number | null {
    const surface = this.surface(surfaceId)
    if (isNumber(cw.context_window_size) && cw.context_window_size > 0) surface.windowTokens = cw.context_window_size

    if (!isZeroedReading(cw)) {
      surface.compacted = undefined
      return readStatusLineRemainingPercent(cw)
    }
    const compacted = surface.compacted
    if (compacted && (compacted.sessionId === undefined || sessionId === undefined || compacted.sessionId === sessionId)) {
      return this.estimate(surface) ?? readStatusLineRemainingPercent(cw)
    }
    return readStatusLineRemainingPercent(cw)
  }

  /**
   * Note compactions and requests from new transcript entries, returning the
   * remaining % to show if they leave the context known only by estimate.
   * `reset` is for a backfill, which re-reads the transcript from its start.
   */
  observeTranscript(surfaceId: PtySessionId, entries: SessionFileEntry[], { reset }: { reset: boolean }): number | null {
    const surface = this.surface(surfaceId)
    if (reset) {
      surface.baselineTokens = undefined
      surface.compacted = undefined
    }
    let sawCompaction = false
    for (const entry of entries) {
      if (entry.isSidechain === true) continue
      if (entry.type === 'system' && entry.subtype === 'compact_boundary') {
        const tokens = (entry.compactMetadata as Record<string, unknown> | undefined)?.postTokens
        if (!isNumber(tokens)) continue
        const sessionId = typeof entry.sessionId === 'string' ? entry.sessionId : undefined
        surface.compacted = { sessionId, tokens }
        sawCompaction = true
        continue
      }
      const usage = (entry.message as { usage?: Record<string, unknown> } | undefined)?.usage
      if (entry.type !== 'assistant' || !usage) continue
      const total = usageInputTotal(usage)
      if (total <= 0) continue
      surface.baselineTokens ??= total
      surface.compacted = undefined
      sawCompaction = false
    }
    return sawCompaction ? this.estimate(surface) : null
  }

  private estimate(surface: SurfaceContext): number | null {
    if (!surface.compacted || !surface.windowTokens) return null
    const used = surface.compacted.tokens + (surface.baselineTokens ?? 0)
    return Math.max(0, Math.min(100, (1 - used / (surface.windowTokens - CLAUDE_AUTOCOMPACT_BUFFER_TOKENS)) * 100))
  }

  private surface(surfaceId: PtySessionId): SurfaceContext {
    let surface = this.surfaces.get(surfaceId)
    if (!surface) {
      surface = {}
      this.surfaces.set(surfaceId, surface)
    }
    return surface
  }
}

/** Everything a request sent: fresh input plus what it wrote to and read from the cache. */
function usageInputTotal(usage: Record<string, unknown>): number {
  return count(usage.input_tokens) + count(usage.cache_creation_input_tokens) + count(usage.cache_read_input_tokens)
}

function usageTotal(usage: Record<string, unknown>): number {
  return usageInputTotal(usage) + count(usage.output_tokens)
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function count(value: unknown): number {
  return isNumber(value) && value > 0 ? value : 0
}
