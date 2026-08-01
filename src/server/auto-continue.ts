/**
 * Potential Error Detector
 *
 * When Claude Code stops with text that looks like an API error (500, 502, 503,
 * 529, overloaded, etc.), mark the surface for human review. This deliberately
 * never writes to the PTY: an automated "continue" can run in a context where it
 * has destructive consequences.
 */

import { log } from '../client/main/logger'
import type { PtySessionId } from '../shared/ids'

/**
 * Regex to strip ANSI escape sequences from terminal output so we can
 * reliably pattern-match error messages in the scrollback.
 */
const ANSI_ESCAPE_RE = /\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[()][0-2]/g

/**
 * Patterns that indicate Claude Code stopped due to an API error rather than
 * a normal completion. Matched against the ANSI-stripped tail of the scrollback.
 *
 * Requires Claude Code's "API Error:" framing so bare status codes in assistant
 * prose (e.g. "yields a 500") do not false-positive. Canonical forms from
 * https://code.claude.com/docs/en/errors:
 *   API Error: 500 Internal server error...
 *   API Error: 500 {"type":"error","error":{"type":"api_error",...}}
 *   API Error: Repeated 529 Overloaded errors...
 *   API Error: Server error mid-response...
 */
const API_ERROR_RE =
  /API Error:\s*(?:(?:Repeated\s+)?(?:500|502|503|529)\b|Server error mid-response|Connection closed mid-response|Response stalled mid-stream|.*\b(?:overloaded_error|Internal server error)\b)/i

/** How many characters from the end of the scrollback to check for error patterns. */
const SCROLLBACK_TAIL_LENGTH = 2000

/** Bounded diagnostic context kept in the local log for later false-positive review. */
const MATCH_CONTEXT_LENGTH = 240

function matchContext(text: string, index: number, length: number): string {
  const start = Math.max(0, index - Math.floor(MATCH_CONTEXT_LENGTH / 2))
  const end = Math.min(text.length, index + length + Math.ceil(MATCH_CONTEXT_LENGTH / 2))
  const prefix = start > 0 ? '…' : ''
  const suffix = end < text.length ? '…' : ''
  return `${prefix}${text.slice(start, end).replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim()}${suffix}`
}

/** Pure matcher for tests and hasPotentialError. Operates on ANSI-stripped text. */
export function findApiErrorMatch(strippedScrollbackTail: string): RegExpExecArray | null {
  return API_ERROR_RE.exec(strippedScrollbackTail)
}

export interface PotentialErrorDetectorDeps {
  getScrollback(surfaceId: PtySessionId): string | null
  getNodeTitle(surfaceId: PtySessionId): string | null
}

export class PotentialErrorDetector {
  private deps: PotentialErrorDetectorDeps

  constructor(deps: PotentialErrorDetectorDeps) {
    this.deps = deps
  }

  /**
   * Called when a surface transitions to 'stopped'. Checks the scrollback
   * for API error patterns and returns whether it should be marked for review.
   */
  hasPotentialError(surfaceId: PtySessionId): boolean {
    const scrollback = this.deps.getScrollback(surfaceId)
    if (!scrollback) return false

    const tail = scrollback.slice(-SCROLLBACK_TAIL_LENGTH)
    const stripped = tail.replace(ANSI_ESCAPE_RE, '')

    const match = findApiErrorMatch(stripped)
    if (!match || match.index === undefined) return false

    const title = this.deps.getNodeTitle(surfaceId)
    // The log timestamp is added by logger.ts. Keep enough bounded, cleaned
    // context to diagnose broad-regex matches without recording all scrollback.
    log(`[potential-error] ${JSON.stringify({
      event: 'detected',
      surfaceId,
      title,
      matchedText: match[0],
      matchOffsetInTail: match.index,
      inspectedTailLength: stripped.length,
      context: matchContext(stripped, match.index, match[0].length)
    })}`)
    return true
  }
}
