const MAX_SIZE = 1024 * 1024 // 1MB — trigger eviction
const TRIM_TARGET = 512 * 1024 // 512KB — trim down to this
const NEWLINE_SCAN_LIMIT = 10_000

export class ScrollbackBuffer {
  private chunks: string[] = []
  private totalLength = 0

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
      this.chunks = [joined.slice(cutPoint)]
      this.totalLength = this.chunks[0].length
    }
  }

  getContents(): string {
    return this.chunks.join('')
  }

  clear(): void {
    this.chunks = []
    this.totalLength = 0
  }
}
