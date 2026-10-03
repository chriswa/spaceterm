import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ServerClient, type ServerTransport, type TransportHandlers } from './server-client'
import { createApi } from './client-api'
import type { PlatformApi } from './api'
import { asNodeId, asPtySessionId } from './ids'

/** A transport the test drives by hand: it decides when attempts open and close. */
class FakeTransport implements ServerTransport {
  handlers: TransportHandlers | null = null
  opens = 0
  closes = 0
  readonly sent: Array<Record<string, unknown>> = []

  open(handlers: TransportHandlers): void {
    this.opens++
    this.handlers = handlers
  }
  send(text: string): void {
    expect(text.endsWith('\n')).toBe(true)
    this.sent.push(JSON.parse(text))
  }
  close(): void {
    this.closes++
    this.handlers = null
  }

  accept(): void { this.handlers!.onOpen() }
  drop(): void {
    const h = this.handlers!
    this.handlers = null
    h.onClose()
  }
  receive(...msgs: unknown[]): void {
    this.handlers!.onData(msgs.map((m) => JSON.stringify(m) + '\n').join(''))
  }
  /** The last request of a type, minus its seq, and that seq. */
  last(type: string): { seq: number; msg: Record<string, unknown> } {
    const msg = [...this.sent].reverse().find((m) => m.type === type)
    if (!msg) throw new Error(`nothing sent of type ${type}`)
    return { seq: msg.seq as number, msg }
  }
}

function connected(): { t: FakeTransport; client: ServerClient } {
  const t = new FakeTransport()
  const client = new ServerClient(t, { clientName: 'test' })
  void client.connect()
  t.accept()
  return { t, client }
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('ServerClient', () => {
  it('announces itself on connect', () => {
    const { t } = connected()
    expect(t.last('client-hello').msg).toMatchObject({ client: 'test' })
  })

  it('correlates a reply to its request by seq, whatever arrives in between', async () => {
    const { t, client } = connected()
    const pending = client.attach(asPtySessionId('s1'))
    const { seq } = t.last('attach')
    t.receive(
      { type: 'node-removed', nodeId: 'x' },
      { type: 'attached', seq, sessionId: 's1', scrollback: 'hello' }
    )
    await expect(pending).resolves.toEqual({ scrollback: 'hello' })
  })

  it('reassembles messages split across chunks', () => {
    const { t, client } = connected()
    const seen: string[] = []
    client.on('node-removed', (m) => seen.push(m.nodeId))
    const line = JSON.stringify({ type: 'node-removed', nodeId: 'abc' }) + '\n'
    t.handlers!.onData(line.slice(0, 7))
    expect(seen).toEqual([])
    t.handlers!.onData(line.slice(7) + JSON.stringify({ type: 'node-removed', nodeId: 'def' }))
    expect(seen).toEqual(['abc'])
    t.handlers!.onData('\n')
    expect(seen).toEqual(['abc', 'def'])
  })

  it('rejects a request the server answers with a correlated error', async () => {
    const { t, client } = connected()
    const pending = client.shipIt(asNodeId('n1'), 'hi')
    t.receive({ type: 'server-error', seq: t.last('ship-it').seq, message: 'no surface' })
    await expect(pending).rejects.toThrow('no surface')
  })

  it('rejects everything in flight on a drop, then reconnects with backoff', async () => {
    const { t, client } = connected()
    const disconnects = vi.fn()
    client.onLifecycle('disconnect', disconnects)
    const pending = client.syncRequest()
    t.drop()
    await expect(pending).rejects.toThrow('Disconnected')
    expect(disconnects).toHaveBeenCalledTimes(1)
    expect(client.isConnected()).toBe(false)

    expect(t.opens).toBe(1)
    vi.advanceTimersByTime(200)
    expect(t.opens).toBe(2)
  })

  it('refuses requests while disconnected instead of queueing them', async () => {
    const t = new FakeTransport()
    const client = new ServerClient(t, { clientName: 'test' })
    await expect(client.list()).rejects.toThrow('Not connected')
  })

  it('stops reconnecting after disconnect()', () => {
    const { t, client } = connected()
    client.disconnect()
    expect(t.closes).toBe(1)
    vi.advanceTimersByTime(10_000)
    expect(t.opens).toBe(1)
  })

  it('keeps delivering an event when one listener throws', () => {
    // The renderer once stopped applying node updates because a notification
    // sound threw inside the same handler.
    const { t, client } = connected()
    const later = vi.fn()
    client.on('node-removed', () => { throw new Error('boom') })
    client.on('node-removed', later)
    t.receive({ type: 'node-removed', nodeId: 'n' })
    expect(later).toHaveBeenCalled()
  })
})

describe('createApi', () => {
  const platform: PlatformApi = {
    log: () => undefined,
    writeDebugLog: async () => '',
    openExternal: async () => undefined,
    restartClient: vi.fn(),
    raiseWindow: vi.fn(),
    onFocusRequest: () => () => undefined,
    perf: { startTrace: async () => undefined, stopTrace: async () => '' },
    window: { fitToWorkArea: async () => undefined, onVisibilityChanged: () => () => undefined, onFocusChanged: () => () => undefined },
    system: {
      setMetricsEnabled: () => undefined, onMetrics: () => () => undefined,
      getLaunchPrefs: async () => ({ highPerformanceGpu: false }), setLaunchPrefs: async () => ({ highPerformanceGpu: false }),
      getActiveLaunchPrefs: async () => ({ highPerformanceGpu: false })
    }
  }

  it('delivers pty output only to that session’s listeners', () => {
    const { t, client } = connected()
    const api = createApi(client, platform)
    const a = vi.fn()
    const b = vi.fn()
    api.pty.onData(asPtySessionId('a'), a)
    const offB = api.pty.onData(asPtySessionId('b'), b)
    t.receive({ type: 'data', sessionId: 'a', data: 'for a' })
    expect(a).toHaveBeenCalledWith('for a')
    expect(b).not.toHaveBeenCalled()

    offB()
    t.receive({ type: 'data', sessionId: 'b', data: 'for b' })
    expect(b).not.toHaveBeenCalled()
  })

  it('raises the window before navigating to a focus request', () => {
    const { t, client } = connected()
    const api = createApi(client, platform)
    const focused = vi.fn()
    api.window.onFocusNode(focused)
    t.receive({ type: 'focus-surface', nodeId: 'n1' })
    expect(platform.raiseWindow).toHaveBeenCalled()
    expect(focused).toHaveBeenCalledWith('n1')
  })

  it('replays the receptionist’s on-connect state to a listener that subscribes late', () => {
    // The stores subscribe once the app has mounted, after the connect push.
    const { t, client } = connected()
    const api = createApi(client, platform)
    t.receive(
      { type: 'receptionist-status', phase: 'ready', target: true },
      { type: 'receptionist-talk-to-me', enabled: false },
      { type: 'agent-names', names: { n1: 'Kevin' } },
      { type: 'camera-follow', nodeId: 'n1' }
    )
    const status = vi.fn()
    const talk = vi.fn()
    const names = vi.fn()
    const follow = vi.fn()
    api.receptionist.onStatus(status)
    api.receptionist.onTalkToMe(talk)
    api.receptionist.onAgentNames(names)
    api.receptionist.onCameraFollow(follow)
    expect(status).toHaveBeenCalledWith({ phase: 'ready', target: true, message: undefined })
    expect(talk).toHaveBeenCalledWith(false)
    expect(names).toHaveBeenCalledWith({ n1: 'Kevin' })
    // A camera move is an instruction for then, not state: never replayed.
    expect(follow).not.toHaveBeenCalled()

    t.receive({ type: 'camera-follow', nodeId: 'n2' }, { type: 'agent-names', names: {} })
    expect(follow).toHaveBeenCalledWith('n2')
    expect(names).toHaveBeenLastCalledWith({})
  })

  it('sends Control’s presses fire-and-forget', () => {
    const { t, client } = connected()
    const api = createApi(client, platform)
    api.receptionist.select()
    api.receptionist.setTalkToMe(true)
    expect(t.last('receptionist-select').msg).toEqual({ type: 'receptionist-select' })
    expect(t.last('set-receptionist-talk-to-me').msg).toEqual({ type: 'set-receptionist-talk-to-me', enabled: true })
  })

  it('filters mod traffic to the mod that asked', () => {
    const { t, client } = connected()
    const api = createApi(client, platform)
    const mine = vi.fn()
    api.mods.onMessage('mine', mine)
    t.receive({ type: 'mod', modId: 'theirs', event: 'e', payload: 1 }, { type: 'mod', modId: 'mine', event: 'e', payload: 2 })
    expect(mine).toHaveBeenCalledTimes(1)
    expect(mine).toHaveBeenCalledWith('e', 2)
  })

  it('restarts the client only once the server has accepted the restart', async () => {
    const { t, client } = connected()
    const api = createApi(client, platform)
    const restarting = api.restartSpaceterm()
    expect(platform.restartClient).not.toHaveBeenCalled()
    t.receive({ type: 'server-restarted', seq: t.last('server-restart').seq })
    await restarting
    expect(platform.restartClient).toHaveBeenCalled()
  })
})
