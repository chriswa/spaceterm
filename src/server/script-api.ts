import {
  SCRIPT_EVENTS,
  SCRIPT_PROTOCOL_VERSION,
  MIN_SCRIPT_PROTOCOL_VERSION,
  type ScriptCardPosition,
  type ScriptEvent,
  type ScriptMessage,
  type ScriptResponse
} from '../shared/protocol'
import type { NodeData, TerminalNodeData } from '../shared/state'
import { ROOT_NODE_ID, type NodeId, type PtySessionId } from '../shared/ids'
import { ancestorsOf, wouldCreateCycle } from '../shared/node-ancestry'
import { unhandledVariant } from '../shared/exhaustive'
import { checkProtocolVersion } from '../shared/protocol-handshake'
import type { ModCapability } from '../shared/mod-manifest'
import type { Located } from './location-broker'
import {
  CUSTOM_EVENT_PREFIX, MAX_EVENT_PAYLOAD_BYTES, isCustomEventId, parseAutomationPatch, parseTrigger,
  type AutomationPatch,
} from '../shared/automation'
import type { IncomingAutomationEvent } from './automation-event-log'

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

export interface CardPosition {
  x: number
  y: number
}

export interface ScriptHost {
  getNode(nodeId: NodeId): NodeData | undefined
  /** The surface's agent name, if it has one. Must never assign one. */
  getAgentName(nodeId: NodeId): string | undefined
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
  /**
   * The user's position, read on the client device they are most likely
   * holding. Rejects with a reason worded for the user. `askedBy` names the
   * caller for the log.
   */
  getLocation(askedBy: string): Promise<Located>
  /**
   * Raise a notification on the user's phone, from that agent: its title is
   * the notification's, and tapping it opens its terminal. Never rejects:
   * resolves to how it went, worded for the agent.
   */
  notifyUser(nodeId: NodeId, body: string): Promise<{ reached: boolean; outcome: string }>
  /**
   * Fire a custom event at every automation card listening for it. Returns how
   * many were, and how many more would have been had they not been switched off.
   */
  fireEvent(eventId: string, payload: unknown): { matched: number; disabled: number }
  /** Enter an event in the event log. Called once for every `script-fire-event`, whatever became of it. */
  recordEvent(event: IncomingAutomationEvent): void

  // Card writes. Arguments arrive validated. None of these counts as the user
  // interacting with the card: the agent wrote it, not them.

  /**
   * Create a markdown card under `parentId` holding `content`, at `position`
   * or, without one, the usual spot below the parent. Returns its id.
   */
  addMarkdown(parentId: NodeId, content: string, position: CardPosition | undefined): NodeId
  /** Replace a markdown card's content, writing the file a file-backed card mirrors. */
  setMarkdown(nodeId: NodeId, content: string): void
  /** Create an automation card under `parentId`, placed as `addMarkdown` places one, then apply `patch`. Returns its id. */
  addAutomation(parentId: NodeId, patch: AutomationPatch, position: CardPosition | undefined): NodeId
  /** Apply a patch to an automation card, as the card's own edits are applied. */
  updateAutomation(nodeId: NodeId, patch: AutomationPatch): void
  /**
   * Archive a node and its subtree as the card's archive button does, shutting
   * down every terminal in it. Returns how many nodes left the canvas.
   */
  archive(nodeId: NodeId): number
  /**
   * Put a node under `newParentId` as dragging it onto a card does. The parent
   * arrives checked: it exists and would not make a cycle.
   */
  reparent(nodeId: NodeId, newParentId: NodeId): void
  /** Set one card's position. */
  move(nodeId: NodeId, position: CardPosition): void
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
  'script-fire-event': 'fire-events',
  'script-get-location': 'read-location',
  'script-notify': 'notify-user',
  'script-add-markdown': 'write-nodes',
  'script-set-markdown': 'write-nodes',
  'script-add-automation': 'write-nodes',
  'script-update-automation': 'write-nodes',
  'script-reparent': 'write-nodes',
  'script-move': 'write-nodes',
  'script-archive': 'archive-nodes',
}

/** Why a script's event cannot be fired, or undefined when it can. */
function fireEventError(eventId: unknown, payload: unknown): string | undefined {
  if (typeof eventId !== 'string' || !isCustomEventId(eventId)) {
    return `event ids look like ${CUSTOM_EVENT_PREFIX}name (letters, digits, _ . : or -), got ${JSON.stringify(eventId)}`
  }
  if (payload !== undefined && JSON.stringify(payload).length > MAX_EVENT_PAYLOAD_BYTES) {
    return `payload is larger than ${MAX_EVENT_PAYLOAD_BYTES} bytes of JSON`
  }
  return undefined
}

/** A script's card position: both coordinates, neither, or why it is unusable. */
function readPosition(msg: ScriptCardPosition): { ok: true; position: CardPosition | undefined } | { ok: false; error: string } {
  const { x, y } = msg
  if (x === undefined && y === undefined) return { ok: true, position: undefined }
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) {
    return { ok: false, error: 'x and y must both be given, as finite numbers' }
  }
  return { ok: true, position: { x, y } }
}

/**
 * An automation patch from a script. Stricter than the card's own path on one
 * point: the card stores a trigger as it is typed, half-finished or not, but a
 * script's trigger is its final answer, so one that does not parse is refused.
 */
function readScriptAutomationPatch(msg: Parameters<typeof parseAutomationPatch>[0]): ReturnType<typeof parseAutomationPatch> {
  const parsed = parseAutomationPatch(msg)
  if (!parsed.ok || parsed.patch.trigger === undefined) return parsed
  const trigger = parseTrigger(parsed.patch.trigger)
  return trigger.kind === 'invalid' ? { ok: false, error: `invalid trigger: ${trigger.error}` } : parsed
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
      const error = `mod "${identity.modId}" did not declare the "${required}" capability`
      if (msg.type === 'script-fire-event') {
        this.host.recordEvent({ eventId: msg.eventId, payload: msg.payload, source: identity.modId, outcome: { kind: 'rejected', error } })
      }
      connection.send({ type: 'error', error })
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
        const agentName = this.host.getAgentName(node.id)
        reply({
          type: 'script-get-node-result',
          seq: msg.seq,
          node: { ...node, archivedChildren: [] },
          ...(agentName ? { agentName } : {}),
        })
        return
      }

      case 'script-ship-it': {
        const terminal = this.requireLiveTerminal(msg.nodeId)
        if (typeof terminal === 'string') {
          reply({ type: 'script-ship-it-result', seq: msg.seq, ok: false, error: terminal })
          return
        }
        this.host.shipIt(terminal.sessionId, msg.data, msg.submit !== false)
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

      case 'script-fire-event': {
        const { eventId, payload } = msg
        const source = identity?.modId
        const error = fireEventError(eventId, payload)
        if (error) {
          this.host.recordEvent({ eventId, payload, source, outcome: { kind: 'rejected', error } })
          reply({ type: 'script-fire-event-result', seq: msg.seq, matched: 0, error })
          return
        }
        const { matched, disabled } = this.host.fireEvent(eventId, payload)
        this.host.recordEvent({
          eventId, payload, source,
          outcome: matched > 0 ? { kind: 'fired', matched } : { kind: 'unheard', disabled }
        })
        reply({ type: 'script-fire-event-result', seq: msg.seq, matched })
        return
      }

      case 'script-get-location': {
        const nodeId = msg.surfaceId ? this.host.getNodeIdForSession(msg.surfaceId) : undefined
        const askedBy = (nodeId && this.host.getAgentName(nodeId)) ?? (nodeId ? `surface ${nodeId.slice(0, 8)}` : 'a script')
        this.host.getLocation(askedBy).then(
          ({ device, fix }) => reply({ type: 'script-get-location-result', seq: msg.seq, location: { ...fix, device } }),
          (err: unknown) => reply({ type: 'script-get-location-result', seq: msg.seq, error: err instanceof Error ? err.message : String(err) })
        )
        return
      }

      case 'script-notify': {
        const body = typeof msg.body === 'string' ? msg.body.trim() : ''
        if (!body) {
          reply({ type: 'script-notify-result', seq: msg.seq, reached: false, outcome: 'nothing to say: the body is empty' })
          return
        }
        const nodeId = msg.surfaceId ? this.host.getNodeIdForSession(msg.surfaceId) : undefined
        if (!nodeId) {
          reply({ type: 'script-notify-result', seq: msg.seq, reached: false, outcome: 'only an agent in a Spaceterm surface can send one: no surface is known by that id' })
          return
        }
        void this.host.notifyUser(nodeId, body).then(({ reached, outcome }) => reply({ type: 'script-notify-result', seq: msg.seq, reached, outcome }))
        return
      }

      case 'script-add-markdown': {
        const fail = (error: string): void => reply({ type: 'script-add-markdown-result', seq: msg.seq, error })
        const where = readPosition(msg)
        if (!where.ok) return fail(where.error)
        if (typeof msg.content !== 'string') return fail('content must be a string')
        const parentError = this.parentError(msg.parentId)
        if (parentError) return fail(parentError)
        // The card under a file node shows that file, which would replace the
        // content given here; an agent wanting it changed writes the file.
        if (this.host.getNode(msg.parentId)?.type === 'file') return fail('parent-is-a-file')
        reply({ type: 'script-add-markdown-result', seq: msg.seq, nodeId: this.host.addMarkdown(msg.parentId, msg.content, where.position) })
        return
      }

      case 'script-set-markdown': {
        const fail = (error: string): void => reply({ type: 'script-set-markdown-result', seq: msg.seq, ok: false, error })
        if (typeof msg.content !== 'string') return fail('content must be a string')
        const nodeError = this.editableError(msg.nodeId, 'markdown')
        if (nodeError) return fail(nodeError)
        this.host.setMarkdown(msg.nodeId, msg.content)
        reply({ type: 'script-set-markdown-result', seq: msg.seq, ok: true })
        return
      }

      case 'script-add-automation': {
        const fail = (error: string): void => reply({ type: 'script-add-automation-result', seq: msg.seq, error })
        const where = readPosition(msg)
        if (!where.ok) return fail(where.error)
        const parsed = readScriptAutomationPatch(msg)
        if (!parsed.ok) return fail(parsed.error)
        const parentError = this.parentError(msg.parentId)
        if (parentError) return fail(parentError)
        reply({ type: 'script-add-automation-result', seq: msg.seq, nodeId: this.host.addAutomation(msg.parentId, parsed.patch, where.position) })
        return
      }

      case 'script-update-automation': {
        const fail = (error: string): void => reply({ type: 'script-update-automation-result', seq: msg.seq, ok: false, error })
        const parsed = readScriptAutomationPatch(msg)
        if (!parsed.ok) return fail(parsed.error)
        const nodeError = this.editableError(msg.nodeId, 'automation')
        if (nodeError) return fail(nodeError)
        this.host.updateAutomation(msg.nodeId, parsed.patch)
        reply({ type: 'script-update-automation-result', seq: msg.seq, ok: true })
        return
      }

      case 'script-archive': {
        const fail = (error: string): void => reply({ type: 'script-archive-result', seq: msg.seq, ok: false, error })
        const nodeError = this.movableError(msg.nodeId)
        if (nodeError) return fail(nodeError)
        reply({ type: 'script-archive-result', seq: msg.seq, ok: true, archived: this.host.archive(msg.nodeId) })
        return
      }

      case 'script-reparent': {
        const fail = (error: string): void => reply({ type: 'script-reparent-result', seq: msg.seq, ok: false, error })
        const nodeError = this.movableError(msg.nodeId)
        if (nodeError) return fail(nodeError)
        const parentError = this.parentError(msg.newParentId)
        if (parentError) return fail(parentError === 'unknown-node' ? 'unknown-parent' : 'generated-parent')
        if (wouldCreateCycle((id) => this.host.getNode(id), msg.nodeId, msg.newParentId)) return fail('would-create-cycle')
        // Already there: nothing to do, as when a card is dropped on its own parent.
        if (this.host.getNode(msg.nodeId)?.parentId !== msg.newParentId) this.host.reparent(msg.nodeId, msg.newParentId)
        reply({ type: 'script-reparent-result', seq: msg.seq, ok: true })
        return
      }

      case 'script-move': {
        const fail = (error: string): void => reply({ type: 'script-move-result', seq: msg.seq, ok: false, error })
        const where = readPosition(msg)
        if (!where.ok) return fail(where.error)
        if (!where.position) return fail('x and y must both be given, as finite numbers')
        if (msg.nodeId === ROOT_NODE_ID) return fail('root')
        // A generated card may move: its owner remembers where it was put.
        if (!this.host.getNode(msg.nodeId)) return fail('unknown-node')
        this.host.move(msg.nodeId, where.position)
        reply({ type: 'script-move-result', seq: msg.seq, ok: true })
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
   * Why a script cannot put a card under `parentId`, or undefined when it can.
   * A generated card is refused as a parent because it is not persisted, so a
   * child under it would be left dangling after a restart.
   */
  private parentError(parentId: NodeId): 'unknown-node' | 'generated-card' | undefined {
    if (parentId === ROOT_NODE_ID) return undefined
    const parent = this.host.getNode(parentId)
    if (!parent) return 'unknown-node'
    if (parent.ephemeral) return 'generated-card'
    return undefined
  }

  /**
   * Why a script cannot archive or reparent `nodeId`, or undefined when it can.
   * The root is the canvas itself. A generated card is refused because the
   * state manager drops either change to one and the script would be told "ok".
   */
  private movableError(nodeId: NodeId): 'root' | 'unknown-node' | 'generated-card' | undefined {
    if (nodeId === ROOT_NODE_ID) return 'root'
    const node = this.host.getNode(nodeId)
    if (!node) return 'unknown-node'
    if (node.ephemeral) return 'generated-card'
    return undefined
  }

  /**
   * Why a script cannot edit `nodeId` as a card of type `type`, or undefined
   * when it can. A generated card is refused rather than left to the state
   * manager, which drops the write and would leave the script told "ok".
   */
  private editableError(nodeId: NodeId, type: 'markdown' | 'automation'): string | undefined {
    const node = this.host.getNode(nodeId)
    if (!node) return 'unknown-node'
    if (node.type !== type) return type === 'markdown' ? 'not-markdown' : 'not-an-automation'
    if (node.ephemeral) return 'generated-card'
    return undefined
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
