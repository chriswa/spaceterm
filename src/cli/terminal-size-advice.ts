/**
 * Sizing advice for the emergency terminal.
 *
 * Separate from `emergency-terminal.ts` because that module is a CLI entry
 * point: importing it parses `process.argv` and connects to a socket. These two
 * functions decide what a too-small window can be told to do, which is the part
 * worth testing.
 */
import { clampTerminalSize, MIN_COLS, MIN_ROWS } from '../shared/node-size'

/**
 * Parse a `COLSxROWS` argument. Returns null for anything else, so a typo is
 * reported rather than silently treated as "no resize".
 */
export function parseSizeArg(arg: string): { cols: number; rows: number } | null {
  const m = /^(\d+)[x×](\d+)$/i.exec(arg.trim())
  if (!m) return null
  return { cols: Number(m[1]), rows: Number(m[2]) }
}

/**
 * The largest surface this host terminal could attach to: its own size, less
 * the row tmux spends on a status bar. Clamped, so the suggestion it produces
 * is one the server will actually accept — `fits` is false when the window is
 * too small to hold even the minimum, which no resize can fix.
 */
export function sizeThatFitsHere(
  localCols: number,
  localRows: number
): { cols: number; rows: number; fits: boolean } {
  const usableRows = localRows - 1 // tmux status bar
  return {
    ...clampTerminalSize(localCols, usableRows),
    fits: localCols >= MIN_COLS && usableRows >= MIN_ROWS
  }
}
