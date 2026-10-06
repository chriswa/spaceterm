import { describe, expect, it, vi, afterEach } from 'vitest'
import { ApprovalFeed, type FeedConnection } from './approval-feed'
import type { ApprovalsSnapshot } from '../shared/approvals'

/** One connection attempt, driven by the test as the provider. */
class FakeConnection implements FeedConnection {
  written: Array<Record<string, unknown>> = []
  destroyed = false
  private listeners: Record<string, Array<(...args: never[]) => void>> = {}
  on(event: string, listener: (...args: never[]) => void): void {
    ;(this.listeners[event] ??= []).push(listener)
  }
  write(data: string): void {
    for (const line of data.split('\n').filter(Boolean)) this.written.push(JSON.parse(line))
  }
  destroy(): void {
    this.destroyed = true
    this.emit('close')
  }
  emit(event: string, ...args: unknown[]): void {
    for (const l of this.listeners[event] ?? []) (l as (...a: unknown[]) => void)(...args)
  }
  /** The provider sends one message. */
  send(message: Record<string, unknown>): void {
    this.emit('data', JSON.stringify(message) + '\n')
  }
}

function harness() {
  const connections: FakeConnection[] = []
  const snapshots: ApprovalsSnapshot[] = []
  let t = 1_000
  const feed = new ApprovalFeed((s) => snapshots.push(s), {
    transport: () => {
      const c = new FakeConnection()
      connections.push(c)
      return c
    },
    reconnectMs: 10,
    now: () => t
  })
  const latest = () => snapshots[snapshots.length - 1]
  return { feed, connections, latest, advance: (ms: number) => { t += ms } }
}

const ITEM = { id: 'a1', revision: 1, createdAt: 900, expiresAt: null, challenge: 'c', document: '{"title":"T"}' }

function connectWithHello(c: FakeConnection, pairedKeys: string[] = []) {
  c.emit('connect')
  c.send({ type: 'hello', protocol: 1, provider: 'opProxy', pairedKeys })
}

afterEach(() => vi.useRealTimers())

describe('ApprovalFeed', () => {
  it('holds what the provider says is pending, tagged with its name', () => {
    const { feed, connections, latest } = harness()
    feed.start()
    connectWithHello(connections[0], ['k1'])
    connections[0].send({ type: 'snapshot', items: [ITEM] })
    expect(latest().sources).toEqual([{ name: 'opProxy', connected: true, pairedKeys: ['k1'] }])
    expect(latest().items).toEqual([{ ...ITEM, source: 'opProxy' }])

    connections[0].send({ type: 'upsert', item: { ...ITEM, revision: 2, expiresAt: 5000 } })
    expect(latest().items).toEqual([{ ...ITEM, revision: 2, expiresAt: 5000, source: 'opProxy' }])
  })

  it('passes the document through as the exact string it was sent', () => {
    const { feed, connections, latest } = harness()
    feed.start()
    connectWithHello(connections[0])
    // Key order and spacing a re-encode would change.
    const document = '{ "title" : "T",\n"confirm":"x", "actions":[] }'
    connections[0].send({ type: 'upsert', item: { ...ITEM, document } })
    expect(latest().items[0].document).toBe(document)
  })

  it('keeps a note on what closed, for a phone that was looking at it', () => {
    const { feed, connections, latest, advance } = harness()
    feed.start()
    connectWithHello(connections[0])
    connections[0].send({ type: 'snapshot', items: [ITEM] })
    connections[0].send({ type: 'remove', id: 'a1', note: 'Approved on the Mac' })
    expect(latest().items).toEqual([])
    expect(latest().closed).toEqual([{ source: 'opProxy', id: 'a1', note: 'Approved on the Mac', at: 1_000 }])
    advance(3 * 60_000)
    expect(feed.snapshot().closed).toEqual([])
  })

  it('forgets everything when the provider goes, and reconnects for a fresh snapshot', () => {
    vi.useFakeTimers()
    const { feed, connections, latest } = harness()
    feed.start()
    connectWithHello(connections[0])
    connections[0].send({ type: 'snapshot', items: [ITEM] })
    connections[0].emit('close')
    expect(latest()).toMatchObject({ items: [], sources: [{ connected: false }] })

    vi.advanceTimersByTime(10)
    expect(connections).toHaveLength(2)
    connectWithHello(connections[1])
    connections[1].send({ type: 'snapshot', items: [ITEM] })
    expect(latest().items).toHaveLength(1)
    feed.stop()
  })

  it('keeps retrying while the provider is not running', () => {
    vi.useFakeTimers()
    const { feed, connections } = harness()
    feed.start()
    connections[0].emit('error', new Error('ENOENT'))
    connections[0].emit('close')
    vi.advanceTimersByTime(10)
    connections[1].emit('error', new Error('ENOENT'))
    connections[1].emit('close')
    vi.advanceTimersByTime(10)
    expect(connections).toHaveLength(3)
    feed.stop()
    vi.advanceTimersByTime(100)
    expect(connections).toHaveLength(3)
  })

  it('relays a signed reply untouched and resolves with the provider verdict', async () => {
    const { feed, connections } = harness()
    feed.start()
    connectWithHello(connections[0])
    const reply = { keyId: 'k1', statement: '{"v":1}', signature: 'c2ln' }
    const outcome = feed.reply('opProxy', 'a1', reply)
    expect(connections[0].written).toEqual([{ type: 'reply', id: 'a1', ...reply }])
    connections[0].send({ type: 'reply-result', id: 'a1', ok: false, error: 'That request was already answered.' })
    await expect(outcome).resolves.toEqual({ ok: false, error: 'That request was already answered.' })
  })

  it('fails a reply at once when the provider is not connected', async () => {
    const { feed } = harness()
    feed.start()
    await expect(feed.reply('opProxy', 'a1', { keyId: 'k', statement: 's', signature: 'x' }))
      .resolves.toMatchObject({ ok: false })
  })

  it('fails waiting replies when the connection drops', async () => {
    const { feed, connections } = harness()
    feed.start()
    connectWithHello(connections[0])
    const outcome = feed.reply('opProxy', 'a1', { keyId: 'k', statement: 's', signature: 'x' })
    connections[0].emit('close')
    await expect(outcome).resolves.toMatchObject({ ok: false, error: 'Lost the connection to opProxy.' })
    feed.stop()
  })

  it('answers pairings in the order they were asked', async () => {
    const { feed, connections } = harness()
    feed.start()
    connectWithHello(connections[0])
    const first = feed.pair('opProxy', 'pk1', 'iPhone')
    const second = feed.pair('opProxy', 'pk2', 'iPad')
    expect(connections[0].written).toEqual([
      { type: 'pair', publicKey: 'pk1', name: 'iPhone' },
      { type: 'pair', publicKey: 'pk2', name: 'iPad' }
    ])
    connections[0].send({ type: 'pair-result', keyId: 'k1', ok: true })
    connections[0].send({ type: 'pair-result', keyId: 'k2', ok: false, error: 'Cancelled' })
    await expect(first).resolves.toEqual({ ok: true })
    await expect(second).resolves.toEqual({ ok: false, error: 'Cancelled' })
  })

  it('hangs up on a protocol it does not speak', () => {
    const { feed, connections } = harness()
    feed.start()
    connections[0].emit('connect')
    connections[0].send({ type: 'hello', protocol: 2, provider: 'opProxy' })
    expect(connections[0].destroyed).toBe(true)
    feed.stop()
  })
})
