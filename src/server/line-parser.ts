/**
 * Splits a stream of data on newlines to extract complete JSON messages.
 * Handles partial reads by buffering incomplete lines.
 */
export class LineParser {
  private buffer = ''
  private readonly onMessage: (message: unknown) => void

  constructor(onMessage: (message: unknown) => void) {
    this.onMessage = onMessage
  }

  feed(data: string): void {
    this.buffer += data
    const lines = this.buffer.split('\n')

    // Last element is either empty (if data ended with \n) or a partial line
    this.buffer = lines.pop()!

    for (const line of lines) {
      if (line.length === 0) continue
      try {
        this.onMessage(JSON.parse(line))
      } catch (err) {
        console.error(`[LineParser] Malformed JSON: ${err}. Line (first 200 chars): ${line.slice(0, 200)}`)
      }
    }
  }
}
