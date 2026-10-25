import type { ServerTransport, TransportHandlers } from '../shared/server-client'

/**
 * How long a connection attempt may take to open before it is given up and
 * the shared client's backoff tries again. The gateway is on the tailnet, a
 * round trip or two away; nothing else times a connect out, and iOS's own TCP
 * timeout is ~75 s. Wi-Fi coming back (Tailscale rebinding its tunnel) once
 * left an attempt hanging that long, mid-dictation (October 2026).
 */
export const CONNECT_TIMEOUT_MS = 4000

/** The socket, as much of it as this uses: a test's own, or a real WebSocket. */
export interface SocketLike {
  readonly readyState: number
  send(text: string): void
  close(): void
  onopen: (() => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onclose: (() => void) | null
  onerror: (() => void) | null
}

export interface WebSocketTransportDeps {
  /** Open a socket to the gateway. */
  connect(url: string): SocketLike
  /** Subscribe to the network path changing (`online`); returns the unsubscribe. */
  onNetworkChange(listener: () => void): () => void
}

const REAL_DEPS: WebSocketTransportDeps = {
  // Its handlers are typed with `this` and full events; these read neither.
  connect: (url) => new WebSocket(url) as unknown as SocketLike,
  onNetworkChange: (listener) => {
    window.addEventListener('online', listener)
    return () => window.removeEventListener('online', listener)
  },
}

const OPEN = 1

/**
 * The phone's way to the server: a WebSocket to the web gateway
 * (src/server/web-gateway.ts), carrying exactly the lines the desktop sends
 * over its Unix socket. Reconnection is the shared client's job, not this one's.
 *
 * An attempt that has not opened within {@link CONNECT_TIMEOUT_MS}, or is
 * still opening when the network changes under it, is ended here, so the
 * client's next attempt goes out on the network as it is now.
 */
export function webSocketTransport(url: string, deps: WebSocketTransportDeps = REAL_DEPS): ServerTransport {
  let ws: SocketLike | null = null
  /** Ends the attempt in flight, while it is still opening. */
  let stopOpening: () => void = () => undefined

  return {
    open(handlers: TransportHandlers) {
      const socket = deps.connect(url)
      ws = socket
      let ended = false
      let timer: ReturnType<typeof setTimeout> | undefined
      let offNetwork: () => void = () => undefined
      const settle = () => {
        clearTimeout(timer)
        offNetwork()
        stopOpening = () => undefined
      }
      const end = () => {
        if (ended || ws !== socket) return
        ended = true
        settle()
        ws = null
        handlers.onClose()
      }
      /** Give up on an attempt that is not opening: closed quietly, and reported as failed. */
      const abandon = () => {
        if (ended || ws !== socket) return
        socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null
        socket.close()
        end()
      }
      timer = setTimeout(abandon, CONNECT_TIMEOUT_MS)
      offNetwork = deps.onNetworkChange(abandon)
      stopOpening = settle
      socket.onopen = () => {
        if (ws !== socket) return
        settle()
        handlers.onOpen()
      }
      socket.onmessage = (event) => {
        if (ws === socket && typeof event.data === 'string') handlers.onData(event.data)
      }
      socket.onclose = end
      socket.onerror = end
    },
    send(text) {
      if (ws?.readyState === OPEN) ws.send(text)
    },
    close() {
      stopOpening()
      const socket = ws
      ws = null
      if (!socket) return
      socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null
      socket.close()
    }
  }
}

/** The gateway's socket URL for this page, carrying the pairing token. */
export function gatewayUrl(token: string, location: Location = window.location): string {
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${scheme}//${location.host}/ws?token=${encodeURIComponent(token)}`
}
