import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { CONNECT_TIMEOUT_MS, webSocketTransport, type SocketLike, type WebSocketTransportDeps } from './ws-transport'

/** Sockets the test opens and fails by hand, and a network it changes. */
function fakeNetwork() {
  const sockets: Array<SocketLike & { closed: boolean }> = []
  const listeners = new Set<() => void>()
  const deps: WebSocketTransportDeps = {
    connect: () => {
      const socket: SocketLike & { closed: boolean } = {
        readyState: 0,
        closed: false,
        send: () => undefined,
        close() { socket.closed = true },
        onopen: null, onmessage: null, onclose: null, onerror: null,
      }
      sockets.push(socket)
      return socket
    },
    onNetworkChange: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
  return {
    deps,
    sockets,
    listening: () => listeners.size,
    change: () => { for (const listener of [...listeners]) listener() },
    open: (socket: SocketLike) => { (socket as { readyState: number }).readyState = 1; socket.onopen?.() },
  }
}

function handlers() {
  const seen: string[] = []
  return { seen, h: { onOpen: () => seen.push('open'), onData: (d: string) => seen.push(`data ${d}`), onClose: () => seen.push('close') } }
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('webSocketTransport', () => {
  it('gives up on an attempt that has not opened in time, so the client can try again', () => {
    const net = fakeNetwork()
    const { seen, h } = handlers()
    webSocketTransport('ws://x', net.deps).open(h)
    vi.advanceTimersByTime(CONNECT_TIMEOUT_MS - 1)
    expect(seen).toEqual([])
    vi.advanceTimersByTime(1)
    expect(seen).toEqual(['close'])
    expect(net.sockets[0].closed).toBe(true)
    expect(net.listening()).toBe(0)
  })

  it('gives up at once when the network changes under an attempt still opening', () => {
    const net = fakeNetwork()
    const { seen, h } = handlers()
    webSocketTransport('ws://x', net.deps).open(h)
    net.change()
    expect(seen).toEqual(['close'])
    vi.advanceTimersByTime(CONNECT_TIMEOUT_MS)
    expect(seen).toEqual(['close'])
  })

  it('leaves an open connection alone: no timeout, no network watch', () => {
    const net = fakeNetwork()
    const { seen, h } = handlers()
    webSocketTransport('ws://x', net.deps).open(h)
    net.open(net.sockets[0])
    expect(net.listening()).toBe(0)
    net.change()
    vi.advanceTimersByTime(CONNECT_TIMEOUT_MS * 2)
    expect(seen).toEqual(['open'])
  })

  it('reports a drop exactly once, however the socket says it', () => {
    const net = fakeNetwork()
    const { seen, h } = handlers()
    webSocketTransport('ws://x', net.deps).open(h)
    const socket = net.sockets[0]
    socket.onerror?.()
    socket.onclose?.()
    vi.advanceTimersByTime(CONNECT_TIMEOUT_MS)
    expect(seen).toEqual(['close'])
  })

  it('reports nothing after being closed by the client, mid-attempt', () => {
    const net = fakeNetwork()
    const { seen, h } = handlers()
    const transport = webSocketTransport('ws://x', net.deps)
    transport.open(h)
    transport.close()
    net.change()
    vi.advanceTimersByTime(CONNECT_TIMEOUT_MS)
    expect(seen).toEqual([])
    expect(net.listening()).toBe(0)
  })
})
