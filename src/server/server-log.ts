import { appendFile } from 'fs'
import { join } from 'path'
import { SOCKET_DIR } from '../shared/protocol'

/**
 * Append a line to ~/.spaceterm/electron.log. This is the log file the agent can
 * read directly — prefer it over console.log/console.error, which write to
 * stdout/stderr and are invisible to the agent (see CLAUDE.md "Logging").
 */
export function serverLog(message: string): void {
  const line = `${new Date().toISOString()}  ${message}\n`
  appendFile(join(SOCKET_DIR, 'electron.log'), line, () => {})
}

/**
 * Sanitize a string that may contain terminal escape/control sequences so it
 * can be safely logged without the host terminal interpreting those sequences
 * (which could change keyboard mode, cursor visibility, etc.). Replaces
 * non-printable characters with visible representations while preserving
 * \n, \r, and \t for readability.
 */
export function sanitizeForLog(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, (ch) => {
      const code = ch.charCodeAt(0)
      return `\\x${code.toString(16).padStart(2, '0')}`
    })
}
