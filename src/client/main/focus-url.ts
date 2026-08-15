/**
 * The OS-level URL scheme that raises a surface.
 *
 * Split out from `index.ts` purely so it can be tested: that module pulls in
 * electron at import time, and parsing a string is the one part of the deep
 * link path that has no business needing an app instance to exercise.
 */

/** Registered with `app.setAsDefaultProtocolClient`. */
export const FOCUS_URL_SCHEME = 'spaceterm-surface'

const PREFIX = `${FOCUS_URL_SCHEME}://`

/**
 * Pull the id out of a `spaceterm-surface://<id>` link.
 *
 * Returns a plain `string`, not a branded id, and that is the point. The kind
 * of id is not knowable here: the URL may name a surface (`SPACETERM_SURFACE_ID`)
 * or an agent session — Claude, Codex, or Cursor — and both are UUIDs. Only the
 * server, which holds node state, can tell them apart, so this refuses to guess
 * (it used to assert `asPtySessionId`, which was wrong for half its callers).
 *
 * Tolerant about shape because the OS and the sender disagree about it: macOS
 * normalises `scheme://x` to `scheme://x/`, and hand-written links pick up
 * extra slashes. `spaceterm-surface://abc`, `:///abc`, and `://abc/` all name
 * the same thing.
 */
export function parseFocusUrl(url: string): string | null {
  if (!url.startsWith(PREFIX)) return null
  const id = decodeURIComponent(url.slice(PREFIX.length).replace(/^\/+/, '').replace(/\/+$/, ''))
  return id || null
}
