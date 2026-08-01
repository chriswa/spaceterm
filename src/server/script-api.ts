import {
  SCRIPT_EVENTS,
  SCRIPT_PROTOCOL_VERSION,
  MIN_SCRIPT_PROTOCOL_VERSION,
  type ScriptEvent,
  type ScriptMessage,
  type ScriptResponse
} from '../shared/protocol'
import type { NodeData, TerminalNodeData } from '../shared/state'
import type { NodeId, PtySessionId } from '../shared/ids'
import { ROOT_NODE_ID } from '../shared/ids'
import { unhandledVariant } from '../shared/exhaustive'

/**
 * The scripts socket — which MODDING.md calls "already most of an extension
 * API".
 *
 * Everything a mod can do to Spaceterm passes through this file, so the set of
 * methods on `ScriptHost` below *is* the mod capability surface. Keeping it as
 * an explicit interface rather than a handful of module-level singletons makes
 * that surface something you can read in one screen, and something a test can
 * stand in for without a server.
 *
 * Two abstractions carry the weight:
 *
 * - `ScriptConnection` hides `net.Socket`. Request/response commands reply and
 *   hang up; `script-subscribe` keeps the connection open for streaming. A
 *   test supplies an object that records what was sent.
 * - `ScriptHost` is the privileged operations themselves. Anything that touches
 *   the filesystem, spawns a pty, or waits on a hook lives behind it, so this
 *   file is pure dispatch and can be tested exhaustively.
 */

/** One connected script. Abstracts `net.Socket` so this file never imports `net`. */
export interface ScriptConnection {
  /** Serialise and write one message. Must not throw on a dead connection. */
  send(message: ScriptResponse | Record<string, unknown>): void
  /** Half-close after the reply. A no-op on an already-closed connection. */
  close(): void
  /** Register a disconnect callback, for unsubscribing a streaming client. */
  onDisconnect(fn: () => void): void
}

/**
 * A terminal's newest on-disk transcript.
 *
 * `isFork` is true when the transcript carries `forkedFrom` markers, which
 * Claude stamps on every entry copied into a forked session — the handoff
 * command words its summary differently for a fork than for a fresh session.
 */
export interface TranscriptLocation {
  path?: string
  isFork: boolean
}

/**
 * Every privileged operation the script API can perform.
 *
 * Adding a method here widens what a mod can do; that is the point of it being
 * one list. Anything blocking or effectful returns a promise or takes a
 * callback, so this module never owns a timer.
 */
export interface ScriptHost {
  getNode(nodeId: NodeId): NodeData | undefined
  /** Resolve a pty-level SPACETERM_SURFACE_ID to the stable node id. */
  getNodeIdForSession(surfaceId: PtySessionId): NodeId | undefined
  /** Nearest ancestor that is a terminal, skipping title/markdown cards. */
  getNearestTerminalAncestor(nodeId: NodeId): NodeId | undefined
  /** Bracketed-paste `text` into a live terminal, submitting it unless told not to. */
  shipIt(sessionId: PtySessionId, text: string, submit: boolean): void
  markUnread(sessionId: PtySessionId): void
  /** Newest transcript on disk for this terminal, if any. Must not throw. */
  resolveTranscript(node: TerminalNodeData): TranscriptLocation
  /**
   * Fork a terminal's newest Claude session into a new terminal below
   * `parentId`, resolving with the new node id once the session has settled.
   * Rejects with a human-readable reason on any failure, including a timeout.
   */
  forkClaude(sourceNodeId: NodeId, parentId: NodeId): Promise<NodeId>
  log(line: string): void
}

interface ScriptSubscriber {
  connection: ScriptConnection
  /** null = every event. */
  events: Set<ScriptEvent> | null
  /** null = every node. */
  nodeIds: Set<NodeId> | null
}

export class ScriptApi {
  private readonly subscribers = new Set<ScriptSubscriber>()

  constructor(private readonly host: ScriptHost) {}

  /** Live streaming subscriptions. Exposed for the startup log and for tests. */
  get subscriberCount(): number {
    return this.subscribers.size
  }

  /**
   * Fan an event out to subscribed scripts.
   *
   * `eventType` is typed against SCRIPT_EVENTS rather than `string`, so
   * emitting an event the protocol does not document is a compile error — a
   * subscriber cannot discover events by reading source it does not have.
   */
  broadcast(eventType: ScriptEvent, nodeId: NodeId | undefined, message: Record<string, unknown>): void {
    for (const sub of this.subscribers) {
      if (sub.events && !sub.events.has(eventType)) continue
      if (sub.nodeIds && nodeId && !sub.nodeIds.has(nodeId)) continue
      sub.connection.send(message)
    }
  }

  handle(connection: ScriptConnection, msg: ScriptMessage): void {
    const reply = (response: ScriptResponse): void => {
      connection.send(response)
      connection.close()
    }

    switch (msg.type) {
      case 'script-hello': {
        const compatible =
          msg.protocolVersion >= MIN_SCRIPT_PROTOCOL_VERSION &&
          msg.protocolVersion <= SCRIPT_PROTOCOL_VERSION
        const range = `v${MIN_SCRIPT_PROTOCOL_VERSION}-v${SCRIPT_PROTOCOL_VERSION}`
        if (!compatible) {
          this.host.log(
            `[scripts] Rejected ${msg.client ?? 'unknown client'}: protocol v${msg.protocolVersion}, this build serves ${range}`
          )
        }
        reply({
          type: 'script-hello-result',
          seq: msg.seq,
          compatible,
          protocolVersion: SCRIPT_PROTOCOL_VERSION,
          minProtocolVersion: MIN_SCRIPT_PROTOCOL_VERSION,
          events: [...SCRIPT_EVENTS],
          ...(compatible ? {} : { error: `Protocol v${msg.protocolVersion} is not served by this build (${range})` })
        })
        return
      }

      case 'script-get-ancestors': {
        const node = this.host.getNode(msg.nodeId)
        if (!node) {
          reply({ type: 'script-get-ancestors-result', seq: msg.seq, ancestors: [], error: 'unknown-node' })
          return
        }
        reply({ type: 'script-get-ancestors-result', seq: msg.seq, ancestors: this.ancestorsOf(node) })
        return
      }

      case 'script-get-node': {
        const node = this.host.getNode(msg.nodeId)
        if (!node) {
          reply({ type: 'script-get-node-result', seq: msg.seq, error: 'unknown-node' })
          return
        }
        // Archived children can be arbitrarily large and are of no use to a
        // script; the protocol types the field as [] so this is not lossy.
        reply({ type: 'script-get-node-result', seq: msg.seq, node: { ...node, archivedChildren: [] } })
        return
      }

      case 'script-ship-it': {
        const terminal = this.requireLiveTerminal(msg.nodeId)
        if (typeof terminal === 'string') {
          reply({ type: 'script-ship-it-result', seq: msg.seq, ok: false, error: terminal })
          return
        }
        // A script sends "\n" for newlines; a terminal wants "\r", and a bare
        // "\n" inside a bracketed paste submits the prompt early.
        this.host.shipIt(terminal.sessionId, msg.data.replace(/\r?\n/g, '\r'), msg.submit !== false)
        reply({ type: 'script-ship-it-result', seq: msg.seq, ok: true })
        return
      }

      case 'script-resolve-handoff': {
        // The caller supplies its pty-level surface id; resolve it to the
        // stable node id, which survives the restarts that rebind a node to a
        // fresh pty.
        const nodeId = this.host.getNodeIdForSession(msg.surfaceId)
        const node = nodeId ? this.host.getNode(nodeId) : undefined
        if (!nodeId || !node || node.type !== 'terminal') {
          reply({ type: 'script-resolve-handoff-result', seq: msg.seq, error: 'not-a-terminal' })
          return
        }

        const { path: transcriptPath, isFork } = this.host.resolveTranscript(node)
        const targetId = this.host.getNearestTerminalAncestor(nodeId)
        const target = targetId ? this.host.getNode(targetId) : undefined
        reply({
          type: 'script-resolve-handoff-result',
          seq: msg.seq,
          transcriptPath,
          isFork,
          targetSurface: target && target.type === 'terminal'
            ? { nodeId: target.id, title: target.name ?? null, alive: target.alive }
            : null
        })
        return
      }

      case 'script-subscribe': {
        const sub: ScriptSubscriber = {
          connection,
          events: msg.events ? new Set(msg.events) : null,
          nodeIds: msg.nodeIds ? new Set(msg.nodeIds) : null
        }
        this.subscribers.add(sub)
        connection.onDisconnect(() => { this.subscribers.delete(sub) })
        // Ack, but do NOT close — the connection is the event stream.
        connection.send({ type: 'script-subscribe-result', seq: msg.seq, ok: true })
        return
      }

      case 'script-fork-claude': {
        this.host.forkClaude(msg.nodeId, msg.parentId).then(
          (nodeId) => reply({ type: 'script-fork-claude-result', seq: msg.seq, nodeId }),
          (err: unknown) => reply({
            type: 'script-fork-claude-result',
            seq: msg.seq,
            // The protocol types nodeId as required; empty string is the
            // established "no node" value on the error path.
            nodeId: '' as NodeId,
            error: err instanceof Error ? err.message : String(err)
          })
        )
        return
      }

      case 'script-unread': {
        // Fire-and-forget: no seq, no reply. Silently no-ops for a node that is
        // gone or was never a terminal.
        const node = this.host.getNode(msg.nodeId)
        if (node && node.type === 'terminal') this.host.markUnread(node.sessionId)
        return
      }

      default: {
        const unknownType = unhandledVariant(msg)
        this.host.log(`[scripts] Unknown message type: ${unknownType}`)
        connection.send({ type: 'error', error: `Unknown message type: ${unknownType}` })
        connection.close()
        return
      }
    }
  }

  /** [self, parent, grandparent, ...], stopping at the root or a broken link. */
  private ancestorsOf(node: NodeData): NodeId[] {
    const ancestors: NodeId[] = [node.id]
    // A parentId cycle would otherwise hang the server on a malformed state
    // file; a script is not a trusted enough caller to risk that. The starting
    // node is seeded so a cycle back through it stops there rather than listing
    // it as its own ancestor.
    const visited = new Set<NodeId>([node.id])
    let currentId = node.parentId
    while (currentId && currentId !== ROOT_NODE_ID && !visited.has(currentId)) {
      visited.add(currentId)
      const ancestor = this.host.getNode(currentId)
      if (!ancestor) break
      ancestors.push(ancestor.id)
      currentId = ancestor.parentId
    }
    return ancestors
  }

  /**
   * The terminal behind `nodeId`, or the protocol error string explaining why
   * there isn't one. The three failures are distinct on purpose: a script
   * shipping to a dead terminal wants a different retry than one shipping to a
   * markdown card.
   */
  private requireLiveTerminal(nodeId: NodeId): TerminalNodeData | 'unknown-node' | 'not-a-terminal' | 'terminal-not-alive' {
    const node = this.host.getNode(nodeId)
    if (!node) return 'unknown-node'
    if (node.type !== 'terminal') return 'not-a-terminal'
    if (!node.alive) return 'terminal-not-alive'
    return node
  }
}
