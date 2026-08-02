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
import { ancestorsOf } from '../shared/node-ancestry'
import { unhandledVariant } from '../shared/exhaustive'
import { checkProtocolVersion } from '../shared/protocol-handshake'
import type { ModCapability } from '../shared/mod-manifest'

/** What this build serves on the scripts socket. */
const SCRIPT_PROTOCOL_RANGE = { min: MIN_SCRIPT_PROTOCOL_VERSION, current: SCRIPT_PROTOCOL_VERSION }

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
/**
 * What a connection has told us about itself, from `script-hello`.
 *
 * A connection that never identified is `null`, which means the nine existing
 * MCP tools — none of which send a modId — keep working untouched. That is
 * deliberate: capability scoping tightens opt-in, so adopting it is a mod
 * declaring a manifest rather than everything breaking on the day it lands.
 */
interface ConnectionIdentity {
  modId: string
  capabilities: ReadonlySet<ModCapability>
}

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
  /**
   * Relay one mod envelope to every connected client.
   *
   * Deliberately the whole of a mod's reach into the app: the host does not
   * offer "send this specific message", because that would mean the base
   * knowing what a mod's messages are. See `ModMessage` in the protocol.
   */
  emitMod(modId: string, event: string, payload: unknown): void
  /**
   * What the named mod's manifest grants, or `null` if there is no manifest
   * for it. `null` means unscoped — see `ConnectionIdentity`.
   */
  capabilitiesFor(modId: string): readonly ModCapability[] | null
  log(line: string): void
}

/**
 * The capability each message needs, as a total map over `ScriptMessage`.
 *
 * Total on purpose: adding a message type without deciding what it costs is a
 * compile error here, rather than a new capability that everyone silently has.
 * `null` means "needs nothing" — the handshake, and anything that only reads
 * back what the caller already told us.
 */
const REQUIRED_CAPABILITY: { readonly [T in ScriptMessage['type']]: ModCapability | null } = {
  'script-hello': null,
  'script-mod-emit': 'emit-mod',
  'script-subscribe': 'subscribe-events',
  'script-get-node': 'read-nodes',
  'script-get-ancestors': 'read-nodes',
  'script-resolve-handoff': 'read-transcript',
  'script-ship-it': 'write-terminal',
  'script-unread': 'mark-unread',
  'script-fork-claude': 'fork-session',
}

interface ScriptSubscriber {
  connection: ScriptConnection
  /** null = every event. */
  events: Set<ScriptEvent> | null
  /** null = every node. */
  nodeIds: Set<NodeId> | null
  /**
   * Mod envelopes this subscriber asked for, by `modId`. Empty = none.
   *
   * Not nullable, unlike the two above: "omit for all" is right for spaceterm's
   * own events and wrong for mod traffic, where the default has to be that a
   * mod hears only itself.
   */
  modIds: Set<string>
}

export class ScriptApi {
  private readonly subscribers = new Set<ScriptSubscriber>()
  /** Identity per connection, learned at `script-hello`. */
  private readonly identities = new Map<ScriptConnection, ConnectionIdentity>()

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

  /**
   * Fan one mod envelope out to the scripts that named its `modId`.
   *
   * Returns the number reached, which the emitting mod gets back as an ack.
   * Zero is normal — a mod whose renderer half is the only listener talks to
   * no scripts at all — so it is a count, not an error.
   */
  broadcastMod(modId: string, event: string, payload: unknown, exclude?: ScriptConnection): number {
    let delivered = 0
    for (const sub of this.subscribers) {
      if (sub.connection === exclude) continue
      if (!sub.modIds.has(modId)) continue
      sub.connection.send({ type: 'mod', modId, event, payload })
      delivered++
    }
    return delivered
  }

  handle(connection: ScriptConnection, msg: ScriptMessage): void {
    const reply = (response: ScriptResponse): void => {
      connection.send(response)
      connection.close()
    }

    // Checked once, here, rather than inside each case: a capability that has
    // to be remembered at nine call sites is one that will be forgotten at the
    // tenth.
    const required = REQUIRED_CAPABILITY[msg.type]
    const identity = this.identities.get(connection)
    if (required !== null && identity && !identity.capabilities.has(required)) {
      this.host.log(`[scripts] ${identity.modId} refused ${msg.type}: manifest does not declare "${required}"`)
      connection.send({
        type: 'error',
        error: `mod "${identity.modId}" did not declare the "${required}" capability`,
      })
      connection.close()
      return
    }

    switch (msg.type) {
      case 'script-hello': {
        const { compatible, error } = checkProtocolVersion(msg.protocolVersion, SCRIPT_PROTOCOL_RANGE)
        if (!compatible) {
          this.host.log(`[scripts] Rejected ${msg.client ?? 'unknown client'}: ${error}`)
        }
        if (msg.modId !== undefined) {
          const granted = this.host.capabilitiesFor(msg.modId)
          if (granted === null) {
            // A mod naming itself with no manifest on disk. Unscoped, because
            // refusing would break a mod mid-development, but said out loud.
            this.host.log(`[scripts] ${msg.modId} has no manifest; running unscoped`)
          } else {
            this.identities.set(connection, { modId: msg.modId, capabilities: new Set(granted) })
            connection.onDisconnect(() => { this.identities.delete(connection) })
          }
        }
        reply({
          type: 'script-hello-result',
          seq: msg.seq,
          compatible,
          protocolVersion: SCRIPT_PROTOCOL_VERSION,
          minProtocolVersion: MIN_SCRIPT_PROTOCOL_VERSION,
          events: [...SCRIPT_EVENTS],
          ...(compatible ? {} : { error })
        })
        return
      }

      case 'script-get-ancestors': {
        const node = this.host.getNode(msg.nodeId)
        if (!node) {
          reply({ type: 'script-get-ancestors-result', seq: msg.seq, ancestors: [], error: 'unknown-node' })
          return
        }
        reply({ type: 'script-get-ancestors-result', seq: msg.seq, ancestors: this.chainFrom(node) })
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
          nodeIds: msg.nodeIds ? new Set(msg.nodeIds) : null,
          modIds: new Set(msg.modIds ?? [])
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

      case 'script-mod-emit': {
        // Out to the renderer halves, and to any *other* mod that asked to
        // watch this one. The emitting connection is excluded so a mod does
        // not receive its own echo.
        this.host.emitMod(msg.modId, msg.event, msg.payload)
        const delivered = this.broadcastMod(msg.modId, msg.event, msg.payload, connection)
        reply({ type: 'script-mod-emit-result', seq: msg.seq, delivered })
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

  /**
   * [self, parent, grandparent, ...], stopping at the root or a broken link.
   *
   * The shared walk is cycle-guarded, which matters more here than anywhere
   * else: a script is not a trusted caller, and an unguarded walk on a
   * malformed graph hangs the server rather than returning a wrong answer.
   */
  private chainFrom(node: NodeData): NodeId[] {
    return [
      node.id,
      ...[...ancestorsOf((id) => this.host.getNode(id), node.id)].map((n) => n.id)
    ]
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
