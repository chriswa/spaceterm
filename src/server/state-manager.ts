import { randomUUID } from 'crypto'
import type {
  ServerState,
  NodeData,
  NodeAlert,
  TerminalNodeData,
  MarkdownNodeData,
  DirectoryNodeData,
  FileNodeData,
  TitleNodeData,
  TerminalSessionEntry,
  ArchivedNode,
  GitStatus,
  AlertType
} from '../shared/state'
import type { ClaudeSessionEntry, CameraBounds } from '../shared/protocol'
import { StatePersister } from './persistence'
import { serverLog } from './server-log'
import { abbreviateCwd, scanCwdMismatches, scanDescendantCwdMismatches } from './cwd-alerts'
import {
  asNodeId,
  asPtySessionId,
  asClaudeSessionId,
  nodeIdFromFirstPtySession,
  ROOT_NODE_ID,
  type NodeId,
  type PtySessionId,
  type ClaudeSessionId
} from '../shared/ids'
import type { AgentType } from '../shared/agent-type'
import { isDisposable } from '../shared/node-utils'
import { findAncestor, lookupIn } from '../shared/node-ancestry'
import { MARKDOWN_DEFAULT_WIDTH, MARKDOWN_DEFAULT_HEIGHT, MARKDOWN_DEFAULT_MAX_WIDTH } from '../shared/node-size'

/**
 * How long a freshly spawned pty is protected from archiving its surface. A pty
 * that survives this long started successfully; one that dies sooner failed to
 * launch, and the surface stays visible as a dead remnant the user can retry.
 */
export const ARCHIVAL_PROTECTION_MS = 30_000

/**
 * Why an exit must not archive its surface.
 *
 *  - `restart`   the pty was replaced on purpose; the surface already has a new
 *                one, so its exit is bookkeeping and nothing else.
 *  - `protected` the pty was spawned to bring a surface back (startup revival,
 *                unarchive). Dying inside {@link ARCHIVAL_PROTECTION_MS} means
 *                it failed to launch, so the surface is kept as a dead remnant
 *                rather than archived out from under the user.
 */
type ExitOverride =
  | { kind: 'restart' }
  | { kind: 'protected'; until: number }

export type NodeUpdateCallback = (nodeId: NodeId, fields: Partial<NodeData>) => void
export type NodeAddCallback = (node: NodeData) => void
export type NodeRemoveCallback = (nodeId: NodeId) => void

/** Everything StateManager pushes back out to the rest of the server. */
export interface StateManagerDeps {
  onNodeUpdate: NodeUpdateCallback
  onNodeAdd: NodeAddCallback
  onNodeRemove: NodeRemoveCallback
}

export interface StateManagerOptions {
  /** Defaults to a `StatePersister` writing to `~/.spaceterm/state.json`. */
  persister?: StatePersister
}

/**
 * Which reading of an opaque focus id turned out to be the right one. Reported
 * back rather than discarded so the log line can say how a link resolved — the
 * two kinds are indistinguishable on the wire, both being UUID strings, and
 * "which lookup answered" is the first thing worth knowing when one misfires.
 */
export type FocusIdKind = 'surface' | 'agent-session'

export interface FocusResolution {
  nodeId: NodeId
  matchedAs: FocusIdKind
}

/**
 * The surface reading of an opaque focus id: the pty a link was built from.
 *
 * `SPACETERM_SURFACE_ID` is the pty session id, so only a node's *current*
 * `sessionId` can answer it. Reincarnation rotates that value and past ptys are
 * recorded nowhere that could match, which is exactly why the agent-session
 * reading below exists.
 */
function isSurfaceFor(node: NodeData, id: string): node is TerminalNodeData {
  return node.type === 'terminal' && node.sessionId === id
}

/**
 * The agent-session reading: a Claude/Codex/Cursor conversation id, which
 * outlives the ptys that ran it.
 *
 * Both places an id can be recorded are checked — `claudeSessionHistory` keeps
 * only the latest per session while `terminalSessions` retains the full
 * per-session history — so an id matches under whichever it was last written to.
 */
function hostsAgentSession(node: NodeData, id: string): node is TerminalNodeData {
  return node.type === 'terminal' && (
    node.claudeSessionHistory.some((e) => e.claudeSessionId === id) ||
    node.terminalSessions.some((sess) => sess.claudeSessionId === id)
  )
}

/** One archive entry plus the route back to it. Internal: callers get {@link ArchivedFocusMatch}. */
interface LocatedArchive {
  hostNodeId: NodeId
  path: NodeId[]
  entry: ArchivedNode
}

/**
 * An archived node that answers to a focus id, and where in the archive forest
 * it sits.
 *
 * Archives nest: archiving a node snapshots its own `archivedChildren` along
 * with it, so a surface can end up buried inside an archived parent inside an
 * archived grandparent. `hostNodeId` is the nearest node that is *not* archived
 * — the live node (or the root) whose `archivedChildren` holds the top of that
 * chain — and is where a restore puts the node, since its recorded parent may
 * no longer exist on the canvas.
 */
export interface ArchivedFocusMatch {
  /** Live node (or `ROOT_NODE_ID`) owning the top-level archive entry. */
  hostNodeId: NodeId
  /** Archived node ids from the host's own entry down to the match; length 1 when it sits directly under the host. */
  path: NodeId[]
  /** The matched snapshot, for reading only — restoring goes through {@link StateManager.unarchiveNodeAtPath}. */
  data: NodeData
  /** When this entry was archived (ISO 8601), for the log line that reports the match. */
  archivedAt: string
  matchedAs: FocusIdKind
}

function toFocusMatch(located: LocatedArchive, matchedAs: FocusIdKind): ArchivedFocusMatch {
  return {
    hostNodeId: located.hostNodeId,
    path: located.path,
    data: located.entry.data,
    archivedAt: located.entry.archivedAt,
    matchedAs
  }
}

/**
 * A new terminal node.
 *
 * Named rather than positional on purpose. This used to be eleven positional
 * parameters ending in `cwd?, initialTitleHistory?, name?, insertAfterNodeId?,
 * agentType?`, called from six places that each cared about a different subset
 * — so every call site padded the gaps with `undefined` and a reader had to
 * count commas to tell which field a bare string was. Two of the six had
 * drifted apart in exactly that way.
 */
export interface NewTerminalSpec {
  sessionId: PtySessionId
  parentId: NodeId
  x: number
  y: number
  cols: number
  rows: number
  cwd?: string
  /** Shell titles carried over from a source surface, for fork and restore. */
  initialTitleHistory?: string[]
  name?: string
  /**
   * Place this terminal immediately after another in crab-nav order, rather
   * than at the end. Set when forking, so the fork lands beside its source.
   */
  insertAfterNodeId?: NodeId
  agentType?: AgentType
}

export class StateManager {
  private state: ServerState
  private onNodeUpdate: NodeUpdateCallback
  private onNodeAdd: NodeAddCallback
  private onNodeRemove: NodeRemoveCallback
  private persister: StatePersister
  /** Maps active PTY session ID → node ID (they diverge after reincarnation) */
  private sessionToNodeId = new Map<PtySessionId, NodeId>()
  /**
   * Exits that must not archive their surface, keyed by the pty they apply to.
   *
   * Keying by pty — not by node — is the invariant that keeps this honest. An
   * override recorded against a node id outlives the exit it was meant for, so
   * the surface's *next* exit, however many hours later, reads as "that restart"
   * or "that failed revival" and the surface is stranded on the canvas instead
   * of being archived. Keyed by pty, an override that is never consumed can only
   * ever match a session id that will not come back.
   */
  private exitOverrides = new Map<PtySessionId, ExitOverride>()

  constructor(deps: StateManagerDeps, options: StateManagerOptions = {}) {
    this.onNodeUpdate = deps.onNodeUpdate
    this.onNodeAdd = deps.onNodeAdd
    this.onNodeRemove = deps.onNodeRemove
    this.persister = options.persister ?? new StatePersister()

    // Shape normalisation (field backfills, sortOrder, the one-time alert wipe)
    // lives in state-migrations.ts and has already run by the time load()
    // returns. Dead terminal processing is done by the caller via
    // processDeadTerminals().
    this.state = this.persister.load().state

    // Scan all existing Claude terminals for cwd-mismatch alerts.
    // This catches mismatches that existed before the alert system was deployed
    // or that occurred while the server was offline.
    this.initialAlertScan()
  }

  /**
   * Apply a patch to a node and broadcast exactly what changed.
   *
   * Replaces ~30 hand-written mutate → onNodeUpdate → schedulePersist triples.
   * Each of those carried an `as Partial<TerminalNodeData>`-style cast, which
   * switches off excess-property checking: a misspelled field name compiled,
   * broadcast a key no client reads, and silently did nothing. Here the patch is
   * typed against the node's own type with no cast at the call site, so a typo
   * or a wrong value type is a compile error.
   *
   * The single cast below is a variance artifact — `Partial<TerminalNodeData>`
   * is not assignable to `Partial<NodeData>` because NodeData is a union — and
   * is safe because `node` is the node the patch was checked against.
   */
  private applyPatch<T extends NodeData>(node: T, patch: Partial<T>): void {
    Object.assign(node, patch)
    this.onNodeUpdate(node.id, patch as Partial<NodeData>)
  }

  /** {@link applyPatch}, plus a debounced save. The common case. */
  private patchNode<T extends NodeData>(node: T, patch: Partial<T>): void {
    this.applyPatch(node, patch)
    this.schedulePersist()
  }

  /** Compute the next available sortOrder by scanning all terminal nodes. */
  private nextSortOrder(): number {
    let max = -1
    for (const node of Object.values(this.state.nodes)) {
      if (node.type === 'terminal' && node.sortOrder != null && node.sortOrder > max) {
        max = node.sortOrder
      }
    }
    return max + 1
  }

  /**
   * On startup, collect all terminal nodes for revival.  Terminals still in
   * `nodes` always need a new PTY — either the previous server owned the PTY
   * (alive === true) or a prior startup marked them dead but crashed before
   * the revival loop could re-spawn them (alive === false).
   */
  processDeadTerminals(): Array<{ nodeId: NodeId; claudeSessionId?: ClaudeSessionId; cwd?: string; extraCliArgs?: string }> {
    const deadList: Array<{ nodeId: NodeId; claudeSessionId?: ClaudeSessionId; cwd?: string; extraCliArgs?: string }> = []

    for (const node of Object.values(this.state.nodes)) {
      if (node.type !== 'terminal') continue

      // End current terminal session if still open
      if (node.alive) {
        const currentSession = node.terminalSessions[node.terminalSessions.length - 1]
        if (currentSession && !currentSession.endedAt) {
          currentSession.endedAt = new Date().toISOString()
        }
      }

      const wasAlive = node.alive
      node.alive = false
      // 'working_background' (yellow) is backed by an in-memory ledger that a
      // restart clears, so we can no longer know what background work was
      // outstanding — reset it to 'stopped'.
      node.claudeState = node.claudeState === 'working_background' ? 'stopped' : node.claudeState
      node.claudeStatusUnread = false

      const history = node.claudeSessionHistory ?? []
      const latestClaude = history.length > 0 ? history[history.length - 1].claudeSessionId : undefined

      console.log(`[startup] Terminal ${node.id.slice(0, 8)} wasAlive=${wasAlive} claudeSession=${latestClaude?.slice(0, 8) ?? 'none'}`)

      deadList.push({ nodeId: node.id, claudeSessionId: latestClaude, cwd: node.cwd, extraCliArgs: node.extraCliArgs })
    }

    this.persister.flush(this.state)
    return deadList
  }

  /**
   * Archive a specific terminal node (public wrapper for archiveNode).
   */
  archiveTerminal(nodeId: NodeId, now: number = Date.now()): void {
    this.archiveNode(nodeId, now)
  }

  /**
   * Record that `ptySessionId` is being replaced on purpose, so its exit is
   * bookkeeping rather than the surface dying. Pass the *outgoing* pty: the
   * replacement is a different session and must archive normally when it exits.
   */
  suppressArchivalForRestart(ptySessionId: PtySessionId): void {
    this.exitOverrides.set(ptySessionId, { kind: 'restart' })
    serverLog(`[restart] Suppressing archival for outgoing pty ${ptySessionId.slice(0, 8)}`)
  }

  /**
   * Protect a freshly spawned pty from archiving its surface for
   * {@link ARCHIVAL_PROTECTION_MS}, so a revival that fails to launch leaves a
   * dead remnant the user can retry. The window is a deadline rather than a flag
   * someone has to remember to clear, so it cannot outlive its purpose.
   */
  protectFromArchival(ptySessionId: PtySessionId, now: number = Date.now()): void {
    this.pruneExitOverrides(now)
    this.exitOverrides.set(ptySessionId, { kind: 'protected', until: now + ARCHIVAL_PROTECTION_MS })
  }

  /**
   * Drop overrides that can no longer change any decision: their pty is no
   * longer mapped to a node (so its exit already early-returns), or the
   * protection window has passed. Behaviour-preserving housekeeping, so a
   * restart whose outgoing pty never reports an exit leaves nothing behind.
   */
  private pruneExitOverrides(now: number): void {
    for (const [sessionId, override] of this.exitOverrides) {
      const orphaned = !this.sessionToNodeId.has(sessionId)
      const expired = override.kind === 'protected' && now >= override.until
      if (orphaned || expired) this.exitOverrides.delete(sessionId)
    }
  }

  /** Whether this pty is still inside its post-spawn protection window. */
  isArchivalProtected(ptySessionId: PtySessionId, now: number = Date.now()): boolean {
    const override = this.exitOverrides.get(ptySessionId)
    return override?.kind === 'protected' && now < override.until
  }

  /** Update extra CLI args on a terminal node, broadcast, and persist. */
  updateExtraCliArgs(nodeId: NodeId, extraCliArgs: string): void {
    const node = this.state.nodes[nodeId]
    if (!node || node.type !== 'terminal') return
    this.patchNode(node, { extraCliArgs })
  }

  getState(): ServerState {
    return this.state
  }

  getSavedViewports(): Record<string, CameraBounds> {
    return this.state.savedViewports
  }

  setSavedViewport(slot: string, bounds: CameraBounds): void {
    this.state.savedViewports[slot] = bounds
    this.schedulePersist()
  }

  getNode(id: NodeId): NodeData | undefined {
    return this.state.nodes[id]
  }

  // --- Terminal lifecycle ---

  /**
   * Create a terminal node for a newly spawned PTY session.
   */
  createTerminal(spec: NewTerminalSpec): TerminalNodeData {
    const { sessionId, parentId, x, y, cols, rows, cwd, name, insertAfterNodeId, agentType } = spec
    const zIndex = this.state.nextZIndex++
    const now = new Date().toISOString()
    const seedHistory = spec.initialTitleHistory ?? []
    const initialSession: TerminalSessionEntry = {
      sessionIndex: 0,
      startedAt: now,
      trigger: 'initial',
      shellTitleHistory: [...seedHistory]
    }

    let sortOrder: number
    if (insertAfterNodeId) {
      const sourceNode = this.state.nodes[insertAfterNodeId]
      if (sourceNode?.type === 'terminal' && sourceNode.sortOrder != null) {
        const sourceSortOrder = sourceNode.sortOrder
        for (const node of Object.values(this.state.nodes)) {
          if (node.type === 'terminal' && node.sortOrder > sourceSortOrder) {
            this.applyPatch(node, { sortOrder: node.sortOrder + 1 })
          }
        }
        sortOrder = sourceSortOrder + 1
      } else {
        sortOrder = this.nextSortOrder()
      }
    } else {
      sortOrder = this.nextSortOrder()
    }

    const nodeId = nodeIdFromFirstPtySession(sessionId)
    const node: TerminalNodeData = {
      id: nodeId,
      type: 'terminal',
      alive: true,
      sessionId,
      parentId,
      x,
      y,
      zIndex,
      cols,
      rows,
      cwd,
      claudeState: 'stopped',
      claudeStatusUnread: false,
      claudeStatusAsleep: false,
      sortOrder,
      terminalSessions: [initialSession],
      claudeSessionHistory: [],
      shellTitleHistory: [...seedHistory],
      archivedChildren: [],
      colorPresetId: 'inherit',
      ...(name ? { name } : {}),
      ...(agentType ? { agentType } : {})
    }

    this.state.nodes[nodeId] = node
    this.sessionToNodeId.set(sessionId, nodeId)
    this.onNodeAdd(node)
    this.schedulePersist()
    return node
  }

  /** Resolve a PTY session ID to its terminal node. */
  private getTerminalBySession(ptySessionId: PtySessionId): TerminalNodeData | undefined {
    const nodeId = this.sessionToNodeId.get(ptySessionId)
    if (!nodeId) return undefined
    const node = this.state.nodes[nodeId]
    if (!node || node.type !== 'terminal') return undefined
    return node
  }

  /**
   * Get the node ID for a *live, registered* PTY session ID.
   *
   * Returns undefined for a session the in-memory map does not know about. When
   * you want "whatever node this pty belongs to", including sessions the map has
   * not caught up with, use {@link resolveNodeIdForPtySession}.
   */
  getNodeIdForSession(ptySessionId: PtySessionId): NodeId | undefined {
    return this.sessionToNodeId.get(ptySessionId)
  }

  /**
   * Resolve a PTY session ID to its node, consulting node data when the
   * in-memory map comes up empty.
   *
   * The map is authoritative for live sessions but is rebuilt lazily as ptys
   * register, so a miss does not mean "no such node". Callers used to paper over
   * that with `getNodeIdForSession(id) ?? id`, which only works while a
   * terminal's node id and pty session id still coincide — that is, until its
   * first restart. Scanning `sessionId` is correct in both cases, and is the
   * same reasoning `getNodeIdForClaudeSession` already applies.
   */
  resolveNodeIdForPtySession(ptySessionId: PtySessionId): NodeId | undefined {
    const mapped = this.sessionToNodeId.get(ptySessionId)
    if (mapped) return mapped
    for (const node of Object.values(this.state.nodes)) {
      if (isSurfaceFor(node, ptySessionId)) return node.id
    }
    return undefined
  }

  /**
   * Walk strictly upward from `nodeId` (starting at its parent) and return the
   * id of the nearest ancestor whose type is 'terminal', skipping intermediate
   * nodes such as title cards. Returns undefined if the chain reaches the root
   * without hitting a terminal. Deterministic: every node has a single parent.
   */
  getNearestTerminalAncestor(nodeId: NodeId): NodeId | undefined {
    return findAncestor(lookupIn(this.state.nodes), nodeId, (node) => node.type === 'terminal')?.id
  }

  /**
   * Resolve a Claude session id to the terminal node hosting it, for external
   * focus requests that only know claude session ids (e.g. Voice Operator).
   *
   * Matches against BOTH the persisted `claudeSessionHistory` and each terminal
   * session's `claudeSessionId` — the former keeps only the latest id while the
   * latter retains the full per-session history, so checking both matches an id
   * no matter which it was last recorded under. A session id can appear in
   * several nodes via forks/restarts, so an alive node wins over a dead one.
   *
   * Deliberately reads persisted node data, NOT the in-memory `sessionToNodeId`
   * map: that map is rebuilt lazily as ptys re-register after a server restart,
   * whereas node data is loaded from disk at startup — so this resolves an alive
   * terminal correctly even immediately after a restart.
   */
  getNodeIdForClaudeSession(claudeSessionId: ClaudeSessionId): NodeId | undefined {
    let fallback: NodeId | undefined
    for (const node of Object.values(this.state.nodes)) {
      if (!hostsAgentSession(node, claudeSessionId)) continue
      if (node.alive) return node.id
      fallback ??= node.id
    }
    return fallback
  }

  /**
   * Resolve an id whose kind the sender did not know — as carried by a
   * `spaceterm-surface://` deep link — to the node it should raise.
   *
   * The id in a deep link is opaque. Whoever built the URL had whichever id was
   * to hand: a surface id (`SPACETERM_SURFACE_ID`) or an agent session id — what
   * Claude, Codex, or Cursor each call their own conversation, all three of
   * which land in the same node fields. Both kinds are UUID strings, so nothing
   * about the value says which it is; only a lookup can tell. Surface first,
   * because that is the narrower namespace and the one the scheme was built
   * for, then the agent reading.
   *
   * Archived nodes are excluded from both readings for free: archiving removes
   * the node from `state.nodes`, so a link naming one simply finds nothing. A
   * remnant — pty exited, card still on the canvas — does resolve, since it is
   * still something the user asked to be shown.
   */
  resolveNodeIdForFocus(id: string): FocusResolution | undefined {
    const surface = this.resolveNodeIdForPtySession(asPtySessionId(id))
    if (surface) return { nodeId: surface, matchedAs: 'surface' }
    const agentSession = this.getNodeIdForClaudeSession(asClaudeSessionId(id))
    if (agentSession) return { nodeId: agentSession, matchedAs: 'agent-session' }
    return undefined
  }

  /**
   * Every archived node in the forest, paired with where it sits.
   *
   * Two things make this a forest rather than a list. Archives hang off each
   * live node (plus the root), and an archived node keeps its own
   * `archivedChildren`, so archiving a parent buries whatever was already
   * archived beneath it. Both directions are walked, depth-first, and every
   * entry reports the same `hostNodeId`: nesting does not change which live
   * node ultimately holds the chain.
   *
   * `archivedChildren` is defaulted because snapshots deep-copied under older
   * state versions can predate the field.
   */
  private archivedNodesWithLocation(): LocatedArchive[] {
    const found: LocatedArchive[] = []
    const walk = (hostNodeId: NodeId, entries: ArchivedNode[], prefix: NodeId[]): void => {
      for (const entry of entries) {
        const path = [...prefix, entry.data.id]
        found.push({ hostNodeId, path, entry })
        walk(hostNodeId, entry.data.archivedChildren ?? [], path)
      }
    }
    walk(ROOT_NODE_ID, this.state.rootArchivedChildren, [])
    for (const node of Object.values(this.state.nodes)) {
      walk(node.id, node.archivedChildren ?? [], [])
    }
    return found
  }

  /**
   * Find an archived surface answering to an opaque focus id — the fallback for
   * a `spaceterm-surface://` link that {@link resolveNodeIdForFocus} could not
   * place, because the surface it names has since been archived.
   *
   * Same two readings in the same order as the live lookup, so a link resolves
   * to the same kind of thing whether or not its surface is still on the canvas.
   * Within one reading the most recently archived match wins: a session id can
   * appear in several snapshots via forks and restarts, and the newest is the
   * one the sender most plausibly means — the archived counterpart of the live
   * lookup preferring an alive node over a dead one.
   */
  findArchivedNodeForFocus(id: string): ArchivedFocusMatch | undefined {
    const all = this.archivedNodesWithLocation()
    const newest = (reading: (node: NodeData, id: string) => boolean): LocatedArchive | undefined =>
      all
        .filter((m) => reading(m.entry.data, id))
        .reduce<LocatedArchive | undefined>(
          (best, m) => (!best || m.entry.archivedAt > best.entry.archivedAt ? m : best),
          undefined
        )

    const surface = newest(isSurfaceFor)
    if (surface) return toFocusMatch(surface, 'surface')
    const agentSession = newest(hostsAgentSession)
    if (agentSession) return toFocusMatch(agentSession, 'agent-session')
    return undefined
  }

  /**
   * Handle terminal PTY exit: update metadata then immediately archive.
   *
   * An exit archives its surface unless the pty carries an override — see
   * {@link ExitOverride}. Overrides are single-use: consumed here whether or not
   * they still apply, so no surface is left permanently immune to archival.
   */
  terminalExited(ptySessionId: PtySessionId, exitCode: number, now: number = Date.now()): void {
    const node = this.getTerminalBySession(ptySessionId)
    if (!node) return

    const override = this.exitOverrides.get(ptySessionId)
    this.exitOverrides.delete(ptySessionId)
    this.pruneExitOverrides(now)
    const label = `session=${ptySessionId.slice(0, 8)} node=${node.id.slice(0, 8)} exitCode=${exitCode}`

    // Replaced on purpose: the surface already has its new pty, so there is
    // nothing to mark dead and nothing to archive.
    if (override?.kind === 'restart') {
      serverLog(`[exit] terminalExited ${label} — skipping archival (mid-restart)`)
      this.sessionToNodeId.delete(ptySessionId)
      return
    }

    // Died inside its post-spawn window: it failed to launch, so leave a dead
    // remnant the user can retry rather than archiving the surface away.
    const failedToLaunch = override?.kind === 'protected' && now < override.until

    serverLog(`[exit] terminalExited ${label} — ${failedToLaunch ? 'keeping as remnant (failed to launch)' : 'archiving'}`)

    node.alive = false
    node.exitCode = exitCode
    node.claudeState = 'stopped'

    // End the current terminal session
    const currentSession = node.terminalSessions[node.terminalSessions.length - 1]
    if (currentSession && !currentSession.endedAt) {
      currentSession.endedAt = new Date(now).toISOString()
    }

    if (failedToLaunch) {
      // Keep as dead remnant — the surface stays visible and can be manually restarted.
      // Preserve sessionToNodeId so asleep toggles can still resolve the node.
      this.patchNode(node, { alive: false, exitCode, claudeState: 'stopped' })
    } else {
      this.sessionToNodeId.delete(ptySessionId)
      this.archiveNode(node.id)
    }
  }

  /**
   * Reincarnate a dead terminal (remnant → alive).
   * Called when a new PTY is spawned for an existing remnant node.
   * @param nodeId - The node ID of the remnant
   * @param newPtySessionId - The new PTY session ID from SessionManager
   */
  reincarnateTerminal(nodeId: NodeId, newPtySessionId: PtySessionId, cols: number, rows: number): void {
    const node = this.state.nodes[nodeId]
    if (!node || node.type !== 'terminal') return
    serverLog(`[restart] Reincarnated node ${nodeId.slice(0, 8)} → session ${newPtySessionId.slice(0, 8)}`)

    // Clean up old session mapping (may still exist if the PTY died as a remnant)
    if (node.sessionId !== newPtySessionId) {
      this.sessionToNodeId.delete(node.sessionId)
    }

    // Start a new terminal session
    const prevSession = node.terminalSessions[node.terminalSessions.length - 1]
    const newSession: TerminalSessionEntry = {
      sessionIndex: node.terminalSessions.length,
      startedAt: new Date().toISOString(),
      trigger: 'reincarnation',
      shellTitleHistory: prevSession ? [...prevSession.shellTitleHistory] : []
    }
    node.terminalSessions.push(newSession)

    this.sessionToNodeId.set(newPtySessionId, nodeId)
    this.patchNode(node, {
      alive: true,
      sessionId: newPtySessionId,
      cols,
      rows,
      exitCode: undefined,
      claudeState: 'stopped',
      claudeStatusUnread: false
    })
  }

  // --- Node mutations ---

  moveNode(nodeId: NodeId, x: number, y: number): void {
    const node = this.state.nodes[nodeId]
    if (!node) return
    node.x = x
    node.y = y
    this.onNodeUpdate(nodeId, { x, y })
    this.schedulePersist()
  }

  batchMoveNodes(moves: Array<{ nodeId: NodeId; x: number; y: number }>): void {
    for (const { nodeId, x, y } of moves) {
      const node = this.state.nodes[nodeId]
      if (node) {
        node.x = x
        node.y = y
        this.onNodeUpdate(nodeId, { x, y })
      }
    }
    this.schedulePersist()
  }

  renameNode(nodeId: NodeId, name: string): void {
    const node = this.state.nodes[nodeId]
    if (!node) return
    node.name = name || null
    this.onNodeUpdate(nodeId, { name: node.name })
    this.schedulePersist()
  }

  setNodeColor(nodeId: NodeId, colorPresetId: string): void {
    const node = this.state.nodes[nodeId]
    if (!node) return
    node.colorPresetId = colorPresetId
    this.onNodeUpdate(nodeId, { colorPresetId })
    this.schedulePersist()
  }

  reorderCrabs(orderedIds: NodeId[]): void {
    for (let i = 0; i < orderedIds.length; i++) {
      const node = this.state.nodes[orderedIds[i]]
      if (!node || node.type !== 'terminal') continue
      if (node.sortOrder !== i) {
        this.applyPatch(node, { sortOrder: i })
      }
    }
    this.schedulePersist()
  }

  bringToFront(nodeId: NodeId): void {
    const node = this.state.nodes[nodeId]
    if (!node) return
    node.zIndex = this.state.nextZIndex++
    node.lastFocusedAt = new Date().toISOString()
    this.onNodeUpdate(nodeId, { zIndex: node.zIndex, lastFocusedAt: node.lastFocusedAt })
    this.schedulePersist()
  }

  reparentNode(nodeId: NodeId, newParentId: NodeId): void {
    const node = this.state.nodes[nodeId]
    if (!node) return
    node.parentId = newParentId
    this.onNodeUpdate(nodeId, { parentId: newParentId })
    this.schedulePersist()
    // Recheck cwd-mismatch alerts for the reparented subtree
    this.recheckDescendantCwdAlerts(nodeId)
  }

  /**
   * Swap a parent node (P) with its immediate child (C):
   * - C gets P's old parent
   * - P becomes C's child
   * - C's former children become P's children
   */
  swapParentChild(nodeId: NodeId, childId: NodeId): void {
    const parent = this.state.nodes[nodeId]
    const child = this.state.nodes[childId]
    if (!parent || !child) return
    if (child.parentId !== nodeId) return

    const oldParentOfP = parent.parentId

    // Collect C's current children before mutating
    const cChildIds: NodeId[] = []
    for (const node of Object.values(this.state.nodes)) {
      if (node.parentId === childId) {
        cChildIds.push(node.id)
      }
    }

    // C takes P's old parent
    child.parentId = oldParentOfP
    this.onNodeUpdate(childId, { parentId: oldParentOfP })

    // P becomes C's child
    parent.parentId = childId
    this.onNodeUpdate(nodeId, { parentId: childId })

    // C's old children become P's children
    for (const id of cChildIds) {
      const node = this.state.nodes[id]
      if (node) {
        node.parentId = nodeId
        this.onNodeUpdate(id, { parentId: nodeId })
      }
    }

    this.schedulePersist()
    this.recheckDescendantCwdAlerts(childId)
    this.recheckDescendantCwdAlerts(nodeId)
  }

  /**
   * Archive a node: snapshot into parent's archivedChildren, reparent children, remove node.
   *
   * `now` stamps the snapshot. Defaulted rather than read inside so a test can
   * archive two nodes at known, distinct times — which reading of the wall clock
   * cannot guarantee within one tick, and {@link findArchivedNodeForFocus}
   * breaks ties on exactly that stamp.
   */
  archiveNode(nodeId: NodeId, now: number = Date.now()): void {
    const node = this.state.nodes[nodeId]
    if (!node) return
    serverLog(`[archive] Archiving node ${nodeId.slice(0, 8)}`)

    const parentId = node.parentId

    // Clean up session-to-node mapping (covers both live terminals and dead remnants
    // whose mapping was preserved for asleep toggles)
    if (node.type === 'terminal') {
      this.sessionToNodeId.delete(node.sessionId)
    }

    // Only snapshot into archive if the node has meaningful content
    if (!isDisposable(node)) {
      const snapshot = {
        archivedAt: new Date(now).toISOString(),
        data: JSON.parse(JSON.stringify(node)) // deep copy
      }
      if (parentId === ROOT_NODE_ID) {
        this.state.rootArchivedChildren.push(snapshot)
        this.onNodeUpdate(ROOT_NODE_ID, { archivedChildren: this.state.rootArchivedChildren })
      } else {
        const parent = this.state.nodes[parentId]
        if (parent) {
          parent.archivedChildren.push(snapshot)
          this.onNodeUpdate(parentId, { archivedChildren: parent.archivedChildren })
        }
      }
    }

    // Reparent children to the archived node's parent
    for (const child of Object.values(this.state.nodes)) {
      if (child.parentId === nodeId) {
        child.parentId = parentId
        this.onNodeUpdate(child.id, { parentId })
        // Recheck cwd-mismatch alerts for each reparented child subtree
        this.recheckDescendantCwdAlerts(child.id)
      }
    }

    // Remove the node
    delete this.state.nodes[nodeId]
    this.onNodeRemove(nodeId)
    this.schedulePersist()
  }

  /**
   * The `archivedChildren` array a host node owns directly — the root's, or a
   * live node's. Undefined when the node is gone.
   */
  private archiveArrayOf(hostNodeId: NodeId): ArchivedNode[] | undefined {
    if (hostNodeId === ROOT_NODE_ID) return this.state.rootArchivedChildren
    return this.state.nodes[hostNodeId]?.archivedChildren
  }

  /**
   * Follow `path` — archived node ids, outermost first — down `hostNodeId`'s
   * archive tree to the entry it names, reporting the array that holds it so a
   * caller can splice it out. Undefined if any hop is missing.
   */
  private archiveEntryAt(
    hostNodeId: NodeId,
    path: NodeId[]
  ): { list: ArchivedNode[]; index: number; entry: ArchivedNode } | undefined {
    const hostArchive = this.archiveArrayOf(hostNodeId)
    if (!hostArchive || path.length === 0) return undefined
    let list: ArchivedNode[] = hostArchive
    for (let depth = 0; ; depth++) {
      const index = list.findIndex((e) => e.data.id === path[depth])
      if (index === -1) return undefined
      const entry = list[index]
      if (depth === path.length - 1) return { list, index, entry }
      list = entry.data.archivedChildren ?? []
    }
  }

  /**
   * Read archived node data without modifying state.
   */
  peekArchivedNode(parentNodeId: NodeId, archivedNodeId: NodeId): NodeData | undefined {
    return this.archiveEntryAt(parentNodeId, [archivedNodeId])?.entry.data
  }

  /**
   * Unarchive a node: restore from parent's archivedChildren back into the node tree.
   */
  unarchiveNode(parentNodeId: NodeId, archivedNodeId: NodeId, positionOverride?: { x: number; y: number }): void {
    this.unarchiveNodeAtPath(parentNodeId, [archivedNodeId], positionOverride)
  }

  /**
   * Restore an archived node from anywhere in `hostNodeId`'s archive tree, as a
   * direct child of that host.
   *
   * Depth is the whole point. An entry nested inside archived ancestors has a
   * `parentId` pointing at a node that is no longer on the canvas, so restoring
   * it in place would attach it to nothing; it is reparented to the host, which
   * is by construction the nearest node that is not itself archived. Its own
   * `archivedChildren` ride along in the snapshot, so unarchiving a parent does
   * not strand what was archived beneath it.
   *
   * Returns the restored node, or undefined if `path` names nothing.
   */
  unarchiveNodeAtPath(
    hostNodeId: NodeId,
    path: NodeId[],
    positionOverride?: { x: number; y: number }
  ): NodeData | undefined {
    const found = this.archiveEntryAt(hostNodeId, path)
    if (!found) return undefined
    found.list.splice(found.index, 1)

    // Restore node data
    const restoredNode = JSON.parse(JSON.stringify(found.entry.data)) as NodeData
    restoredNode.zIndex = this.state.nextZIndex++
    restoredNode.parentId = hostNodeId

    if (positionOverride) {
      restoredNode.x = positionOverride.x
      restoredNode.y = positionOverride.y
    }

    // For terminals: mark as dead remnant (PTY is gone)
    if (restoredNode.type === 'terminal') {
      restoredNode.alive = false
      restoredNode.claudeState = 'stopped'
    }

    this.state.nodes[restoredNode.id] = restoredNode
    this.onNodeAdd(restoredNode)

    // Broadcast the host's archive, which changed at whatever depth the entry sat.
    const hostArchive = this.archiveArrayOf(hostNodeId)
    if (hostArchive) this.onNodeUpdate(hostNodeId, { archivedChildren: hostArchive })

    if (path.length > 1) {
      serverLog(`[archive] Restored ${restoredNode.id.slice(0, 8)} from ${path.length} levels deep -> parent=${hostNodeId.slice(0, 8)}`)
    }

    this.schedulePersist()
    return restoredNode
  }

  /**
   * Delete an archived node entry permanently.
   */
  deleteArchivedNode(parentNodeId: NodeId, archivedNodeId: NodeId): void {
    const found = this.archiveEntryAt(parentNodeId, [archivedNodeId])
    if (!found) return
    found.list.splice(found.index, 1)

    const hostArchive = this.archiveArrayOf(parentNodeId)
    if (hostArchive) this.onNodeUpdate(parentNodeId, { archivedChildren: hostArchive })

    this.schedulePersist()
  }

  // --- Undo buffer ---

  pushUndoEntry(entry: import('../shared/undo-types').UndoEntry): void {
    // Truncate redo entries beyond cursor
    this.state.undoBuffer.splice(this.state.undoCursor)
    this.state.undoBuffer.push(entry)
    this.state.undoCursor = this.state.undoBuffer.length
    // Trim FIFO if over limit
    if (this.state.undoBuffer.length > 100) {
      this.state.undoBuffer.shift()
      this.state.undoCursor--
    }
    this.schedulePersist()
  }

  setUndoCursor(cursor: number): void {
    this.state.undoCursor = cursor
    this.schedulePersist()
  }

  // --- Terminal metadata updates (from SessionManager callbacks) ---

  updateTerminalSize(ptySessionId: PtySessionId, cols: number, rows: number): void {
    const node = this.getTerminalBySession(ptySessionId)
    if (!node) return
    this.patchNode(node, { cols, rows })
  }

  updateCwd(ptySessionId: PtySessionId, cwd: string): void {
    const node = this.getTerminalBySession(ptySessionId)
    if (!node) return
    this.patchNode(node, { cwd })
    // The BFS starts at this node, so it covers the surface itself as well as
    // everything that inherits a cwd from it.
    this.recheckDescendantCwdAlerts(node.id)
  }

  updateShellTitleHistory(ptySessionId: PtySessionId, history: string[]): void {
    const node = this.getTerminalBySession(ptySessionId)
    if (!node) return
    node.shellTitleHistory = history

    // Also update the current terminal session's title history
    const currentSession = node.terminalSessions[node.terminalSessions.length - 1]
    if (currentSession) {
      currentSession.shellTitleHistory = [...history]
    }

    this.patchNode(node, { shellTitleHistory: history })
  }

  updateClaudeSessionHistory(ptySessionId: PtySessionId, history: ClaudeSessionEntry[]): void {
    const node = this.getTerminalBySession(ptySessionId)
    if (!node) return
    node.claudeSessionHistory = history

    // If the latest entry has a claudeSessionId, update the current terminal session
    if (history.length > 0) {
      const latest = history[history.length - 1]
      const currentSession = node.terminalSessions[node.terminalSessions.length - 1]
      if (currentSession) {
        // Check if this is a new Claude session (session change)
        if (currentSession.claudeSessionId && currentSession.claudeSessionId !== latest.claudeSessionId) {
          // End current session, start new one
          currentSession.endedAt = new Date().toISOString()
          const newSession: TerminalSessionEntry = {
            sessionIndex: node.terminalSessions.length,
            startedAt: new Date().toISOString(),
            trigger: 'claude-session-change',
            claudeSessionId: latest.claudeSessionId,
            shellTitleHistory: [...currentSession.shellTitleHistory]
          }
          node.terminalSessions.push(newSession)
        } else {
          currentSession.claudeSessionId = latest.claudeSessionId
        }
      }
    }

    this.patchNode(node, { claudeSessionHistory: history })
  }

  /**
   * Live agent state for a surface.
   *
   * These five fields — claudeState, claudeStatusUnread, claudeStatusAsleep,
   * claudeContextPercent, claudeSessionLineCount — used to live here *and* in
   * SessionManager's in-memory session, written to both at every call site and
   * read with a `session ?? node` fallback. The session copy was strictly the
   * weaker of the two: it was cleared by a server restart and reset by
   * reincarnation, which is why every reader fell back here. The node is now
   * the only owner.
   *
   * The dedup that SessionManager used to provide lives here, so an unchanged
   * value still costs no broadcast.
   */
  getClaudeState(ptySessionId: PtySessionId): import('../shared/state').ClaudeState {
    return this.getTerminalBySession(ptySessionId)?.claudeState ?? 'stopped'
  }

  updateClaudeState(ptySessionId: PtySessionId, state: import('../shared/state').ClaudeState): void {
    const node = this.getTerminalBySession(ptySessionId)
    if (!node || node.claudeState === state) return
    this.patchNode(node, { claudeState: state })
  }

  updateClaudeModel(ptySessionId: PtySessionId, model: string): void {
    const node = this.getTerminalBySession(ptySessionId)
    if (!node || node.claudeModel === model) return
    this.patchNode(node, { claudeModel: model })
  }

  /** Returns true when the value changed, so callers can gate a client broadcast. */
  updateClaudeContextPercent(ptySessionId: PtySessionId, percent: number): boolean {
    const node = this.getTerminalBySession(ptySessionId)
    if (!node || node.claudeContextPercent === percent) return false
    this.patchNode(node, { claudeContextPercent: percent })
    return true
  }

  /** Returns true when the value changed, so callers can gate a client broadcast. */
  updateClaudeSessionLineCount(ptySessionId: PtySessionId, lineCount: number): boolean {
    const node = this.getTerminalBySession(ptySessionId)
    if (!node || node.claudeSessionLineCount === lineCount) return false
    this.patchNode(node, { claudeSessionLineCount: lineCount })
    return true
  }

  getClaudeContextPercent(ptySessionId: PtySessionId): number | null {
    return this.getTerminalBySession(ptySessionId)?.claudeContextPercent ?? null
  }

  getClaudeSessionLineCount(ptySessionId: PtySessionId): number | null {
    return this.getTerminalBySession(ptySessionId)?.claudeSessionLineCount ?? null
  }

  updateClaudeStateDecisionTime(ptySessionId: PtySessionId, timestamp: number): void {
    const node = this.getTerminalBySession(ptySessionId)
    if (!node) return
    this.patchNode(node, { claudeStateDecidedAt: timestamp })
  }

  getClaudeStatusUnread(ptySessionId: PtySessionId): boolean {
    return this.getTerminalBySession(ptySessionId)?.claudeStatusUnread ?? false
  }

  updateClaudeStatusUnread(ptySessionId: PtySessionId, unread: boolean): void {
    const node = this.getTerminalBySession(ptySessionId)
    if (!node || node.claudeStatusUnread === unread) return
    this.patchNode(node, { claudeStatusUnread: unread })
  }

  getClaudeStatusAsleep(ptySessionId: PtySessionId): boolean {
    return this.getTerminalBySession(ptySessionId)?.claudeStatusAsleep ?? false
  }

  updateClaudeStatusAsleep(ptySessionId: PtySessionId, asleep: boolean): void {
    const node = this.getTerminalBySession(ptySessionId)
    if (!node || node.claudeStatusAsleep === asleep) return
    this.patchNode(node, { claudeStatusAsleep: asleep })
  }

  updateLastInteracted(ptySessionId: PtySessionId, timestamp: number): void {
    const node = this.getTerminalBySession(ptySessionId)
    if (!node) return
    const prevMinute = node.lastInteractedAt ? Math.floor(node.lastInteractedAt / 60000) : -1
    const curMinute = Math.floor(timestamp / 60000)
    // Only broadcast when the displayed minute value changes (or on first
    // activity) — but always record it, so the persisted value stays current.
    if (curMinute !== prevMinute) {
      this.applyPatch(node, { lastInteractedAt: timestamp })
    } else {
      node.lastInteractedAt = timestamp
    }
    this.schedulePersist()
  }

  // --- Directory operations ---

  createDirectory(parentId: NodeId, x: number, y: number, cwd: string): DirectoryNodeData {
    cwd = abbreviateCwd(cwd)

    const id = asNodeId(randomUUID())
    const zIndex = this.state.nextZIndex++

    const node: DirectoryNodeData = {
      id,
      type: 'directory',
      parentId,
      x,
      y,
      zIndex,
      cwd,
      archivedChildren: [],
      colorPresetId: 'inherit'
    }

    this.state.nodes[id] = node
    this.onNodeAdd(node)
    this.schedulePersist()
    return node
  }

  updateDirectoryCwd(nodeId: NodeId, cwd: string): void {
    const node = this.state.nodes[nodeId]
    if (!node || node.type !== 'directory') return
    this.patchNode(node, { cwd })
    // Recheck cwd-mismatch alerts for descendants whose ancestor cwd changed
    this.recheckDescendantCwdAlerts(nodeId)
  }

  updateDirectoryGitStatus(nodeId: NodeId, gitStatus: GitStatus | null): void {
    const node = this.state.nodes[nodeId]
    if (!node || node.type !== 'directory') return
    this.applyPatch(node, { gitStatus })
    // Don't persist — ephemeral data, same pattern as updateClaudeState
  }

  getDirectoryNodes(): DirectoryNodeData[] {
    return Object.values(this.state.nodes).filter(
      (n): n is DirectoryNodeData => n.type === 'directory'
    )
  }

  // --- File operations ---

  createFile(parentId: NodeId, x: number, y: number, filePath: string): FileNodeData {
    const id = asNodeId(randomUUID())
    const zIndex = this.state.nextZIndex++

    const node: FileNodeData = {
      id,
      type: 'file',
      parentId,
      x,
      y,
      zIndex,
      filePath,
      archivedChildren: [],
      colorPresetId: 'inherit'
    }

    this.state.nodes[id] = node
    this.onNodeAdd(node)
    this.schedulePersist()
    return node
  }

  updateFilePath(nodeId: NodeId, filePath: string): void {
    const node = this.state.nodes[nodeId]
    if (!node || node.type !== 'file') return
    this.patchNode(node, { filePath })
  }

  // --- Markdown operations ---

  createMarkdown(parentId: NodeId, x: number, y: number, content?: string, fileBacked?: boolean): MarkdownNodeData {
    const id = asNodeId(randomUUID())
    const zIndex = this.state.nextZIndex++

    const node: MarkdownNodeData = {
      id,
      type: 'markdown',
      parentId,
      x,
      y,
      zIndex,
      width: MARKDOWN_DEFAULT_WIDTH,
      height: MARKDOWN_DEFAULT_HEIGHT,
      content: content ?? '',
      maxWidth: MARKDOWN_DEFAULT_MAX_WIDTH,
      archivedChildren: [],
      colorPresetId: 'inherit',
      ...(fileBacked ? { fileBacked: true } : {})
    }

    this.state.nodes[id] = node
    this.onNodeAdd(node)
    this.schedulePersist()
    return node
  }

  resizeMarkdown(nodeId: NodeId, width: number, height: number): void {
    const node = this.state.nodes[nodeId]
    if (!node || node.type !== 'markdown') return
    this.patchNode(node, { width, height })
  }

  updateMarkdownContent(nodeId: NodeId, content: string): void {
    const node = this.state.nodes[nodeId]
    if (!node || node.type !== 'markdown') return
    this.patchNode(node, { content })
  }

  setMarkdownMaxWidth(nodeId: NodeId, maxWidth: number): void {
    const node = this.state.nodes[nodeId]
    if (!node || node.type !== 'markdown') return
    this.patchNode(node, { maxWidth })
  }

  // --- Title operations ---

  createTitle(parentId: NodeId, x: number, y: number, text?: string): TitleNodeData {
    const id = asNodeId(randomUUID())
    const zIndex = this.state.nextZIndex++

    const node: TitleNodeData = {
      id,
      type: 'title',
      parentId,
      x,
      y,
      zIndex,
      text: text ?? '',
      archivedChildren: [],
      colorPresetId: 'inherit'
    }

    this.state.nodes[id] = node
    this.onNodeAdd(node)
    this.schedulePersist()
    return node
  }

  updateTitleText(nodeId: NodeId, text: string): void {
    const node = this.state.nodes[nodeId]
    if (!node || node.type !== 'title') return
    this.patchNode(node, { text })
  }

  // --- Alerts ---

  /**
   * The cwd-mismatch rules live in cwd-alerts.ts as pure functions of the node
   * graph. StateManager's job is only to apply what they decide.
   */
  private applyAlertChanges(changes: Array<{ node: TerminalNodeData; alerts: NodeAlert[] | undefined }>): void {
    if (changes.length === 0) return
    for (const { node, alerts } of changes) {
      // Broadcast [] rather than undefined: the client reads it as "no alerts",
      // whereas an absent key would leave the previous list on screen.
      this.applyPatch(node, { alerts })
      node.alerts = alerts
    }
    this.schedulePersist()
  }

  /** Scan all existing Claude terminals for cwd-mismatch alerts on startup. */
  private initialAlertScan(): void {
    this.applyAlertChanges(scanCwdMismatches(this.state.nodes, Date.now()))
  }

  /** Re-evaluate cwd alerts for a node and everything beneath it. */
  recheckDescendantCwdAlerts(nodeId: NodeId): void {
    this.applyAlertChanges(scanDescendantCwdMismatches(this.state.nodes, nodeId, Date.now()))
  }

  /**
   * Raise or clear the alert of one kind on a node, leaving other kinds alone.
   *
   * Pass a message to raise, `null` to clear. Replacing only the matching kind
   * is what lets more than one thing produce alerts — the cwd-mismatch scan and
   * launch failures both write here, and neither may wipe the other's.
   *
   * Raising an alert that is already present is a no-op rather than a refresh,
   * so the timestamp stays at first detection. That timestamp is what the
   * unread badge compares against; refreshing it would make an alert the user
   * already dismissed pop back as unread on every re-evaluation.
   */
  setAlert(nodeId: NodeId, type: AlertType, message: string | null, now: number = Date.now()): void {
    const node = this.state.nodes[nodeId]
    if (!node) return
    const current = node.alerts ?? []
    const existing = current.find((a) => a.type === type)

    if (message === null) {
      if (!existing) return
      const remaining = current.filter((a) => a.type !== type)
      // Broadcast [] rather than undefined: the client reads [] as "no alerts",
      // whereas an absent key leaves the previous list on screen.
      this.patchNode(node, { alerts: remaining.length > 0 ? remaining : [] })
      node.alerts = remaining.length > 0 ? remaining : undefined
      return
    }

    if (existing?.message === message) return
    const others = current.filter((a) => a.type !== type)
    // Keep the original timestamp when only the message changed, so a
    // re-worded alert does not re-badge as unread.
    const alerts = [...others, { type, message, timestamp: existing?.timestamp ?? now }]
    this.patchNode(node, { alerts })
    node.alerts = alerts
  }

  /** Set the alerts-read timestamp on a node. */
  setAlertsReadTimestamp(nodeId: NodeId, timestamp: number): void {
    const node = this.state.nodes[nodeId]
    if (!node) return
    this.patchNode(node, { alertsReadTimestamp: timestamp })
  }

  // --- Persistence ---

  private schedulePersist(): void {
    this.persister.schedule(this.state)
  }

  /**
   * Immediately persist state. Call on shutdown.
   */
  persistImmediate(): void {
    this.persister.flush(this.state)
  }
}
