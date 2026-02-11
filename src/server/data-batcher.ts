/**
 * Hyper-style DataBatcher: batches PTY output to reduce IPC overhead.
 * Flushes when buffer exceeds 200KB or after 16ms, whichever comes first.
 */

const MAX_BATCH_SIZE = 200 * 1024 // 200KB
const BATCH_INTERVAL = 16 // ~1 frame at 60fps

export class DataBatcher {
  private buffer = ''
  private timer: ReturnType<typeof setTimeout> | null = null
  private readonly flush: (data: string) => void

  constructor(flush: (data: string) => void) {
    this.flush = flush
  }

  write(data: string): void {
    this.buffer += data

    if (this.buffer.length >= MAX_BATCH_SIZE) {
      this.doFlush()
      return
    }

    if (!this.timer) {
      this.timer = setTimeout(() => this.doFlush(), BATCH_INTERVAL)
    }
  }

  private doFlush(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }

    if (this.buffer.length > 0) {
      const data = this.buffer
      this.buffer = ''
      this.flush(data)
    }
  }

  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.buffer = ''
  }
}
