import * as net from 'net'
import { homedir } from 'os'
import { join } from 'path'
import type { ApprovalItem, ApprovalOutcome, ApprovalSource, ApprovalsSnapshot, ClosedApproval, ProviderStatus, SignedApprovalReply } from '../shared/approvals'
import { LineParser } from './line-parser'

/**
 * Keeps the server connected to one approval provider's feed — opProxy's —
 * and holds what is pending, so a phone sees every request the moment it
 * connects or reconnects. The protocol is APPROVAL_FEED.md.
 *
 * **A relay, never a judge.** Documents and challenges are kept and handed on
 * as the provider's strings, and replies are passed back as the phone signed
 * them. The provider checks the phone's signature; nothing here could make a
 * reply acceptable, which is the point: anything running as the user can
 * reach this server's sockets too.
 */

export const OPPROXY_FEED_SOCKET = join(homedir(), '.opProxy', 'approval-feed.sock')

/** The provider is often simply not running: try again at this pace. */
const RECONNECT_MS = 3000
/** How long a reply may wait for the provider's verdict. */
const REPLY_TIMEOUT_MS = 15_000
/** Pairing waits on someone at the Mac confirming it with Touch ID. */
const PAIR_TIMEOUT_MS = 3 * 60_000
/** How long a closed request's note is kept, for a phone that was looking at it. */
const CLOSED_KEEP_MS = 2 * 60_000

/** The socket-shaped surface the feed needs; `net.Socket` satisfies it, and so does a test's fake. */
export interface FeedConnection {
  on(event: 'connect', listener: () => void): void
  on(event: 'data', listener: (chunk: string | Buffer) => void): void
  on(event: 'close', listener: () => void): void
  on(event: 'error', listener: (err: Error) => void): void
  write(data: string): void
  destroy(): void
}

export type FeedTransport = (socketPath: string) => FeedConnection

export const REAL_FEED_TRANSPORT: FeedTransport = (socketPath) => {
  const socket = net.createConnection(socketPath)
  socket.setEncoding('utf8')
  return socket
}

export interface ApprovalFeedOptions {
  socketPath?: string
  /** Shown until the provider's `hello` names it. */
  name?: string
  transport?: FeedTransport
  reconnectMs?: number
  now?: () => number
  log?: (message: string) => void
}

interface Waiter {
  resolve(outcome: ApprovalOutcome): void
  timer: ReturnType<typeof setTimeout>
}

type FeedMessage =
  | { type: 'hello'; protocol: number; provider: string; pairedKeys?: string[] }
  | { type: 'snapshot'; items: Omit<ApprovalItem, 'source'>[] }
  | { type: 'upsert'; item: Omit<ApprovalItem, 'source'> }
  | { type: 'remove'; id: string; note?: string }
  | { type: 'status'; status: ProviderStatus }
  | { type: 'reply-result'; id: string; ok: boolean; error?: string }
  | { type: 'pair-result'; keyId?: string; ok: boolean; error?: string }

export class ApprovalFeed {
  private readonly socketPath: string
  private readonly transport: FeedTransport
  private readonly reconnectMs: number
  private readonly now: () => number
  private readonly log: (message: string) => void
  private name: string
  private connection: FeedConnection | null = null
  private connected = false
  private pairedKeys: string[] = []
  private status: ProviderStatus | null = null
  private items = new Map<string, ApprovalItem>()
  private closed: ClosedApproval[] = []
  private replyWaiters = new Map<string, Waiter>()
  /** The provider answers pairings in the order they were asked. */
  private pairWaiters: Waiter[] = []
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private stopped = true

  constructor(private readonly onChange: (snapshot: ApprovalsSnapshot) => void, options: ApprovalFeedOptions = {}) {
    this.socketPath = options.socketPath ?? OPPROXY_FEED_SOCKET
    this.name = options.name ?? 'opProxy'
    this.transport = options.transport ?? REAL_FEED_TRANSPORT
    this.reconnectMs = options.reconnectMs ?? RECONNECT_MS
    this.now = options.now ?? Date.now
    this.log = options.log ?? (() => undefined)
  }

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.open()
  }

  stop(): void {
    this.stopped = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    this.connection?.destroy()
    this.dropConnection()
  }

  snapshot(): ApprovalsSnapshot {
    const t = this.now()
    this.closed = this.closed.filter((c) => t - c.at < CLOSED_KEEP_MS)
    const source: ApprovalSource = {
      name: this.name,
      connected: this.connected,
      pairedKeys: this.pairedKeys,
      ...(this.status && { status: this.status })
    }
    return { sources: [source], items: [...this.items.values()], closed: this.closed }
  }

  /**
   * All a failed connect tells us: the socket isn't there to answer. The
   * provider may be down, or running a build that predates the feed.
   */
  private unreachable(): string {
    return `Can't reach ${this.name}'s approval feed on the Mac.`
  }

  /** Hands a signed reply to the provider and waits for its verdict. */
  reply(source: string, id: string, reply: SignedApprovalReply): Promise<ApprovalOutcome> {
    if (source !== this.name) return Promise.resolve({ ok: false, error: `No approval source named ${source}.` })
    if (!this.connected) return Promise.resolve({ ok: false, error: this.unreachable() })
    // A second reply to the same request supersedes the first's wait; the provider answers both.
    this.replyWaiters.get(id)?.resolve({ ok: false, error: 'Superseded by another answer.' })
    return new Promise((resolve) => {
      const waiter: Waiter = {
        resolve: (outcome) => {
          clearTimeout(waiter.timer)
          if (this.replyWaiters.get(id) === waiter) this.replyWaiters.delete(id)
          resolve(outcome)
        },
        timer: setTimeout(() => waiter.resolve({ ok: false, error: `${this.name} didn't answer.` }), REPLY_TIMEOUT_MS)
      }
      this.replyWaiters.set(id, waiter)
      this.send({ type: 'reply', id, keyId: reply.keyId, statement: reply.statement, signature: reply.signature })
    })
  }

  /** Asks the provider to trust a phone's key; someone at the Mac has to confirm it. */
  pair(source: string, publicKey: string, name: string): Promise<ApprovalOutcome> {
    if (source !== this.name) return Promise.resolve({ ok: false, error: `No approval source named ${source}.` })
    if (!this.connected) return Promise.resolve({ ok: false, error: this.unreachable() })
    return new Promise((resolve) => {
      const waiter: Waiter = {
        resolve: (outcome) => {
          clearTimeout(waiter.timer)
          this.pairWaiters = this.pairWaiters.filter((w) => w !== waiter)
          resolve(outcome)
        },
        timer: setTimeout(() => waiter.resolve({ ok: false, error: 'Nobody confirmed the pairing on the Mac.' }), PAIR_TIMEOUT_MS)
      }
      this.pairWaiters.push(waiter)
      this.send({ type: 'pair', publicKey, name })
    })
  }

  private open(): void {
    const connection = this.transport(this.socketPath)
    this.connection = connection
    const parser = new LineParser((msg) => this.handle(msg as FeedMessage))
    connection.on('connect', () => {
      if (this.connection !== connection) return
      this.connected = true
      this.log(`[approval-feed] connected to ${this.socketPath}`)
      this.changed()
    })
    connection.on('data', (chunk) => {
      if (this.connection === connection) parser.feed(chunk)
    })
    connection.on('close', () => {
      if (this.connection !== connection) return
      if (this.connected) this.log(`[approval-feed] ${this.name} went away`)
      this.dropConnection()
      this.scheduleReconnect()
    })
    // A missing socket is the provider not running: quietly try again.
    connection.on('error', () => undefined)
  }

  /** Everything the provider sent is void without it; it resends it all on the next connection. */
  private dropConnection(): void {
    const had = this.connected || this.items.size > 0
    this.connection = null
    this.connected = false
    this.status = null
    this.items.clear()
    for (const waiter of [...this.replyWaiters.values(), ...this.pairWaiters]) {
      waiter.resolve({ ok: false, error: `Lost the connection to ${this.name}.` })
    }
    if (had) this.changed()
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (!this.stopped) this.open()
    }, this.reconnectMs)
  }

  private send(message: Record<string, unknown>): void {
    this.connection?.write(JSON.stringify(message) + '\n')
  }

  private handle(msg: FeedMessage): void {
    switch (msg.type) {
      case 'hello':
        if (msg.protocol !== 1) {
          this.log(`[approval-feed] ${msg.provider} speaks protocol ${msg.protocol}; this server knows 1`)
          this.connection?.destroy()
          return
        }
        this.name = msg.provider
        this.pairedKeys = msg.pairedKeys ?? []
        this.changed()
        return
      case 'snapshot':
        this.items.clear()
        for (const item of msg.items) this.items.set(item.id, { ...item, source: this.name })
        this.changed()
        return
      case 'upsert':
        this.items.set(msg.item.id, { ...msg.item, source: this.name })
        this.changed()
        return
      case 'remove':
        if (!this.items.delete(msg.id)) return
        this.closed.push({ source: this.name, id: msg.id, note: msg.note, at: this.now() })
        this.changed()
        return
      case 'status':
        this.status = msg.status
        this.changed()
        return
      case 'reply-result':
        this.replyWaiters.get(msg.id)?.resolve({ ok: msg.ok, error: msg.error })
        return
      case 'pair-result':
        this.pairWaiters[0]?.resolve({ ok: msg.ok, error: msg.error })
        return
      default:
        // A newer provider's message this server does not know.
        return
    }
  }

  private changed(): void {
    this.onChange(this.snapshot())
  }
}
