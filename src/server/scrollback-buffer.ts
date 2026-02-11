const MAX_SIZE = 1024 * 1024 // 1MB

export class ScrollbackBuffer {
  private chunks: string[] = []
  private totalLength = 0

  write(data: string): void {
    this.chunks.push(data)
    this.totalLength += data.length

    while (this.totalLength > MAX_SIZE && this.chunks.length > 1) {
      const dropped = this.chunks.shift()!
      this.totalLength -= dropped.length
    }

    // If a single chunk exceeds MAX_SIZE, trim it from the front
    if (this.totalLength > MAX_SIZE && this.chunks.length === 1) {
      const chunk = this.chunks[0]
      this.chunks[0] = chunk.slice(chunk.length - MAX_SIZE)
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
