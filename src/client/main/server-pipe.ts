import * as net from 'net'
import { SOCKET_PATH } from '../../shared/protocol'
import type { ServerPipeEventKind } from '../../shared/api'

/**
 * Bytes between the renderer and the server's Unix socket, and nothing else.
 *
 * The protocol client runs in the renderer (`src/shared/server-client.ts`),
 * the same code the mobile web app runs over a WebSocket. A renderer cannot
 * open a Unix socket, so this process opens it on the renderer's behalf and
 * forwards text both ways without reading it.
 *
 * Every event carries the renderer's attempt id. A reload, or a reconnect
 * after a drop, opens a new attempt; anything still in flight from the old
 * socket arrives tagged with the old id and is ignored over there.
 */

/** The renderer end: `webContents`, narrowed. */
export interface PipeTarget {
  send(channel: 'server-pipe:event', attempt: string, kind: ServerPipeEventKind, chunk?: string): void
  isDestroyed(): boolean
}

/** A connected socket, narrowed to what the pipe uses. */
export interface PipeSocket {
  on(event: 'connect' | 'close', listener: () => void): unknown
  on(event: 'data', listener: (chunk: string) => void): unknown
  on(event: 'error', listener: (err: Error) => void): unknown
  removeAllListeners(): unknown
  write(text: string): unknown
  destroy(): unknown
}

export interface ServerPipeDeps {
  connect(): PipeSocket
}

export const REAL_SERVER_PIPE_DEPS: ServerPipeDeps = {
  connect() {
    const socket = net.createConnection(SOCKET_PATH)
    socket.setEncoding('utf8')
    return socket as unknown as PipeSocket
  }
}

export class ServerPipe {
  private socket: PipeSocket | null = null

  constructor(
    private readonly target: () => PipeTarget | null,
    private readonly deps: ServerPipeDeps = REAL_SERVER_PIPE_DEPS
  ) {}

  /** Replace whatever connection exists with a fresh attempt. */
  open(attempt: string): void {
    this.close()
    const socket = this.deps.connect()
    this.socket = socket
    const emit = (kind: ServerPipeEventKind, chunk?: string) => {
      if (this.socket !== socket) return
      const target = this.target()
      if (target && !target.isDestroyed()) target.send('server-pipe:event', attempt, kind, chunk)
    }
    socket.on('connect', () => emit('open'))
    socket.on('data', (chunk) => emit('data', chunk))
    socket.on('close', () => {
      emit('close')
      if (this.socket === socket) this.socket = null
    })
    // `close` follows every error; it is the one place an attempt ends. An
    // early refusal is expected while the server is starting, so not logged.
    socket.on('error', () => undefined)
  }

  send(text: string): void {
    this.socket?.write(text)
  }

  /** Drop the connection silently: the renderer asked, so it needs no `close`. */
  close(): void {
    const socket = this.socket
    if (!socket) return
    this.socket = null
    socket.removeAllListeners()
    socket.on('error', () => undefined)
    socket.destroy()
  }
}
