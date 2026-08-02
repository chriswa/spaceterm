import { describe, it, expect } from 'vitest'
import { ScriptApi, type ScriptConnection, type ScriptHost, type TranscriptLocation } from './script-api'
import { SCRIPT_EVENTS, SCRIPT_PROTOCOL_VERSION, MIN_SCRIPT_PROTOCOL_VERSION } from '../shared/protocol'
import type { ScriptMessage } from '../shared/protocol'
import type { NodeData, TerminalNodeData } from '../shared/state'
import { asNodeId, asPtySessionId, ROOT_NODE_ID, type NodeId, type PtySessionId } from '../shared/ids'

// The scripts socket is the mod API. These tests are about the contract a mod
// sees: which errors it can distinguish, what it may rely on staying open, and
// what it is told when this build and the script disagree about the protocol.

function nid(s: string): NodeId { return asNodeId(s) }
function sid(s: string): PtySessionId { return asPtySessionId(s) }

/** A terminal node keyed by a plain string id, which doubles as its session id. */
function terminal(overrides: Omit<Partial<TerminalNodeData>, 'id'> & { id: string }): TerminalNodeData {
  const { id, ...rest } = overrides
  return {
    type: 'terminal',
    parentId: ROOT_NODE_ID,
    x: 0,
    y: 0,
    sortOrder: 0,
    sessionId: sid(id),
    cols: 80,
    rows: 24,
    alive: true,
    claudeSessionHistory: [],
    archivedChildren: [],
    ...rest,
    id: nid(id)
  } as TerminalNodeData
}

/** Records everything written, and whether the connection was closed. */
class FakeConnection implements ScriptConnection {
  readonly sent: Record<string, unknown>[] = []
  closed = false
  private disconnectHandlers: Array<() => void> = []

  send(message: unknown): void { this.sent.push(message as Record<string, unknown>) }
  close(): void { this.closed = true }
  onDisconnect(fn: () => void): void { this.disconnectHandlers.push(fn) }

  /** Simulate the script hanging up. */
  disconnect(): void { for (const fn of this.disconnectHandlers) fn() }

  get only(): Record<string, unknown> {
    if (this.sent.length !== 1) throw new Error(`expected 1 message, got ${this.sent.length}`)
    return this.sent[0]
  }
}

class FakeHost implements ScriptHost {
  readonly nodes = new Map<NodeId, NodeData>()
  readonly sessionToNode = new Map<PtySessionId, NodeId>()
  nearestAncestor: NodeId | undefined
  transcript: TranscriptLocation = { isFork: false }
  forkResult: Promise<NodeId> = Promise.resolve(nid('forked'))

  readonly shipped: Array<{ sessionId: PtySessionId; text: string; submit: boolean }> = []
  readonly unread: PtySessionId[] = []
  readonly forks: Array<[NodeId, NodeId]> = []
  readonly logs: string[] = []
  /** Mod envelopes the host was asked to relay to the Electron clients. */
  readonly emittedMods: Array<{ modId: string; event: string; payload: unknown }> = []

  emitMod(modId: string, event: string, payload: unknown): void {
    this.emittedMods.push({ modId, event, payload })
  }

  add(node: NodeData): this {
    this.nodes.set(node.id, node)
    if (node.type === 'terminal') this.sessionToNode.set(node.sessionId, node.id)
    return this
  }

  getNode(nodeId: NodeId): NodeData | undefined { return this.nodes.get(nodeId) }
  getNodeIdForSession(surfaceId: PtySessionId): NodeId | undefined { return this.sessionToNode.get(surfaceId) }
  getNearestTerminalAncestor(): NodeId | undefined { return this.nearestAncestor }
  shipIt(sessionId: PtySessionId, text: string, submit: boolean): void { this.shipped.push({ sessionId, text, submit }) }
  markUnread(sessionId: PtySessionId): void { this.unread.push(sessionId) }
  resolveTranscript(): TranscriptLocation { return this.transcript }
  forkClaude(sourceNodeId: NodeId, parentId: NodeId): Promise<NodeId> {
    this.forks.push([sourceNodeId, parentId])
    return this.forkResult
  }
  log(line: string): void { this.logs.push(line) }
}

function harness(configure: (h: FakeHost) => void = () => {}) {
  const host = new FakeHost()
  configure(host)
  const api = new ScriptApi(host)
  const conn = new FakeConnection()
  const send = (msg: ScriptMessage): void => api.handle(conn, msg)
  return { api, host, conn, send }
}

describe('script-hello', () => {
  it('reports the version range and the full event list', () => {
    const h = harness()
    h.send({ type: 'script-hello', seq: 1, protocolVersion: SCRIPT_PROTOCOL_VERSION })

    expect(h.conn.only).toMatchObject({
      type: 'script-hello-result',
      seq: 1,
      compatible: true,
      protocolVersion: SCRIPT_PROTOCOL_VERSION,
      minProtocolVersion: MIN_SCRIPT_PROTOCOL_VERSION,
      events: [...SCRIPT_EVENTS]
    })
  })

  it('advertises no error when compatible', () => {
    const h = harness()
    h.send({ type: 'script-hello', seq: 1, protocolVersion: SCRIPT_PROTOCOL_VERSION })
    expect(h.conn.only.error).toBeUndefined()
  })

  it('rejects a script written against a newer protocol', () => {
    const h = harness()
    h.send({ type: 'script-hello', seq: 1, protocolVersion: SCRIPT_PROTOCOL_VERSION + 1 })

    expect(h.conn.only).toMatchObject({ compatible: false })
    expect(h.conn.only.error).toMatch(new RegExp(`v${SCRIPT_PROTOCOL_VERSION + 1}`))
  })

  it('rejects one written against a version this build has dropped', () => {
    const h = harness()
    h.send({ type: 'script-hello', seq: 1, protocolVersion: MIN_SCRIPT_PROTOCOL_VERSION - 1 })
    expect(h.conn.only).toMatchObject({ compatible: false })
  })

  it('names the client in the log, so an incompatible mod is identifiable', () => {
    const h = harness()
    h.send({ type: 'script-hello', seq: 1, protocolVersion: 999, client: 'spaceterm-mcp/1.2.0' })
    expect(h.host.logs.join('\n')).toContain('spaceterm-mcp/1.2.0')
  })

  it('still answers a rejected script rather than hanging up on it', () => {
    // The whole point of the handshake is a loud failure; a dropped connection
    // is indistinguishable from a crashed server.
    const h = harness()
    h.send({ type: 'script-hello', seq: 1, protocolVersion: 999 })
    expect(h.conn.sent).toHaveLength(1)
    expect(h.conn.closed).toBe(true)
  })
})

describe('script-get-ancestors', () => {
  it('returns self first, then each ancestor outward', () => {
    const h = harness((host) => {
      host.add(terminal({ id: 'a' }))
      host.add(terminal({ id: 'b', parentId: nid('a') }))
      host.add(terminal({ id: 'c', parentId: nid('b') }))
    })
    h.send({ type: 'script-get-ancestors', seq: 1, nodeId: nid('c') })
    expect(h.conn.only.ancestors).toEqual(['c', 'b', 'a'])
  })

  it('stops at the root without including it', () => {
    const h = harness((host) => host.add(terminal({ id: 'a' })))
    h.send({ type: 'script-get-ancestors', seq: 1, nodeId: nid('a') })
    expect(h.conn.only.ancestors).toEqual(['a'])
  })

  it('stops at a dangling parent rather than reporting a partial chain as complete', () => {
    const h = harness((host) => host.add(terminal({ id: 'a', parentId: nid('ghost') })))
    h.send({ type: 'script-get-ancestors', seq: 1, nodeId: nid('a') })
    expect(h.conn.only.ancestors).toEqual(['a'])
  })

  it('terminates on a parent cycle instead of hanging the server', () => {
    // A script is not a trusted caller, and a corrupt state file is not
    // impossible; an infinite loop here would take the whole server down.
    const h = harness((host) => {
      host.add(terminal({ id: 'a', parentId: nid('b') }))
      host.add(terminal({ id: 'b', parentId: nid('a') }))
    })
    h.send({ type: 'script-get-ancestors', seq: 1, nodeId: nid('a') })
    expect(h.conn.only.ancestors).toEqual(['a', 'b'])
  })

  it('reports an unknown node distinctly from a node with no ancestors', () => {
    const h = harness()
    h.send({ type: 'script-get-ancestors', seq: 1, nodeId: nid('missing') })
    expect(h.conn.only).toMatchObject({ ancestors: [], error: 'unknown-node' })
  })
})

describe('script-get-node', () => {
  it('returns the node', () => {
    const h = harness((host) => host.add(terminal({ id: 'a', name: 'work' })))
    h.send({ type: 'script-get-node', seq: 1, nodeId: nid('a') })
    expect(h.conn.only.node).toMatchObject({ id: 'a', name: 'work' })
  })

  it('strips archived children, which can be unboundedly large', () => {
    const h = harness((host) =>
      host.add(terminal({ id: 'a', archivedChildren: [{ node: terminal({ id: 'old' }) }] as never }))
    )
    h.send({ type: 'script-get-node', seq: 1, nodeId: nid('a') })
    expect((h.conn.only.node as { archivedChildren: unknown[] }).archivedChildren).toEqual([])
  })

  it('does not mutate the stored node while stripping', () => {
    const archived = [{ node: terminal({ id: 'old' }) }] as never
    const h = harness((host) => host.add(terminal({ id: 'a', archivedChildren: archived })))
    h.send({ type: 'script-get-node', seq: 1, nodeId: nid('a') })
    expect((h.host.getNode(nid('a')) as TerminalNodeData).archivedChildren).toHaveLength(1)
  })

  it('errors on an unknown node', () => {
    const h = harness()
    h.send({ type: 'script-get-node', seq: 1, nodeId: nid('missing') })
    expect(h.conn.only).toMatchObject({ error: 'unknown-node' })
    expect(h.conn.only.node).toBeUndefined()
  })
})

describe('script-ship-it', () => {
  it('writes to the terminal and submits by default', () => {
    const h = harness((host) => host.add(terminal({ id: 'a' })))
    h.send({ type: 'script-ship-it', seq: 1, nodeId: nid('a'), data: 'hello' })

    expect(h.host.shipped).toEqual([{ sessionId: sid('a'), text: 'hello', submit: true }])
    expect(h.conn.only).toMatchObject({ ok: true })
  })

  it('honours submit:false', () => {
    const h = harness((host) => host.add(terminal({ id: 'a' })))
    h.send({ type: 'script-ship-it', seq: 1, nodeId: nid('a'), data: 'draft', submit: false })
    expect(h.host.shipped[0].submit).toBe(false)
  })

  it('translates newlines to carriage returns', () => {
    // A bare \n inside a bracketed paste submits the prompt early, truncating
    // a multi-line message at its first line.
    const h = harness((host) => host.add(terminal({ id: 'a' })))
    h.send({ type: 'script-ship-it', seq: 1, nodeId: nid('a'), data: 'one\ntwo\r\nthree' })
    expect(h.host.shipped[0].text).toBe('one\rtwo\rthree')
  })

  it('addresses the terminal by its session id, not its node id', () => {
    // They diverge after the first restart, and shipping to a stale pty is
    // silently lost input.
    const h = harness((host) => host.add(terminal({ id: 'a', sessionId: sid('pty-7') })))
    h.send({ type: 'script-ship-it', seq: 1, nodeId: nid('a'), data: 'x' })
    expect(h.host.shipped[0].sessionId).toBe('pty-7')
  })

  it('distinguishes its three failure modes', () => {
    // A script retries a not-yet-alive terminal; it does not retry a markdown
    // card. Collapsing these into one error would make that undecidable.
    const cases: Array<[string, NodeData | null, string]> = [
      ['unknown', null, 'unknown-node'],
      ['markdown', { type: 'markdown', id: nid('m'), parentId: ROOT_NODE_ID, x: 0, y: 0, sortOrder: 0, archivedChildren: [] } as unknown as NodeData, 'not-a-terminal'],
      ['dead', terminal({ id: 'd', alive: false }), 'terminal-not-alive']
    ]
    for (const [label, node, expected] of cases) {
      const h = harness((host) => { if (node) host.add(node) })
      h.send({ type: 'script-ship-it', seq: 1, nodeId: nid(node?.id ?? 'missing'), data: 'x' })
      expect(h.conn.only, label).toMatchObject({ ok: false, error: expected })
      expect(h.host.shipped, label).toEqual([])
    }
  })
})

describe('script-resolve-handoff', () => {
  it('resolves a pty surface id to its node, then reports the transcript and target', () => {
    const h = harness((host) => {
      host.add(terminal({ id: 'child', sessionId: sid('pty-1') }))
      host.add(terminal({ id: 'parent', name: 'Parent' }))
      host.nearestAncestor = nid('parent')
      host.transcript = { path: '/t/abc.jsonl', isFork: true }
    })
    h.send({ type: 'script-resolve-handoff', seq: 1, surfaceId: sid('pty-1') })

    expect(h.conn.only).toMatchObject({
      transcriptPath: '/t/abc.jsonl',
      isFork: true,
      targetSurface: { nodeId: 'parent', title: 'Parent', alive: true }
    })
  })

  it('reports a null target when there is no ancestor terminal to hand off to', () => {
    const h = harness((host) => {
      host.add(terminal({ id: 'a' }))
      host.nearestAncestor = undefined
    })
    h.send({ type: 'script-resolve-handoff', seq: 1, surfaceId: sid('a') })
    expect(h.conn.only.targetSurface).toBeNull()
  })

  it('reports a dead ancestor as a target, but marked dead', () => {
    // The handoff command needs to say "your parent has exited" rather than
    // pretend there is nobody there.
    const h = harness((host) => {
      host.add(terminal({ id: 'a' }))
      host.add(terminal({ id: 'p', alive: false }))
      host.nearestAncestor = nid('p')
    })
    h.send({ type: 'script-resolve-handoff', seq: 1, surfaceId: sid('a') })
    expect(h.conn.only.targetSurface).toMatchObject({ nodeId: 'p', alive: false })
  })

  it('normalises a missing title to null rather than omitting it', () => {
    const h = harness((host) => {
      host.add(terminal({ id: 'a' }))
      host.add(terminal({ id: 'p' }))
      host.nearestAncestor = nid('p')
    })
    h.send({ type: 'script-resolve-handoff', seq: 1, surfaceId: sid('a') })
    expect((h.conn.only.targetSurface as { title: unknown }).title).toBeNull()
  })

  it('errors when the surface id resolves to nothing', () => {
    const h = harness()
    h.send({ type: 'script-resolve-handoff', seq: 1, surfaceId: sid('gone') })
    expect(h.conn.only).toMatchObject({ error: 'not-a-terminal' })
  })

  it('reports no transcript path when none is on disk, without erroring', () => {
    // A brand-new surface has no transcript yet; that is not a failure.
    const h = harness((host) => {
      host.add(terminal({ id: 'a' }))
      host.transcript = { isFork: false }
    })
    h.send({ type: 'script-resolve-handoff', seq: 1, surfaceId: sid('a') })
    expect(h.conn.only.error).toBeUndefined()
    expect(h.conn.only.transcriptPath).toBeUndefined()
  })
})

describe('script-subscribe', () => {
  it('acks without closing — the connection is the event stream', () => {
    const h = harness()
    h.send({ type: 'script-subscribe', seq: 1 })

    expect(h.conn.only).toMatchObject({ type: 'script-subscribe-result', seq: 1, ok: true })
    expect(h.conn.closed).toBe(false)
  })

  it('receives broadcasts', () => {
    const h = harness()
    h.send({ type: 'script-subscribe', seq: 1 })
    h.api.broadcast('exit', nid('a'), { type: 'exit', nodeId: 'a' })

    expect(h.conn.sent[1]).toMatchObject({ type: 'exit', nodeId: 'a' })
  })

  it('filters by event type when asked', () => {
    const h = harness()
    h.send({ type: 'script-subscribe', seq: 1, events: ['exit'] })
    h.api.broadcast('node-added', nid('a'), { type: 'node-added' })
    h.api.broadcast('exit', nid('a'), { type: 'exit' })

    expect(h.conn.sent.slice(1)).toEqual([{ type: 'exit' }])
  })

  it('filters by node id when asked', () => {
    const h = harness()
    h.send({ type: 'script-subscribe', seq: 1, nodeIds: [nid('mine')] })
    h.api.broadcast('exit', nid('theirs'), { type: 'exit', nodeId: 'theirs' })
    h.api.broadcast('exit', nid('mine'), { type: 'exit', nodeId: 'mine' })

    expect(h.conn.sent.slice(1)).toEqual([{ type: 'exit', nodeId: 'mine' }])
  })

  it('delivers a node-less event to a node-filtered subscriber', () => {
    // Otherwise a subscriber watching one node would never hear about
    // server-wide events, which have no node to match against.
    const h = harness()
    h.send({ type: 'script-subscribe', seq: 1, nodeIds: [nid('mine')] })
    h.api.broadcast('exit', undefined, { type: 'exit' })
    expect(h.conn.sent).toHaveLength(2)
  })

  it('applies both filters together', () => {
    const h = harness()
    h.send({ type: 'script-subscribe', seq: 1, events: ['exit'], nodeIds: [nid('mine')] })
    h.api.broadcast('node-added', nid('mine'), { type: 'node-added' })
    h.api.broadcast('exit', nid('theirs'), { type: 'exit' })
    expect(h.conn.sent).toHaveLength(1)
  })

  it('unsubscribes on disconnect', () => {
    const h = harness()
    h.send({ type: 'script-subscribe', seq: 1 })
    expect(h.api.subscriberCount).toBe(1)

    h.conn.disconnect()
    expect(h.api.subscriberCount).toBe(0)

    h.api.broadcast('exit', nid('a'), { type: 'exit' })
    expect(h.conn.sent).toHaveLength(1)
  })

  it('serves several subscribers independently', () => {
    const host = new FakeHost()
    const api = new ScriptApi(host)
    const all = new FakeConnection()
    const exits = new FakeConnection()
    api.handle(all, { type: 'script-subscribe', seq: 1 })
    api.handle(exits, { type: 'script-subscribe', seq: 1, events: ['exit'] })

    api.broadcast('node-added', nid('a'), { type: 'node-added' })
    expect(all.sent).toHaveLength(2)
    expect(exits.sent).toHaveLength(1)
  })

  it('has no subscribers before anyone subscribes', () => {
    expect(new ScriptApi(new FakeHost()).subscriberCount).toBe(0)
  })
})

describe('script-fork-claude', () => {
  it('replies with the new node id once the fork settles', async () => {
    const h = harness((host) => { host.forkResult = Promise.resolve(nid('new')) })
    h.send({ type: 'script-fork-claude', seq: 1, nodeId: nid('src'), parentId: nid('parent') })
    await h.host.forkResult

    expect(h.host.forks).toEqual([[nid('src'), nid('parent')]])
    expect(h.conn.only).toMatchObject({ type: 'script-fork-claude-result', seq: 1, nodeId: 'new' })
    expect(h.conn.only.error).toBeUndefined()
  })

  it('reports the failure reason, with an empty node id', async () => {
    const h = harness((host) => { host.forkResult = Promise.reject(new Error('no session transcript file found on disk')) })
    h.send({ type: 'script-fork-claude', seq: 1, nodeId: nid('src'), parentId: nid('p') })
    await h.host.forkResult.catch(() => {})
    await Promise.resolve()

    expect(h.conn.only).toMatchObject({ nodeId: '', error: 'no session transcript file found on disk' })
  })

  it('does not reply before the fork settles', () => {
    // The caller uses the reply as "the terminal is ready to talk to"; an
    // early ack would have it ship a prompt into a replaying session.
    const h = harness((host) => { host.forkResult = new Promise(() => {}) })
    h.send({ type: 'script-fork-claude', seq: 1, nodeId: nid('src'), parentId: nid('p') })
    expect(h.conn.sent).toEqual([])
    expect(h.conn.closed).toBe(false)
  })

  it('survives a non-Error rejection', async () => {
    const h = harness((host) => { host.forkResult = Promise.reject('plain string') })
    h.send({ type: 'script-fork-claude', seq: 1, nodeId: nid('src'), parentId: nid('p') })
    await h.host.forkResult.catch(() => {})
    await Promise.resolve()
    expect(h.conn.only.error).toBe('plain string')
  })
})

describe('script-unread', () => {
  it('marks the terminal unread by session id', () => {
    const h = harness((host) => host.add(terminal({ id: 'a', sessionId: sid('pty-3') })))
    h.send({ type: 'script-unread', nodeId: nid('a') })
    expect(h.host.unread).toEqual([sid('pty-3')])
  })

  it('sends nothing back — it is fire-and-forget with no seq', () => {
    const h = harness((host) => host.add(terminal({ id: 'a' })))
    h.send({ type: 'script-unread', nodeId: nid('a') })
    expect(h.conn.sent).toEqual([])
  })

  it('no-ops on an unknown or non-terminal node', () => {
    const h = harness()
    h.send({ type: 'script-unread', nodeId: nid('missing') })
    expect(h.host.unread).toEqual([])
    expect(h.conn.sent).toEqual([])
  })
})

describe('an unknown message type', () => {
  it('is answered with an error rather than dropped', () => {
    const h = harness()
    h.send({ type: 'script-invent-a-command', seq: 1 } as unknown as ScriptMessage)

    expect(h.conn.only).toMatchObject({ type: 'error' })
    expect(h.conn.only.error).toContain('script-invent-a-command')
    expect(h.conn.closed).toBe(true)
  })

  it('is logged, so an out-of-date mod shows up in the server log', () => {
    const h = harness()
    h.send({ type: 'script-invent-a-command' } as unknown as ScriptMessage)
    expect(h.host.logs.join('\n')).toContain('script-invent-a-command')
  })
})

describe('broadcast with no subscribers', () => {
  it('is a no-op, not a crash', () => {
    const api = new ScriptApi(new FakeHost())
    expect(() => api.broadcast('exit', nid('a'), { type: 'exit' })).not.toThrow()
  })
})

/**
 * Mod envelopes on the scripts socket.
 *
 * The properties worth pinning are all about *isolation*: a mod's traffic must
 * reach the app and the mods that asked for it, and nothing else. Getting this
 * wrong is not a crash — it is every mod quietly seeing every other mod's
 * messages, which is the kind of thing an ecosystem comes to depend on by
 * accident and can then never be tightened.
 */
describe('script-mod-emit', () => {
  it('relays the envelope to the app', () => {
    const h = harness()
    h.send({ type: 'script-mod-emit', seq: 1, modId: 'summary-chat', event: 'status', payload: { a: 1 } })

    expect(h.host.emittedMods).toEqual([
      { modId: 'summary-chat', event: 'status', payload: { a: 1 } }
    ])
  })

  it('acknowledges with how many scripts it reached', () => {
    const h = harness()
    h.send({ type: 'script-mod-emit', seq: 7, modId: 'summary-chat', event: 'status', payload: null })
    // Zero listeners is normal, not an error: the renderer half may be the
    // only thing that cares.
    expect(h.conn.only).toMatchObject({ type: 'script-mod-emit-result', seq: 7, delivered: 0 })
  })

  it('delivers to a script that named the modId', () => {
    const h = harness()
    const listener = new FakeConnection()
    h.api.handle(listener, { type: 'script-subscribe', seq: 1, modIds: ['summary-chat'] })
    listener.sent.length = 0

    h.send({ type: 'script-mod-emit', seq: 2, modId: 'summary-chat', event: 'spoke', payload: { n: 3 } })

    expect(listener.sent).toEqual([
      { type: 'mod', modId: 'summary-chat', event: 'spoke', payload: { n: 3 } }
    ])
  })

  it('does not deliver another mod\'s traffic', () => {
    const h = harness()
    const listener = new FakeConnection()
    h.api.handle(listener, { type: 'script-subscribe', seq: 1, modIds: ['summary-chat'] })
    listener.sent.length = 0

    h.send({ type: 'script-mod-emit', seq: 2, modId: 'weather', event: 'tick', payload: null })

    expect(listener.sent).toEqual([])
  })

  it('does not treat "subscribe to all events" as "subscribe to all mods"', () => {
    // The wildcard is for spaceterm's own events. Mod traffic is opt-in by
    // name, so a script cannot come to depend on a mod it never declared.
    const h = harness()
    const listener = new FakeConnection()
    h.api.handle(listener, { type: 'script-subscribe', seq: 1 })
    listener.sent.length = 0

    h.send({ type: 'script-mod-emit', seq: 2, modId: 'summary-chat', event: 'spoke', payload: null })

    expect(listener.sent).toEqual([])
  })

  it('does not echo an envelope back to its sender', () => {
    const h = harness()
    // The emitter is itself subscribed to its own mod — a mod with several
    // processes would be.
    h.api.handle(h.conn, { type: 'script-subscribe', seq: 1, modIds: ['summary-chat'] })
    h.conn.sent.length = 0

    h.send({ type: 'script-mod-emit', seq: 2, modId: 'summary-chat', event: 'spoke', payload: null })

    const relayed = h.conn.sent.filter((m) => m.type === 'mod')
    expect(relayed).toEqual([])
  })

  it('stops delivering once the listener disconnects', () => {
    const h = harness()
    const listener = new FakeConnection()
    h.api.handle(listener, { type: 'script-subscribe', seq: 1, modIds: ['summary-chat'] })
    listener.disconnect()
    listener.sent.length = 0

    h.send({ type: 'script-mod-emit', seq: 2, modId: 'summary-chat', event: 'spoke', payload: null })

    expect(listener.sent).toEqual([])
  })
})
