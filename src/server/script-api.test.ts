import { describe, it, expect } from 'vitest'
import { ScriptApi, type CardPosition, type ScriptConnection, type ScriptHost, type TranscriptLocation } from './script-api'
import { SCRIPT_EVENTS, SCRIPT_PROTOCOL_VERSION, MIN_SCRIPT_PROTOCOL_VERSION } from '../shared/protocol'
import type { ScriptMessage } from '../shared/protocol'
import type { ModCapability } from '../shared/mod-manifest'
import type { Located } from './location-broker'
import type { IncomingAutomationEvent } from './automation-event-log'
import type { AutomationPatch } from '../shared/automation'
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

/** Any non-terminal card, with only the fields these tests read. */
function card(type: 'markdown' | 'automation' | 'file' | 'title', id: string, overrides: Partial<NodeData> = {}): NodeData {
  return { type, id: nid(id), parentId: ROOT_NODE_ID, x: 0, y: 0, archivedChildren: [], ...overrides } as NodeData
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

  /** Manifests this fake knows about. Absent = unscoped, as on a real server. */
  readonly manifests = new Map<string, ModCapability[]>()

  capabilitiesFor(modId: string): readonly ModCapability[] | null {
    return this.manifests.get(modId) ?? null
  }

  add(node: NodeData): this {
    this.nodes.set(node.id, node)
    if (node.type === 'terminal') this.sessionToNode.set(node.sessionId, node.id)
    return this
  }

  readonly agentNames = new Map<NodeId, string>()

  getNode(nodeId: NodeId): NodeData | undefined { return this.nodes.get(nodeId) }
  getAgentName(nodeId: NodeId): string | undefined { return this.agentNames.get(nodeId) }
  getNodeIdForSession(surfaceId: PtySessionId): NodeId | undefined { return this.sessionToNode.get(surfaceId) }
  getNearestTerminalAncestor(): NodeId | undefined { return this.nearestAncestor }
  shipIt(sessionId: PtySessionId, text: string, submit: boolean): void { this.shipped.push({ sessionId, text, submit }) }
  markUnread(sessionId: PtySessionId): void { this.unread.push(sessionId) }
  resolveTranscript(): TranscriptLocation { return this.transcript }
  forkClaude(sourceNodeId: NodeId, parentId: NodeId): Promise<NodeId> {
    this.forks.push([sourceNodeId, parentId])
    return this.forkResult
  }
  /** Events fired at automation cards, and how many cards each matches. */
  readonly firedEvents: Array<{ eventId: string; payload: unknown }> = []
  listeners = 0
  disabledListeners = 0
  fireEvent(eventId: string, payload: unknown): { matched: number; disabled: number } {
    this.firedEvents.push({ eventId, payload })
    return { matched: this.listeners, disabled: this.disabledListeners }
  }
  readonly recordedEvents: IncomingAutomationEvent[] = []
  recordEvent(event: IncomingAutomationEvent): void {
    this.recordedEvents.push(event)
  }
  locateResult: Promise<Located> = new Promise(() => {})
  readonly locationAskers: string[] = []
  getLocation(askedBy: string): Promise<Located> {
    this.locationAskers.push(askedBy)
    return this.locateResult
  }
  readonly notifications: Array<{ nodeId: NodeId; body: string }> = []
  notifyUser(nodeId: NodeId, body: string): Promise<{ reached: boolean; outcome: string }> {
    this.notifications.push({ nodeId, body })
    return Promise.resolve({ reached: true, outcome: 'sent through Apple' })
  }
  /** Card writes, in the order the host was asked for them. */
  readonly cardWrites: Array<
    | { op: 'add-markdown'; parentId: NodeId; content: string; position: CardPosition | undefined }
    | { op: 'set-markdown'; nodeId: NodeId; content: string }
    | { op: 'add-automation'; parentId: NodeId; patch: AutomationPatch; position: CardPosition | undefined }
    | { op: 'update-automation'; nodeId: NodeId; patch: AutomationPatch }
    | { op: 'archive'; nodeId: NodeId }
    | { op: 'reparent'; nodeId: NodeId; newParentId: NodeId }
    | { op: 'move'; nodeId: NodeId; position: CardPosition }
  > = []
  addMarkdown(parentId: NodeId, content: string, position: CardPosition | undefined): NodeId {
    this.cardWrites.push({ op: 'add-markdown', parentId, content, position })
    return nid('new-markdown')
  }
  setMarkdown(nodeId: NodeId, content: string): void { this.cardWrites.push({ op: 'set-markdown', nodeId, content }) }
  addAutomation(parentId: NodeId, patch: AutomationPatch, position: CardPosition | undefined): NodeId {
    this.cardWrites.push({ op: 'add-automation', parentId, patch, position })
    return nid('new-automation')
  }
  updateAutomation(nodeId: NodeId, patch: AutomationPatch): void { this.cardWrites.push({ op: 'update-automation', nodeId, patch }) }
  /** What `archive` reports as the subtree's size. */
  archivedCount = 1
  archive(nodeId: NodeId): number {
    this.cardWrites.push({ op: 'archive', nodeId })
    return this.archivedCount
  }
  reparent(nodeId: NodeId, newParentId: NodeId): void { this.cardWrites.push({ op: 'reparent', nodeId, newParentId }) }
  move(nodeId: NodeId, position: CardPosition): void { this.cardWrites.push({ op: 'move', nodeId, position }) }
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
    expect(h.conn.only).not.toHaveProperty('agentName')
  })

  it("includes the agent's name when it has one", () => {
    const h = harness((host) => {
      host.add(terminal({ id: 'a' }))
      host.agentNames.set(nid('a'), 'Kevin')
    })
    h.send({ type: 'script-get-node', seq: 1, nodeId: nid('a') })
    expect(h.conn.only).toMatchObject({ agentName: 'Kevin', node: { id: 'a' } })
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

  it('hands the text over untouched — newline handling is ship-it.ts\'s', () => {
    const h = harness((host) => host.add(terminal({ id: 'a' })))
    h.send({ type: 'script-ship-it', seq: 1, nodeId: nid('a'), data: 'one\ntwo' })
    expect(h.host.shipped[0].text).toBe('one\ntwo')
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

describe('script-fire-event', () => {
  it('fires the event and reports how many automation cards heard it', () => {
    const h = harness((host) => { host.listeners = 2 })
    h.send({ type: 'script-fire-event', seq: 4, eventId: 'custom_linear', payload: { ticket: 'ENG-1' } })
    expect(h.host.firedEvents).toEqual([{ eventId: 'custom_linear', payload: { ticket: 'ENG-1' } }])
    expect(h.conn.only).toEqual({ type: 'script-fire-event-result', seq: 4, matched: 2 })
  })

  it('refuses an id without the custom_ prefix, rather than matching nothing', () => {
    const h = harness()
    h.send({ type: 'script-fire-event', seq: 1, eventId: 'linear' })
    expect(h.host.firedEvents).toEqual([])
    expect(h.conn.only).toMatchObject({ matched: 0, error: expect.stringContaining('custom_') })
  })

  it('refuses a payload too large to put on a command line', () => {
    const h = harness()
    h.send({ type: 'script-fire-event', seq: 1, eventId: 'custom_x', payload: 'x'.repeat(70_000) })
    expect(h.host.firedEvents).toEqual([])
    expect(h.conn.only.error).toContain('payload')
  })

  describe('the event log', () => {
    it('records a heard event with how many cards heard it', () => {
      const h = harness((host) => { host.listeners = 2 })
      h.send({ type: 'script-fire-event', seq: 1, eventId: 'custom_x', payload: { a: 1 } })
      expect(h.host.recordedEvents).toEqual([
        { eventId: 'custom_x', payload: { a: 1 }, source: undefined, outcome: { kind: 'fired', matched: 2 } }
      ])
    })

    it('records an event nothing was listening for, counting cards switched off', () => {
      const h = harness((host) => { host.disabledListeners = 1 })
      h.send({ type: 'script-fire-event', seq: 1, eventId: 'custom_typo' })
      expect(h.host.recordedEvents[0].outcome).toEqual({ kind: 'unheard', disabled: 1 })
    })

    it('records a malformed id and an oversized payload as rejected', () => {
      const h = harness()
      h.send({ type: 'script-fire-event', seq: 1, eventId: 'linear' })
      const big = harness()
      big.send({ type: 'script-fire-event', seq: 1, eventId: 'custom_x', payload: 'x'.repeat(70_000) })
      expect(h.host.recordedEvents[0]).toMatchObject({ eventId: 'linear', outcome: { kind: 'rejected', error: expect.stringContaining('custom_') } })
      expect(big.host.recordedEvents[0]).toMatchObject({ eventId: 'custom_x', outcome: { kind: 'rejected', error: expect.stringContaining('payload') } })
    })
  })
})

describe('script-get-location', () => {
  const fix = { latitude: 49.28, longitude: -123.12, accuracyMeters: 8, timestamp: 1000 }

  it('replies with the fix and the device it came from, naming the asking agent in the log', async () => {
    const h = harness((host) => {
      host.add(terminal({ id: 'a', sessionId: sid('pty-a') }))
      host.agentNames.set(nid('a'), 'Kevin')
      host.locateResult = Promise.resolve({ device: 'iPhone', fix })
    })
    h.send({ type: 'script-get-location', seq: 3, surfaceId: sid('pty-a') })
    await h.host.locateResult
    expect(h.host.locationAskers).toEqual(['Kevin'])
    expect(h.conn.only).toEqual({ type: 'script-get-location-result', seq: 3, location: { ...fix, device: 'iPhone' } })
    expect(h.conn.closed).toBe(true)
  })

  it('passes on why no device could answer', async () => {
    const h = harness((host) => { host.locateResult = Promise.reject(new Error('iPhone: denied')) })
    h.send({ type: 'script-get-location', seq: 1 })
    await h.host.locateResult.catch(() => {})
    await Promise.resolve()
    expect(h.host.locationAskers).toEqual(['a script'])
    expect(h.conn.only).toEqual({ type: 'script-get-location-result', seq: 1, error: 'iPhone: denied' })
  })
})

describe('script-notify', () => {
  it('notifies from the sending agent and passes on how it went', async () => {
    const h = harness((host) => host.add(terminal({ id: 'a', sessionId: sid('pty-a') })))
    h.send({ type: 'script-notify', seq: 2, surfaceId: sid('pty-a'), body: '  The build is green  ' })
    await Promise.resolve()
    await Promise.resolve()
    expect(h.host.notifications).toEqual([{ nodeId: nid('a'), body: 'The build is green' }])
    expect(h.conn.only).toEqual({ type: 'script-notify-result', seq: 2, reached: true, outcome: 'sent through Apple' })
  })

  it.each([
    ['with no surface', { body: 'hi' }],
    ['with an empty body', { surfaceId: sid('pty-a'), body: '   ' }],
  ])('refuses %s', (_, fields) => {
    const h = harness((host) => host.add(terminal({ id: 'a', sessionId: sid('pty-a') })))
    h.send({ type: 'script-notify', seq: 1, ...fields } as ScriptMessage)
    expect(h.host.notifications).toEqual([])
    expect(h.conn.only).toMatchObject({ type: 'script-notify-result', seq: 1, reached: false })
  })
})

describe('script-add-markdown', () => {
  it('creates the card under its parent and replies with its id', () => {
    const h = harness((host) => { host.add(terminal({ id: 'agent' })) })
    h.send({ type: 'script-add-markdown', seq: 3, parentId: nid('agent'), content: '# Plan' })
    expect(h.host.cardWrites).toEqual([{ op: 'add-markdown', parentId: nid('agent'), content: '# Plan', position: undefined }])
    expect(h.conn.only).toEqual({ type: 'script-add-markdown-result', seq: 3, nodeId: nid('new-markdown') })
    expect(h.conn.closed).toBe(true)
  })

  it('accepts the root as a parent', () => {
    const h = harness()
    h.send({ type: 'script-add-markdown', seq: 1, parentId: ROOT_NODE_ID, content: '' })
    expect(h.conn.only.nodeId).toBe(nid('new-markdown'))
  })

  it('passes an explicit position on', () => {
    const h = harness()
    h.send({ type: 'script-add-markdown', seq: 1, parentId: ROOT_NODE_ID, content: 'x', x: 10, y: -20 })
    expect(h.host.cardWrites[0]).toMatchObject({ position: { x: 10, y: -20 } })
  })

  it('refuses half a position rather than guessing the other coordinate', () => {
    const h = harness()
    h.send({ type: 'script-add-markdown', seq: 1, parentId: ROOT_NODE_ID, content: 'x', x: 10 })
    expect(h.host.cardWrites).toEqual([])
    expect(h.conn.only.error).toContain('x and y')
  })

  it('refuses a parent that is missing or a generated card', () => {
    const h = harness((host) => { host.add(card('markdown', 'meta', { ephemeral: true })) })
    h.send({ type: 'script-add-markdown', seq: 1, parentId: nid('gone'), content: 'x' })
    h.send({ type: 'script-add-markdown', seq: 2, parentId: nid('meta'), content: 'x' })
    expect(h.host.cardWrites).toEqual([])
    expect(h.conn.sent.map((m) => m.error)).toEqual(['unknown-node', 'generated-card'])
  })

  it("refuses a file parent, whose card shows the file instead of the content", () => {
    const h = harness((host) => { host.add(card('file', 'notes')) })
    h.send({ type: 'script-add-markdown', seq: 1, parentId: nid('notes'), content: 'x' })
    expect(h.host.cardWrites).toEqual([])
    expect(h.conn.only).toEqual({ type: 'script-add-markdown-result', seq: 1, error: 'parent-is-a-file' })
  })

  it('refuses content that is not a string', () => {
    const h = harness()
    h.send({ type: 'script-add-markdown', seq: 1, parentId: ROOT_NODE_ID, content: 42 } as unknown as ScriptMessage)
    expect(h.host.cardWrites).toEqual([])
    expect(h.conn.only.error).toContain('content')
  })
})

describe('script-set-markdown', () => {
  it("replaces the card's content", () => {
    const h = harness((host) => { host.add(card('markdown', 'md')) })
    h.send({ type: 'script-set-markdown', seq: 2, nodeId: nid('md'), content: 'new' })
    expect(h.host.cardWrites).toEqual([{ op: 'set-markdown', nodeId: nid('md'), content: 'new' }])
    expect(h.conn.only).toEqual({ type: 'script-set-markdown-result', seq: 2, ok: true })
  })

  it('distinguishes a missing node, the wrong kind of card, and a generated one', () => {
    const h = harness((host) => {
      host.add(card('title', 'heading'))
      host.add(card('markdown', 'meta', { ephemeral: true }))
    })
    for (const nodeId of ['gone', 'heading', 'meta']) {
      h.send({ type: 'script-set-markdown', seq: 1, nodeId: nid(nodeId), content: 'x' })
    }
    expect(h.host.cardWrites).toEqual([])
    expect(h.conn.sent.map((m) => [m.ok, m.error])).toEqual([
      [false, 'unknown-node'], [false, 'not-markdown'], [false, 'generated-card'],
    ])
  })
})

describe('script-add-automation', () => {
  it('creates the card and applies the patch fields given, and nothing else', () => {
    const h = harness()
    h.send({ type: 'script-add-automation', seq: 5, parentId: ROOT_NODE_ID, trigger: '0 9 * * 1-5', overlap: 'single', prompt: 'Triage' })
    expect(h.host.cardWrites).toEqual([{
      op: 'add-automation', parentId: ROOT_NODE_ID, position: undefined,
      patch: { trigger: '0 9 * * 1-5', overlap: 'single', prompt: 'Triage' },
    }])
    expect(h.conn.only).toEqual({ type: 'script-add-automation-result', seq: 5, nodeId: nid('new-automation') })
  })

  it("refuses a trigger that does not parse, with the parser's reason, and makes no card", () => {
    const h = harness()
    h.send({ type: 'script-add-automation', seq: 1, parentId: ROOT_NODE_ID, trigger: 'custom_has space' })
    expect(h.host.cardWrites).toEqual([])
    expect(h.conn.only.error).toBe('invalid trigger: event ids are custom_ followed by letters, digits, _ . : or -')
  })

  it('accepts an empty trigger, which is a card waiting to be given one', () => {
    const h = harness()
    h.send({ type: 'script-add-automation', seq: 1, parentId: ROOT_NODE_ID, trigger: '' })
    expect(h.conn.only.nodeId).toBe(nid('new-automation'))
  })

  it('refuses an unknown overlap and a missing parent', () => {
    const h = harness()
    h.send({ type: 'script-add-automation', seq: 1, parentId: ROOT_NODE_ID, overlap: 'sometimes' } as unknown as ScriptMessage)
    h.send({ type: 'script-add-automation', seq: 2, parentId: nid('gone') })
    expect(h.host.cardWrites).toEqual([])
    expect(h.conn.sent.map((m) => m.error)).toEqual(['unknown overlap sometimes', 'unknown-node'])
  })
})

describe('script-update-automation', () => {
  it('applies the patch', () => {
    const h = harness((host) => { host.add(card('automation', 'auto')) })
    h.send({ type: 'script-update-automation', seq: 7, nodeId: nid('auto'), trigger: 'custom_linear', enabled: true })
    expect(h.host.cardWrites).toEqual([{ op: 'update-automation', nodeId: nid('auto'), patch: { trigger: 'custom_linear', enabled: true } }])
    expect(h.conn.only).toEqual({ type: 'script-update-automation-result', seq: 7, ok: true })
  })

  it('refuses an invalid trigger and a non-boolean enabled, changing nothing', () => {
    const h = harness((host) => { host.add(card('automation', 'auto')) })
    h.send({ type: 'script-update-automation', seq: 1, nodeId: nid('auto'), trigger: '61 * * * *' })
    h.send({ type: 'script-update-automation', seq: 2, nodeId: nid('auto'), enabled: 'yes' } as unknown as ScriptMessage)
    expect(h.host.cardWrites).toEqual([])
    expect(h.conn.sent[0].error).toMatch(/^invalid trigger: /)
    expect(h.conn.sent[1].error).toBe('enabled must be a boolean')
  })

  it('refuses a node that is not an automation card', () => {
    const h = harness((host) => { host.add(card('markdown', 'md')) })
    h.send({ type: 'script-update-automation', seq: 1, nodeId: nid('md'), prompt: 'x' })
    expect(h.conn.only).toEqual({ type: 'script-update-automation-result', seq: 1, ok: false, error: 'not-an-automation' })
  })
})

describe('script-archive', () => {
  it('archives the node and reports how many nodes went with it', () => {
    const h = harness((host) => {
      host.add(card('markdown', 'md'))
      host.archivedCount = 3
    })
    h.send({ type: 'script-archive', seq: 4, nodeId: nid('md') })
    expect(h.host.cardWrites).toEqual([{ op: 'archive', nodeId: nid('md') }])
    expect(h.conn.only).toEqual({ type: 'script-archive-result', seq: 4, ok: true, archived: 3 })
  })

  it('refuses the root, a missing node, and a generated card', () => {
    const h = harness((host) => { host.add(card('markdown', 'meta', { ephemeral: true })) })
    for (const nodeId of [ROOT_NODE_ID, nid('gone'), nid('meta')]) {
      h.send({ type: 'script-archive', seq: 1, nodeId })
    }
    expect(h.host.cardWrites).toEqual([])
    expect(h.conn.sent.map((m) => [m.ok, m.error])).toEqual([
      [false, 'root'], [false, 'unknown-node'], [false, 'generated-card'],
    ])
  })
})

describe('script-reparent', () => {
  /** a at the top, b under a, c under b; x in another branch. */
  const tree = (host: FakeHost): void => {
    host.add(card('title', 'a'))
    host.add(card('markdown', 'b', { parentId: nid('a') }))
    host.add(card('markdown', 'c', { parentId: nid('b') }))
    host.add(card('markdown', 'x'))
  }

  it('moves the node under the new parent', () => {
    const h = harness(tree)
    h.send({ type: 'script-reparent', seq: 6, nodeId: nid('b'), newParentId: nid('x') })
    expect(h.host.cardWrites).toEqual([{ op: 'reparent', nodeId: nid('b'), newParentId: nid('x') }])
    expect(h.conn.only).toEqual({ type: 'script-reparent-result', seq: 6, ok: true })
  })

  it('accepts the root as the new parent', () => {
    const h = harness(tree)
    h.send({ type: 'script-reparent', seq: 1, nodeId: nid('c'), newParentId: ROOT_NODE_ID })
    expect(h.host.cardWrites).toEqual([{ op: 'reparent', nodeId: nid('c'), newParentId: ROOT_NODE_ID }])
  })

  it('refuses the node itself and anything beneath it, which would make a cycle', () => {
    // An immediate child too: the canvas swaps the two when a card is dropped
    // on its child, but a script asking for a reparent gets a reparent or nothing.
    const h = harness(tree)
    for (const target of ['a', 'b', 'c']) {
      h.send({ type: 'script-reparent', seq: 1, nodeId: nid('a'), newParentId: nid(target) })
    }
    expect(h.host.cardWrites).toEqual([])
    expect(h.conn.sent.map((m) => m.error)).toEqual(['would-create-cycle', 'would-create-cycle', 'would-create-cycle'])
  })

  it('answers ok without a write when the node is already under that parent', () => {
    const h = harness(tree)
    h.send({ type: 'script-reparent', seq: 1, nodeId: nid('c'), newParentId: nid('b') })
    expect(h.host.cardWrites).toEqual([])
    expect(h.conn.only.ok).toBe(true)
  })

  it('names which end is wrong: the node or the new parent', () => {
    const h = harness((host) => {
      tree(host)
      host.add(card('markdown', 'meta', { ephemeral: true }))
    })
    const cases: Array<[string, string]> = [
      ['gone', 'x'], ['meta', 'x'], ['root', 'x'], ['b', 'gone'], ['b', 'meta'],
    ]
    for (const [nodeId, newParentId] of cases) {
      h.send({ type: 'script-reparent', seq: 1, nodeId: nid(nodeId), newParentId: nid(newParentId) })
    }
    expect(h.host.cardWrites).toEqual([])
    expect(h.conn.sent.map((m) => m.error)).toEqual([
      'unknown-node', 'generated-card', 'root', 'unknown-parent', 'generated-parent',
    ])
  })
})

describe('script-move', () => {
  it("sets the card's position", () => {
    const h = harness((host) => { host.add(card('markdown', 'md')) })
    h.send({ type: 'script-move', seq: 8, nodeId: nid('md'), x: -120, y: 40.5 })
    expect(h.host.cardWrites).toEqual([{ op: 'move', nodeId: nid('md'), position: { x: -120, y: 40.5 } }])
    expect(h.conn.only).toEqual({ type: 'script-move-result', seq: 8, ok: true })
  })

  it('moves a generated card, whose owner remembers where it was put', () => {
    const h = harness((host) => { host.add(card('markdown', 'meta', { ephemeral: true })) })
    h.send({ type: 'script-move', seq: 1, nodeId: nid('meta'), x: 1, y: 2 })
    expect(h.conn.only.ok).toBe(true)
  })

  it('refuses a missing coordinate, a non-number, the root and a missing node', () => {
    const h = harness()
    h.send({ type: 'script-move', seq: 1, nodeId: nid('md'), x: 1 } as unknown as ScriptMessage)
    h.send({ type: 'script-move', seq: 2, nodeId: nid('md'), x: 1, y: Number.NaN })
    h.send({ type: 'script-move', seq: 3, nodeId: ROOT_NODE_ID, x: 1, y: 2 })
    h.send({ type: 'script-move', seq: 4, nodeId: nid('gone'), x: 1, y: 2 })
    expect(h.host.cardWrites).toEqual([])
    expect(h.conn.sent.map((m) => m.error)).toEqual([
      'x and y must both be given, as finite numbers',
      'x and y must both be given, as finite numbers',
      'root',
      'unknown-node',
    ])
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
    h.send({ type: 'script-mod-emit', seq: 1, modId: 'chatter', event: 'status', payload: { a: 1 } })

    expect(h.host.emittedMods).toEqual([
      { modId: 'chatter', event: 'status', payload: { a: 1 } }
    ])
  })

  it('acknowledges with how many scripts it reached', () => {
    const h = harness()
    h.send({ type: 'script-mod-emit', seq: 7, modId: 'chatter', event: 'status', payload: null })
    // Zero listeners is normal, not an error: the renderer half may be the
    // only thing that cares.
    expect(h.conn.only).toMatchObject({ type: 'script-mod-emit-result', seq: 7, delivered: 0 })
  })

  it('delivers to a script that named the modId', () => {
    const h = harness()
    const listener = new FakeConnection()
    h.api.handle(listener, { type: 'script-subscribe', seq: 1, modIds: ['chatter'] })
    listener.sent.length = 0

    h.send({ type: 'script-mod-emit', seq: 2, modId: 'chatter', event: 'spoke', payload: { n: 3 } })

    expect(listener.sent).toEqual([
      { type: 'mod', modId: 'chatter', event: 'spoke', payload: { n: 3 } }
    ])
  })

  it('does not deliver another mod\'s traffic', () => {
    const h = harness()
    const listener = new FakeConnection()
    h.api.handle(listener, { type: 'script-subscribe', seq: 1, modIds: ['chatter'] })
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

    h.send({ type: 'script-mod-emit', seq: 2, modId: 'chatter', event: 'spoke', payload: null })

    expect(listener.sent).toEqual([])
  })

  it('does not echo an envelope back to its sender', () => {
    const h = harness()
    // The emitter is itself subscribed to its own mod — a mod with several
    // processes would be.
    h.api.handle(h.conn, { type: 'script-subscribe', seq: 1, modIds: ['chatter'] })
    h.conn.sent.length = 0

    h.send({ type: 'script-mod-emit', seq: 2, modId: 'chatter', event: 'spoke', payload: null })

    const relayed = h.conn.sent.filter((m) => m.type === 'mod')
    expect(relayed).toEqual([])
  })

  it('stops delivering once the listener disconnects', () => {
    const h = harness()
    const listener = new FakeConnection()
    h.api.handle(listener, { type: 'script-subscribe', seq: 1, modIds: ['chatter'] })
    listener.disconnect()
    listener.sent.length = 0

    h.send({ type: 'script-mod-emit', seq: 2, modId: 'chatter', event: 'spoke', payload: null })

    expect(listener.sent).toEqual([])
  })
})

/**
 * Capability scoping.
 *
 * Not a sandbox — a mod runs as the user and could do anything the user can.
 * What this buys is blast radius and legibility: a mod cannot reach a
 * capability it never declared *by accident*, and the manifest is a readable
 * answer to "what does this thing do to my canvas".
 *
 * The migration shape matters as much as the enforcement: the nine existing
 * MCP tools declare nothing, so a connection that does not identify must keep
 * full access.
 */
describe('capability scoping', () => {
  const identify = (h: ReturnType<typeof harness>, modId: string) =>
    h.send({ type: 'script-hello', seq: 1, protocolVersion: SCRIPT_PROTOCOL_VERSION, modId })

  it('leaves a connection that never identified unscoped', () => {
    // The nine MCP tools. Scoping is opt-in so landing it breaks nothing.
    const h = harness((host) => { host.manifests.set('chatter', []) })
    h.send({ type: 'script-mod-emit', seq: 1, modId: 'chatter', event: 'e', payload: null })
    expect(h.host.emittedMods).toHaveLength(1)
  })

  it('leaves a mod with no manifest unscoped, and says so', () => {
    const h = harness()
    identify(h, 'in-development')
    h.conn.sent.length = 0

    h.send({ type: 'script-mod-emit', seq: 2, modId: 'in-development', event: 'e', payload: null })

    expect(h.host.emittedMods).toHaveLength(1)
    expect(h.host.logs.join('\n')).toContain('no manifest')
  })

  it('allows a capability the manifest declares', () => {
    const h = harness((host) => { host.manifests.set('chatter', ['emit-mod']) })
    identify(h, 'chatter')
    h.conn.sent.length = 0

    h.send({ type: 'script-mod-emit', seq: 2, modId: 'chatter', event: 'e', payload: null })

    expect(h.host.emittedMods).toHaveLength(1)
  })

  it('refuses one it does not, with the capability named', () => {
    const h = harness((host) => { host.manifests.set('chatter', ['read-nodes']) })
    identify(h, 'chatter')
    h.conn.sent.length = 0

    h.send({ type: 'script-mod-emit', seq: 2, modId: 'chatter', event: 'e', payload: null })

    expect(h.host.emittedMods).toEqual([])
    expect(h.conn.only).toMatchObject({ type: 'error' })
    // Naming the capability is the difference between a fixable message and a
    // mystery: the manifest edit is right there in the text.
    expect(String(h.conn.only.error)).toContain('emit-mod')
  })

  it('enters an event it refuses in the event log, naming the mod', () => {
    const h = harness((host) => { host.manifests.set('chatter', ['read-nodes']) })
    identify(h, 'chatter')

    h.send({ type: 'script-fire-event', seq: 2, eventId: 'custom_x', payload: 1 })

    expect(h.host.firedEvents).toEqual([])
    expect(h.host.recordedEvents).toEqual([{
      eventId: 'custom_x', payload: 1, source: 'chatter',
      outcome: { kind: 'rejected', error: expect.stringContaining('fire-events') }
    }])
  })

  it('gates every card write on write-nodes', () => {
    const h = harness((host) => {
      host.manifests.set('reader', ['read-nodes'])
      host.add(card('markdown', 'md'))
      host.add(card('automation', 'auto'))
    })
    const writes: ScriptMessage[] = [
      { type: 'script-add-markdown', seq: 2, parentId: ROOT_NODE_ID, content: 'x' },
      { type: 'script-set-markdown', seq: 3, nodeId: nid('md'), content: 'x' },
      { type: 'script-add-automation', seq: 4, parentId: ROOT_NODE_ID },
      { type: 'script-update-automation', seq: 5, nodeId: nid('auto'), enabled: true },
    ]
    for (const msg of writes) {
      const conn = new FakeConnection()
      h.api.handle(conn, { type: 'script-hello', seq: 1, protocolVersion: SCRIPT_PROTOCOL_VERSION, modId: 'reader' })
      conn.sent.length = 0
      h.api.handle(conn, msg)
      expect(conn.only).toMatchObject({ type: 'error', error: expect.stringContaining('write-nodes') })
    }
    expect(h.host.cardWrites).toEqual([])
  })

  it('gates reparent and move on write-nodes, and archive on archive-nodes alone', () => {
    const h = harness((host) => {
      host.manifests.set('writer', ['write-nodes'])
      host.manifests.set('archiver', ['archive-nodes'])
      host.add(card('markdown', 'md'))
    })
    const ask = (modId: string, msg: ScriptMessage): Record<string, unknown> => {
      const conn = new FakeConnection()
      h.api.handle(conn, { type: 'script-hello', seq: 1, protocolVersion: SCRIPT_PROTOCOL_VERSION, modId })
      conn.sent.length = 0
      h.api.handle(conn, msg)
      return conn.only
    }
    const archive: ScriptMessage = { type: 'script-archive', seq: 2, nodeId: nid('md') }
    const reparent: ScriptMessage = { type: 'script-reparent', seq: 3, nodeId: nid('md'), newParentId: ROOT_NODE_ID }
    const move: ScriptMessage = { type: 'script-move', seq: 4, nodeId: nid('md'), x: 0, y: 0 }

    expect(ask('writer', archive)).toMatchObject({ type: 'error', error: expect.stringContaining('archive-nodes') })
    expect(ask('archiver', reparent)).toMatchObject({ type: 'error', error: expect.stringContaining('write-nodes') })
    expect(ask('archiver', move)).toMatchObject({ type: 'error', error: expect.stringContaining('write-nodes') })
    expect(h.host.cardWrites).toEqual([])

    expect(ask('archiver', archive)).toMatchObject({ type: 'script-archive-result', ok: true })
    expect(ask('writer', move)).toMatchObject({ type: 'script-move-result', ok: true })
  })

  it('never refuses the handshake itself', () => {
    // Otherwise a mod with an empty capability list could not even identify,
    // and would be told so by a message it could not receive.
    const h = harness((host) => { host.manifests.set('locked-down', []) })
    identify(h, 'locked-down')
    expect(h.conn.only).toMatchObject({ type: 'script-hello-result', compatible: true })
  })

  it('scopes each capability independently', () => {
    const h = harness((host) => { host.manifests.set('reader', ['read-nodes']) })
    const node = terminal({ id: 'a' })
    h.host.add(node)
    identify(h, 'reader')
    h.conn.sent.length = 0

    h.send({ type: 'script-get-node', seq: 2, nodeId: node.id })
    expect(h.conn.only).toMatchObject({ type: 'script-get-node-result' })

    const second = new FakeConnection()
    h.api.handle(second, { type: 'script-hello', seq: 1, protocolVersion: SCRIPT_PROTOCOL_VERSION, modId: 'reader' })
    second.sent.length = 0
    h.api.handle(second, { type: 'script-unread', nodeId: node.id })
    expect(h.host.unread).toEqual([])
  })
})
