import type { ServerTransport, TransportHandlers } from '../shared/server-client'

/**
 * The phone's way to the server: a WebSocket to the web gateway
 * (src/server/web-gateway.ts), carrying exactly the lines the desktop sends
 * over its Unix socket. Reconnection is the shared client's job, not this one's.
 */
export function webSocketTransport(url: string): ServerTransport {
  let ws: WebSocket | null = null

  return {
    open(handlers: TransportHandlers) {
      const socket = new WebSocket(url)
      ws = socket
      let ended = false
      const end = () => {
        if (ended || ws !== socket) return
        ended = true
        ws = null
        handlers.onClose()
      }
      socket.onopen = () => { if (ws === socket) handlers.onOpen() }
      socket.onmessage = (event) => {
        if (ws === socket && typeof event.data === 'string') handlers.onData(event.data)
      }
      socket.onclose = end
      socket.onerror = end
    },
    send(text) {
      if (ws?.readyState === WebSocket.OPEN) ws.send(text)
    },
    close() {
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
