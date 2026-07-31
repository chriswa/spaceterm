/**
 * Splits a stream of data on newlines to extract complete JSON messages.
 * Handles partial reads by buffering incomplete lines.
 */
import { StringDecoder } from 'string_decoder'

export class LineParser {
  private buffer = ''
  private decoder: StringDecoder | undefined
  private readonly onMessage: (message: unknown) => void

  constructor(onMessage: (message: unknown) => void) {
    this.onMessage = onMessage
  }

  feed(data: string | Buffer): void {
    // Every current caller calls socket.setEncoding('utf8') first, so `data`
    // arrives as a string with multi-byte sequences already reassembled across
    // reads. Node's socket types still describe the chunk as a Buffer, and a
    // caller that forgets setEncoding genuinely would deliver one — so decode
    // rather than casting. The decoder is per-instance and retained so a
    // sequence split across two chunks still joins correctly; a plain
    // data.toString() would corrupt it.
    const text = typeof data === 'string'
      ? data
      : (this.decoder ??= new StringDecoder('utf8')).write(data)

    this.buffer += text
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
