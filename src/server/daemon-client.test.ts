import { describe, expect, it, vi } from 'vitest'
import { DaemonClient, type DaemonMessage } from './daemon-client'
import { FakeDaemon } from './testing/fake-daemon'

/**
 * DaemonClient drives the PTY daemon connection: handshake, JSON-lines framing,
 * and reconnection. The daemon itself is a separate Go process, so these run
 * against an in-memory transport (see testing/fake-daemon.ts).
 */
function setup(reconnectDelayMs = 1) {
  const daemon = new FakeDaemon()
  const received: DaemonMessage[] = []
  const client = new DaemonClient((m) => received.push(m), { transport: daemon, reconnectDelayMs })
  return { daemon, client, received }
}

describe('DaemonClient connection', () => {
  it('ensures the daemon is running before connecting', async () => {
    const { daemon, client } = setup()
    await client.connect()
    expect(daemon.ensureRunningCalls).toBe(1)
    expect(client.isConnected()).toBe(true)
    client.dispose()
  })

  it('rejects when the daemon cannot be started', async () => {
    const { daemon, client } = setup()
    daemon.ensureRunningError = new Error('binary not found')
    await expect(client.connect()).rejects.toThrow('binary not found')
    expect(daemon.connections).toHaveLength(0)
    client.dispose()
  })

  it('rejects when the connection errors before it opens', async () => {
    const { daemon, client } = setup()
    daemon.autoOpen = false
    const pending = client.connect()
    await Promise.resolve()
    daemon.current.fail(new Error('ECONNREFUSED'))
    await expect(pending).rejects.toThrow('ECONNREFUSED')
    client.dispose()
  })

  it('reports disconnected before connecting', () => {
    const { client } = setup()
    expect(client.isConnected()).toBe(false)
    client.dispose()
  })
})

describe('DaemonClient messaging', () => {
  it('delivers a message from the daemon', async () => {
    const { daemon, client, received } = setup()
    await client.connect()
    daemon.current.send({ type: 'data', id: 's1', data: 'hello' })
    expect(received).toEqual([{ type: 'data', id: 's1', data: 'hello' }])
    client.dispose()
  })

  it('delivers several messages arriving in one chunk', async () => {
    const { daemon, client, received } = setup()
    await client.connect()
    daemon.current.sendRaw('{"type":"a"}\n{"type":"b"}\n')
    expect(received).toEqual([{ type: 'a' }, { type: 'b' }])
    client.dispose()
  })

  it('reassembles a message split across chunks', async () => {
    const { daemon, client, received } = setup()
    await client.connect()
    daemon.current.sendRaw('{"type":"pa')
    expect(received).toEqual([])
    daemon.current.sendRaw('rtial"}\n')
    expect(received).toEqual([{ type: 'partial' }])
    client.dispose()
  })

  it('skips a malformed frame without dropping the next one', async () => {
    const { daemon, client, received } = setup()
    await client.connect()
    daemon.current.sendRaw('garbage\n{"type":"ok"}\n')
    expect(received).toEqual([{ type: 'ok' }])
    client.dispose()
  })

  it('sends a framed message to the daemon', async () => {
    const { daemon, client } = setup()
    await client.connect()
    client.send({ type: 'create', id: 's1' })
    expect(daemon.current.written).toEqual(['{"type":"create","id":"s1"}\n'])
    client.dispose()
  })

  it('drops sends made before connecting', () => {
    const { daemon, client } = setup()
    client.send({ type: 'create' })
    expect(daemon.connections).toHaveLength(0)
    client.dispose()
  })

  it('drops sends made after the connection closes', async () => {
    const { daemon, client } = setup()
    await client.connect()
    const connection = daemon.current
    connection.close()
    client.send({ type: 'create' })
    expect(connection.messages()).toEqual([])
    client.dispose()
  })
})

describe('DaemonClient reconnection', () => {
  it('reconnects after the daemon drops the connection', async () => {
    const { daemon, client } = setup()
    await client.connect()
    expect(daemon.connections).toHaveLength(1)

    daemon.current.close()
    expect(client.isConnected()).toBe(false)

    await vi.waitFor(() => expect(daemon.connections).toHaveLength(2))
    await vi.waitFor(() => expect(client.isConnected()).toBe(true))
    client.dispose()
  })

  it('fires the reconnect callback once reconnected', async () => {
    const { daemon, client } = setup()
    const onReconnect = vi.fn()
    client.setOnReconnect(onReconnect)
    await client.connect()

    daemon.current.close()
    await vi.waitFor(() => expect(onReconnect).toHaveBeenCalledTimes(1))
    client.dispose()
  })

  it('does not fire the reconnect callback on the first connection', async () => {
    const { client } = setup()
    const onReconnect = vi.fn()
    client.setOnReconnect(onReconnect)
    await client.connect()
    expect(onReconnect).not.toHaveBeenCalled()
    client.dispose()
  })

  it('delivers messages over the reconnected connection', async () => {
    const { daemon, client, received } = setup()
    await client.connect()
    daemon.current.close()
    await vi.waitFor(() => expect(client.isConnected()).toBe(true))

    daemon.current.send({ type: 'after-reconnect' })
    expect(received).toEqual([{ type: 'after-reconnect' }])
    client.dispose()
  })

  it('keeps retrying while the daemon refuses to start', async () => {
    const { daemon, client } = setup()
    await client.connect()
    daemon.ensureRunningError = new Error('still down')
    daemon.current.close()
    // Each failed attempt must schedule another rather than giving up.
    await vi.waitFor(() => expect(daemon.ensureRunningCalls).toBeGreaterThan(2))
    client.dispose()
  })

  it('stops reconnecting once disposed', async () => {
    const { daemon, client } = setup()
    await client.connect()
    // dispose() destroys the socket, which fires 'close' — without the disposed
    // guard the client would resurrect itself on the reconnect timer.
    client.dispose()
    const countAtDispose = daemon.connections.length
    await new Promise((r) => setTimeout(r, 20))
    expect(daemon.connections).toHaveLength(countAtDispose)
    expect(client.isConnected()).toBe(false)
  })

  it('is safe to dispose twice', async () => {
    const { client } = setup()
    await client.connect()
    client.dispose()
    expect(() => client.dispose()).not.toThrow()
  })
})
