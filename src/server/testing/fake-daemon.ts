import type { DaemonConnection, DaemonMessage, DaemonTransport } from '../daemon-client'

/**
 * In-memory stand-in for the pty-daemon's unix socket.
 *
 * The daemon is a separate Go process, but it speaks a stable JSON-lines
 * protocol — which makes it the one dependency in this codebase that is safe to
 * fake wholesale. Faking the transport rather than the daemon lets DaemonClient
 * (and, above it, the session lifecycle) be exercised in-process with no Go
 * binary, no socket, and no timing.
 *
 * Testing-only. Nothing under src/server imports this outside *.test.ts.
 */
export class FakeDaemonConnection implements DaemonConnection {
  /** Raw frames written by the client, in order. */
  readonly written: string[] = []
  destroyed = false
  /** Hold writes unflushed until `flush`, as a busy socket would; flushed at once otherwise. */
  holdFlushes = false

  private unflushed: Array<() => void> = []

  private listeners = new Map<string, ((...args: any[]) => void)[]>()

  on(event: 'connect', listener: () => void): void
  on(event: 'data', listener: (chunk: string | Buffer) => void): void
  on(event: 'close', listener: () => void): void
  on(event: 'error', listener: (err: Error) => void): void
  on(event: string, listener: (...args: any[]) => void): void {
    const existing = this.listeners.get(event) ?? []
    existing.push(listener)
    this.listeners.set(event, existing)
  }

  write(data: string, flushed: () => void): void {
    this.written.push(data)
    if (this.holdFlushes) this.unflushed.push(flushed)
    else flushed()
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    // Mirror net.Socket: destroying a live socket fires 'close'.
    this.emit('close')
  }

  // ─── test controls ────────────────────────────────────────────────────────

  emit(event: string, ...args: any[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args)
  }

  /** Flush every held write. */
  flush(): void {
    for (const flushed of this.unflushed.splice(0)) flushed()
  }

  /** Complete the connection handshake. */
  open(): void {
    this.emit('connect')
  }

  /** Deliver a daemon message, correctly framed. */
  send(msg: Record<string, unknown>): void {
    this.emit('data', JSON.stringify(msg) + '\n')
  }

  /** Deliver raw bytes — for partial frames, split multi-byte chars, garbage. */
  sendRaw(chunk: string | Buffer): void {
    this.emit('data', chunk)
  }

  /** Drop the connection as the daemon would on exit. */
  close(): void {
    this.destroyed = true
    this.emit('close')
  }

  fail(err: Error): void {
    this.emit('error', err)
  }

  /** Frames the client wrote, parsed. */
  messages(): DaemonMessage[] {
    return this.written.map((line) => JSON.parse(line.trim()) as DaemonMessage)
  }
}

export class FakeDaemon implements DaemonTransport {
  readonly connections: FakeDaemonConnection[] = []
  ensureRunningCalls = 0

  /** When set, ensureRunning rejects with it — models a missing/unstartable binary. */
  ensureRunningError: Error | null = null
  /** When false, connections stay pending until the test calls open() itself. */
  autoOpen = true

  async ensureRunning(): Promise<void> {
    this.ensureRunningCalls++
    if (this.ensureRunningError) throw this.ensureRunningError
  }

  connect(): DaemonConnection {
    const connection = new FakeDaemonConnection()
    this.connections.push(connection)
    if (this.autoOpen) {
      // Asynchronous so the client has registered its listeners first, exactly
      // as a real socket's 'connect' event would arrive.
      queueMicrotask(() => connection.open())
    }
    return connection
  }

  /** The most recently opened connection. */
  get current(): FakeDaemonConnection {
    const last = this.connections.at(-1)
    if (!last) throw new Error('FakeDaemon: no connection has been opened')
    return last
  }
}
