/**
 * Auto-Continue Manager
 *
 * When Claude Code stops due to an API error (500, 502, 503, 529, overloaded, etc.),
 * this module schedules a delayed "continue" message to the PTY so unattended
 * surfaces can recover without user intervention.
 *
 * The timer is cancelled if the user interacts with the surface in any way
 * (typing, clearing the unread flag) — we never want to interfere with a user
 * who has already noticed the error and is handling it themselves.
 */

import { localISOTimestamp } from './timestamp'

/** How long (ms) to wait before auto-sending "continue" after an API error stop. */
const AUTO_CONTINUE_DELAY_MS = 60_000

/**
 * Regex to strip ANSI escape sequences from terminal output so we can
 * reliably pattern-match error messages in the scrollback.
 */
const ANSI_ESCAPE_RE = /\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[()][0-2]/g

/**
 * Patterns that indicate Claude Code stopped due to an API error rather than
 * a normal completion. Matched against the ANSI-stripped tail of the scrollback.
 *
 * Covers:
 * - HTTP status codes returned by the Anthropic API (500, 502, 503, 529)
 * - Error class names and messages from Claude Code's error handling
 * - Rate limit / overload signals
 */
const API_ERROR_RE = /\b(500|502|503|529|overloaded|Internal Server Error|APIError|api_error|rate.?limit)\b/i

/** How many characters from the end of the scrollback to check for error patterns. */
const SCROLLBACK_TAIL_LENGTH = 2000

export interface AutoContinueDeps {
  getScrollback(surfaceId: string): string | null
  writeToPty(surfaceId: string, data: string): void
  getNodeTitle(surfaceId: string): string | null
  broadcastToast(message: string): void
}

export class AutoContinueManager {
  private deps: AutoContinueDeps
  private pendingTimers = new Map<string, NodeJS.Timeout>()

  constructor(deps: AutoContinueDeps) {
    this.deps = deps
  }

  /**
   * Called when a surface transitions to 'stopped'. Checks the scrollback
   * for API error patterns and schedules an auto-continue if found.
   */
  onStopped(surfaceId: string): void {
    // Always cancel any existing timer first (e.g. rapid stop→stop transitions)
    this.cancelForSurface(surfaceId)

    const scrollback = this.deps.getScrollback(surfaceId)
    if (!scrollback) return

    const tail = scrollback.slice(-SCROLLBACK_TAIL_LENGTH)
    const stripped = tail.replace(ANSI_ESCAPE_RE, '')

    if (!API_ERROR_RE.test(stripped)) return

    const title = this.deps.getNodeTitle(surfaceId)
    const label = title ? `"${title}"` : surfaceId.slice(0, 8)
    console.log(`[auto-continue] ${localISOTimestamp()} Scheduling auto-continue for ${label} in ${AUTO_CONTINUE_DELAY_MS / 1000}s (API error detected in scrollback)`)

    this.pendingTimers.set(surfaceId, setTimeout(() => {
      this.pendingTimers.delete(surfaceId)

      const currentTitle = this.deps.getNodeTitle(surfaceId)
      const currentLabel = currentTitle ? `"${currentTitle}"` : surfaceId.slice(0, 8)
      console.log(`[auto-continue] ${localISOTimestamp()} Sending "continue" to ${currentLabel}`)

      const toastLabel = currentTitle ?? surfaceId.slice(0, 8)
      this.deps.broadcastToast(`Auto-continuing ${toastLabel} after API error`)

      this.deps.writeToPty(surfaceId, 'continue\r')
    }, AUTO_CONTINUE_DELAY_MS))
  }

  /**
   * Cancel any pending auto-continue for the given surface. Called when the
   * user interacts with the surface (typing, clearing unread flag) or when
   * the session exits/is destroyed.
   */
  cancelForSurface(surfaceId: string): void {
    const timer = this.pendingTimers.get(surfaceId)
    if (timer) {
      clearTimeout(timer)
      this.pendingTimers.delete(surfaceId)

      const title = this.deps.getNodeTitle(surfaceId)
      const label = title ? `"${title}"` : surfaceId.slice(0, 8)
      console.log(`[auto-continue] ${localISOTimestamp()} Cancelled auto-continue for ${label} (user activity)`)
    }
  }

  dispose(): void {
    for (const timer of this.pendingTimers.values()) {
      clearTimeout(timer)
    }
    this.pendingTimers.clear()
  }
}
