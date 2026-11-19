import { WebSocket } from 'ws'

/**
 * The smallest client for the Chrome DevTools Protocol that browser cards
 * need: commands with replies, events, and flattened target sessions (each
 * page's commands carry its `sessionId` over the one browser connection).
 */

export interface CdpEvent {
  method: string
  params: Record<string, unknown>
  sessionId?: string
}

export interface CdpConnection {
  /** Resolves with the command's `result`; rejects with CDP's error message, or when the connection closes first. */
  send<T = Record<string, unknown>>(method: string, params?: object, sessionId?: string): Promise<T>
  onEvent(listener: (event: CdpEvent) => void): () => void
  /** Called once, when the connection ends for any reason. */
  onClose(listener: () => void): () => void
  close(): void
}

interface Pending {
  resolve(result: unknown): void
  reject(err: Error): void
}

/**
 * Open a browser-level CDP connection. `openTimeoutMs` bounds the handshake,
 * which for the user's own Chrome waits on them answering its "Allow remote
 * debugging?" dialog.
 */
export function connectCdp(url: string, openTimeoutMs: number): Promise<CdpConnection> {
  return new Promise((resolve, reject) => {
    // Chrome's pages are large; frames are the point of the connection.
    const ws = new WebSocket(url, { maxPayload: 256 * 1024 * 1024, perMessageDeflate: false })
    const pending = new Map<number, Pending>()
    const eventListeners = new Set<(event: CdpEvent) => void>()
    const closeListeners = new Set<() => void>()
    let nextId = 1
    let closed = false

    const timer = setTimeout(() => {
      ws.terminate()
      reject(new Error(`no answer from Chrome after ${Math.round(openTimeoutMs / 1000)} s`))
    }, openTimeoutMs)

    const connection: CdpConnection = {
      send<T>(method: string, params: object = {}, sessionId?: string): Promise<T> {
        if (closed) return Promise.reject(new Error('the browser connection is closed'))
        const id = nextId++
        return new Promise<T>((res, rej) => {
          pending.set(id, { resolve: res as (r: unknown) => void, reject: rej })
          ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
        })
      },
      onEvent(listener) {
        eventListeners.add(listener)
        return () => eventListeners.delete(listener)
      },
      onClose(listener) {
        closeListeners.add(listener)
        return () => closeListeners.delete(listener)
      },
      close() {
        ws.close()
      }
    }

    ws.on('open', () => {
      clearTimeout(timer)
      resolve(connection)
    })
    ws.on('message', (raw) => {
      let msg: { id?: number; result?: unknown; error?: { message?: string }; method?: string; params?: Record<string, unknown>; sessionId?: string }
      try {
        msg = JSON.parse(raw.toString())
      } catch {
        return
      }
      if (typeof msg.id === 'number') {
        const entry = pending.get(msg.id)
        if (!entry) return
        pending.delete(msg.id)
        if (msg.error) entry.reject(new Error(msg.error.message ?? 'CDP error'))
        else entry.resolve(msg.result ?? {})
        return
      }
      if (typeof msg.method === 'string') {
        const event: CdpEvent = { method: msg.method, params: msg.params ?? {}, sessionId: msg.sessionId }
        for (const listener of eventListeners) listener(event)
      }
    })
    ws.on('error', (err) => {
      if (!closed && ws.readyState !== WebSocket.OPEN) {
        clearTimeout(timer)
        reject(err)
      }
    })
    ws.on('close', () => {
      clearTimeout(timer)
      if (closed) return
      closed = true
      reject(new Error('Chrome closed the connection'))
      for (const entry of pending.values()) entry.reject(new Error('the browser connection closed'))
      pending.clear()
      for (const listener of closeListeners) listener()
    })
  })
}
