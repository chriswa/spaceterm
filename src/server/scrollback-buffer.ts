import { applyAnsi, renderAnsiState, INITIAL_ANSI_STATE, type AnsiState } from './ansi-state'

const MAX_SIZE = 1024 * 1024 // 1MB — trigger eviction
const TRIM_TARGET = 512 * 1024 // 512KB — trim down to this
const NEWLINE_SCAN_LIMIT = 10_000

export class ScrollbackBuffer {
  private chunks: string[] = []
  private totalLength = 0
  /**
   * ANSI state established by data that has been evicted. Folded forward on each
   * trim and re-emitted ahead of the surviving tail by getContents(), so a client
   * replaying a truncated scrollback starts in the state the application expects
   * rather than the terminal default. See ansi-state.ts and
   * ANSI_PRESERVATION_BUG.md.
   */
  private evictedState: AnsiState = INITIAL_ANSI_STATE

  write(data: string): void {
    this.chunks.push(data)
    this.totalLength += data.length

    if (this.totalLength > MAX_SIZE) {
      const joined = this.chunks.join('')
      let cutPoint = joined.length - TRIM_TARGET
      const scanEnd = Math.min(cutPoint + NEWLINE_SCAN_LIMIT, joined.length)
      const newlineIndex = joined.indexOf('\n', cutPoint)
      if (newlineIndex !== -1 && newlineIndex < scanEnd) {
        cutPoint = newlineIndex + 1
      }
      // Fold what we are about to drop into the carried state before dropping it.
      // Folding forward (rather than rescanning from session start) keeps this
      // correct across repeated trims, since earlier evictions are already
      // represented in evictedState.
      this.evictedState = applyAnsi(this.evictedState, joined.slice(0, cutPoint))
      this.chunks = [joined.slice(cutPoint)]
      this.totalLength = this.chunks[0].length
    }
  }

  getContents(): string {
    // renderAnsiState returns '' until something has actually been evicted, so a
    // buffer that never trimmed replays byte-for-byte.
    return renderAnsiState(this.evictedState) + this.chunks.join('')
  }

  clear(): void {
    this.chunks = []
    this.totalLength = 0
    this.evictedState = INITIAL_ANSI_STATE
  }
}
