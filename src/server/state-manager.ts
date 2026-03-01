import { randomUUID } from 'crypto'
import { homedir } from 'os'
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
  GitStatus
} from '../shared/state'
import type { ClaudeSessionEntry } from '../shared/protocol'
import { schedulePersist, persistNow, loadState } from './persistence'
import { getAncestorCwd } from './path-utils'
import { isDisposable } from '../shared/node-utils'
import { MARKDOWN_DEFAULT_WIDTH, MARKDOWN_DEFAULT_HEIGHT, MARKDOWN_DEFAULT_MAX_WIDTH } from '../shared/node-size'

const STATE_VERSION = 1

export type NodeUpdateCallback = (nodeId: string, fields: Partial<NodeData>) => void
export type NodeAddCallback = (node: NodeData) => void
export type NodeRemoveCallback = (nodeId: string) => void

export class StateManager {
  private state: ServerState
  private onNodeUpdate: NodeUpdateCallback
  private onNodeAdd: NodeAddCallback
  private onNodeRemove: NodeRemoveCallback
  /** Maps active PTY session ID → node ID (they diverge after reincarnation) */
  private sessionToNodeId = new Map<string, string>()
  /** Tracks node IDs mid-restart — prevents terminalExited from archiving the node */
  private restartingNodes = new Set<string>()
  /** Tracks node IDs spawned by startup revival — terminalExited skips archival so the
   *  surface stays visible as a dead remnant the user can manually retry. */
  private revivingNodes = new Set<string>()

  constructor(
    onNodeUpdate: NodeUpdateCallback,
    onNodeAdd: NodeAddCallback,
    onNodeRemove: NodeRemoveCallback
  ) {
    this.onNodeUpdate = onNodeUpdate
    this.onNodeAdd = onNodeAdd
    this.onNodeRemove = onNodeRemove

    // Load persisted state or create empty
    const loaded = loadState()
    if (loaded) {
      this.state = loaded
      // Backfill for state files that predate rootArchivedChildren
      if (!this.state.rootArchivedChildren) {
        this.state.rootArchivedChildren = []
      }
      // Backfill for state files that predate undoBuffer
      if (!this.state.undoBuffer) {
        this.state.undoBuffer = []
      }
      // Dead terminal processing is done by the caller via processDeadTerminals()

      // MIGRATION: Backfill sortOrder for terminals that predate this field.
      // Can be removed once all users have launched at least once after this change.
      this.migrateSortOrder()

      // TEMPORARY: Wipe all alerts to clear bad state from before ~ expansion fix.
      // Remove this block once state is clean.
      for (const node of Object.values(this.state.nodes)) {
        if (node.alerts) {
          node.alerts = undefined
          node.alertsReadTimestamp = undefined
        }
      }

      // Scan all existing Claude terminals for cwd-mismatch alerts.
      // This catches mismatches that existed before the alert system was deployed
      // or that occurred while the server was offline.
      this.initialAlertScan()
    } else {
      this.state = {
        version: STATE_VERSION,
        nextZIndex: 1,
        nodes: {},
        rootArchivedChildren: [],
        undoBuffer: []
      }
    }
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

  /** Backfill sortOrder for terminals that predate this field. */
  private migrateSortOrder(): void {
    const needsMigration: import('../shared/state').TerminalNodeData[] = []
    for (const node of Object.values(this.state.nodes)) {
      if (node.type === 'terminal' && node.sortOrder == null) {
        needsMigration.push(node)
      }
    }
    if (needsMigration.length === 0) return

    // Sort by first session startedAt so existing order matches createdAt
    needsMigration.sort((a, b) => {
      const aTime = a.terminalSessions[0]?.startedAt ?? ''
      const bTime = b.terminalSessions[0]?.startedAt ?? ''
      return aTime < bTime ? -1 : aTime > bTime ? 1 : 0
    })

    let next = this.nextSortOrder()
    for (const node of needsMigration) {
      node.sortOrder = next++
    }
  }

  /**
   * On startup, collect all terminal nodes for revival.  Terminals still in
   * `nodes` always need a new PTY — either the previous server owned the PTY
   * (alive === true) or a prior startup marked them dead but crashed before
   * the revival loop could re-spawn them (alive === false).
   */
  processDeadTerminals(): Array<{ nodeId: string; claudeSessionId?: string; cwd?: string; extraCliArgs?: string }> {
    const deadList: Array<{ nodeId: string; claudeSessionId?: string; cwd?: string; extraCliArgs?: string }> = []

    for (const node of Object.values(this.state.nodes)) {
      if (node.type !== 'terminal') continue

      // Backward compat: remove old waitingForUser key if present in persisted state
      if ('waitingForUser' in node) {
        delete (node as any).waitingForUser
      }

      if (node.claudeStatusUnread === undefined) {
        (node as any).claudeStatusUnread = false
      }

      if (node.claudeStatusAsleep === undefined) {
        (node as any).claudeStatusAsleep = false
      }

      // End current terminal session if still open
      if (node.alive) {
        const currentSession = node.terminalSessions[node.terminalSessions.length - 1]
        if (currentSession && !currentSession.endedAt) {
          currentSession.endedAt = new Date().toISOString()
        }
      }

      const wasAlive = node.alive
      node.alive = false
      node.claudeState = node.claudeState === 'stuck' ? 'stopped' : node.claudeState
      node.claudeStatusUnread = false

      const history = node.claudeSessionHistory ?? []
      const latestClaude = history.length > 0 ? history[history.length - 1].claudeSessionId : undefined

      console.log(`[startup] Terminal ${node.id.slice(0, 8)} wasAlive=${wasAlive} claudeSession=${latestClaude?.slice(0, 8) ?? 'none'}`)

      deadList.push({ nodeId: node.id, claudeSessionId: latestClaude, cwd: node.cwd, extraCliArgs: node.extraCliArgs })
    }

    persistNow(this.state)
    return deadList
  }

  /**
   * Archive a specific terminal node (public wrapper for archiveNode).
   */
  archiveTerminal(nodeId: string): void {
    this.archiveNode(nodeId)
  }

  /** Mark a node as mid-restart so terminalExited skips archival. */
  markRestarting(nodeId: string): void {
    this.restartingNodes.add(nodeId)
    console.log(`[restart] Marking node ${nodeId.slice(0, 8)} as restarting`)
  }

  /** Mark a node as spawned by startup revival.  If the PTY exits,
   *  terminalExited will leave it as a dead remnant instead of archiving. */
  markReviving(nodeId: string): void {
    this.revivingNodes.add(nodeId)
  }

  /** Clear the reviving flag (called once the PTY is confirmed stable). */
  clearReviving(nodeId: string): void {
    this.revivingNodes.delete(nodeId)
  }

  /** Check if a node was spawned by startup revival and is still in the protection window. */
  isReviving(nodeId: string): boolean {
    return this.revivingNodes.has(nodeId)
  }

  /** Update extra CLI args on a terminal node, broadcast, and persist. */
  updateExtraCliArgs(nodeId: string, extraCliArgs: string): void {
    const node = this.state.nodes[nodeId]
    if (!node || node.type !== 'terminal') return
    node.extraCliArgs = extraCliArgs
    this.onNodeUpdate(nodeId, { extraCliArgs: node.extraCliArgs } as Partial<TerminalNodeData>)
    this.schedulePersist()
  }

  getState(): ServerState {
    return this.state
  }

  getNode(id: string): NodeData | undefined {
    return this.state.nodes[id]
  }

  // --- Terminal lifecycle ---

  /**
   * Create a terminal node for a newly spawned PTY session.
   */
  createTerminal(
    sessionId: string,
    parentId: string,
    x: number,
    y: number,
    cols: number,
    rows: number,
    cwd?: string,
    initialTitleHistory?: string[],
    name?: string,
    insertAfterNodeId?: string
  ): TerminalNodeData {
    const zIndex = this.state.nextZIndex++
    const now = new Date().toISOString()
    const seedHistory = initialTitleHistory ?? []
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
            node.sortOrder += 1
            this.onNodeUpdate(node.id, { sortOrder: node.sortOrder } as Partial<TerminalNodeData>)
          }
        }
        sortOrder = sourceSortOrder + 1
      } else {
        sortOrder = this.nextSortOrder()
      }
    } else {
      sortOrder = this.nextSortOrder()
    }

    const node: TerminalNodeData = {
      id: sessionId,
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
      ...(name ? { name } : {})
    }

    this.state.nodes[sessionId] = node
    this.sessionToNodeId.set(sessionId, sessionId)
    this.onNodeAdd(node)
    this.schedulePersist()
    return node
  }

  /** Resolve a PTY session ID to its terminal node. */
  private getTerminalBySession(ptySessionId: string): TerminalNodeData | undefined {
    const nodeId = this.sessionToNodeId.get(ptySessionId)
    if (!nodeId) return undefined
    const node = this.state.nodes[nodeId]
    if (!node || node.type !== 'terminal') return undefined
    return node
  }

  /** Get the node ID for a PTY session ID. */
  getNodeIdForSession(ptySessionId: string): string | undefined {
    return this.sessionToNodeId.get(ptySessionId)
  }

  /**
   * Handle terminal PTY exit: update metadata then immediately archive.
   */
  terminalExited(ptySessionId: string, exitCode: number): void {
    const node = this.getTerminalBySession(ptySessionId)
    if (!node) return

    // If the node is mid-restart, skip archival — the new PTY is already running
    if (this.restartingNodes.has(node.id)) {
      console.log(`[restart] terminalExited session=${ptySessionId.slice(0, 8)} node=${node.id.slice(0, 8)} exitCode=${exitCode} — skipping archival (mid-restart)`)
      this.sessionToNodeId.delete(ptySessionId)
      this.restartingNodes.delete(node.id)
      return
    }

    // If spawned by startup revival, leave as dead remnant so the user can retry
    const isReviving = this.revivingNodes.has(node.id)
    if (isReviving) this.revivingNodes.delete(node.id)

    console.log(`[exit] terminalExited session=${ptySessionId.slice(0, 8)} node=${node.id.slice(0, 8)} exitCode=${exitCode} — ${isReviving ? 'keeping as remnant (revival)' : 'archiving'}`)

    node.alive = false
    node.exitCode = exitCode
    node.claudeState = 'stopped'

    // End the current terminal session
    const currentSession = node.terminalSessions[node.terminalSessions.length - 1]
    if (currentSession && !currentSession.endedAt) {
      currentSession.endedAt = new Date().toISOString()
    }

    this.sessionToNodeId.delete(ptySessionId)

    if (isReviving) {
      // Keep as dead remnant — the surface stays visible and can be manually restarted
      this.onNodeUpdate(node.id, { alive: false, exitCode, claudeState: 'stopped' } as Partial<TerminalNodeData>)
      this.schedulePersist()
    } else {
      this.archiveNode(node.id)
    }
  }

  /**
   * Reincarnate a dead terminal (remnant → alive).
   * Called when a new PTY is spawned for an existing remnant node.
   * @param nodeId - The node ID of the remnant
   * @param newPtySessionId - The new PTY session ID from SessionManager
   */
  reincarnateTerminal(nodeId: string, newPtySessionId: string, cols: number, rows: number): void {
    const node = this.state.nodes[nodeId]
    if (!node || node.type !== 'terminal') return
    console.log(`[restart] Reincarnated node ${nodeId.slice(0, 8)} → session ${newPtySessionId.slice(0, 8)}`)

    node.alive = true
    node.sessionId = newPtySessionId
    node.cols = cols
    node.rows = rows
    node.exitCode = undefined
    node.claudeState = 'stopped'
    node.claudeStatusUnread = false

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
    this.onNodeUpdate(nodeId, {
      alive: true,
      sessionId: newPtySessionId,
      cols,
      rows,
      exitCode: undefined,
      claudeState: 'stopped',
      claudeStatusUnread: false
    } as Partial<TerminalNodeData>)
    this.schedulePersist()
  }

  // --- Node mutations ---

  moveNode(nodeId: string, x: number, y: number): void {
    const node = this.state.nodes[nodeId]
    if (!node) return
    node.x = x
    node.y = y
    this.onNodeUpdate(nodeId, { x, y })
    this.schedulePersist()
  }

  batchMoveNodes(moves: Array<{ nodeId: string; x: number; y: number }>): void {
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

  renameNode(nodeId: string, name: string): void {
    const node = this.state.nodes[nodeId]
    if (!node) return
    node.name = name || null
    this.onNodeUpdate(nodeId, { name: node.name })
    this.schedulePersist()
  }

  setNodeColor(nodeId: string, colorPresetId: string): void {
    const node = this.state.nodes[nodeId]
    if (!node) return
    node.colorPresetId = colorPresetId
    this.onNodeUpdate(nodeId, { colorPresetId })
    this.schedulePersist()
  }

  reorderCrabs(orderedIds: string[]): void {
    for (let i = 0; i < orderedIds.length; i++) {
      const node = this.state.nodes[orderedIds[i]]
      if (!node || node.type !== 'terminal') continue
      if (node.sortOrder !== i) {
        node.sortOrder = i
        this.onNodeUpdate(orderedIds[i], { sortOrder: i } as Partial<TerminalNodeData>)
      }
    }
    this.schedulePersist()
  }

  bringToFront(nodeId: string): void {
    const node = this.state.nodes[nodeId]
    if (!node) return
    node.zIndex = this.state.nextZIndex++
    node.lastFocusedAt = new Date().toISOString()
    this.onNodeUpdate(nodeId, { zIndex: node.zIndex, lastFocusedAt: node.lastFocusedAt })
    this.schedulePersist()
  }

  reparentNode(nodeId: string, newParentId: string): void {
    const node = this.state.nodes[nodeId]
    if (!node) return
    node.parentId = newParentId
    this.onNodeUpdate(nodeId, { parentId: newParentId })
    this.schedulePersist()
    // Recheck cwd-mismatch alerts for the reparented subtree
    this.recheckDescendantCwdAlerts(nodeId)
  }

  /**
   * Archive a node: snapshot into parent's archivedChildren, reparent children, remove node.
   */
  archiveNode(nodeId: string): void {
    const node = this.state.nodes[nodeId]
    if (!node) return
    console.log(`[archive] Archiving node ${nodeId.slice(0, 8)}`)

    const parentId = node.parentId

    // Clean up session-to-node mapping if this is a live terminal
    if (node.type === 'terminal' && node.alive) {
      this.sessionToNodeId.delete(node.sessionId)
    }

    // Only snapshot into archive if the node has meaningful content
    if (!isDisposable(node)) {
      const snapshot = {
        archivedAt: new Date().toISOString(),
        data: JSON.parse(JSON.stringify(node)) // deep copy
      }
      if (parentId === 'root') {
        this.state.rootArchivedChildren.push(snapshot)
        this.onNodeUpdate('root', { archivedChildren: this.state.rootArchivedChildren } as Partial<NodeData>)
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
   * Read archived node data without modifying state.
   */
  peekArchivedNode(parentNodeId: string, archivedNodeId: string): NodeData | undefined {
    let archiveArray: import('../shared/state').ArchivedNode[]
    if (parentNodeId === 'root') {
      archiveArray = this.state.rootArchivedChildren
    } else {
      const parent = this.state.nodes[parentNodeId]
      if (!parent) return undefined
      archiveArray = parent.archivedChildren
    }
    const entry = archiveArray.find(e => e.data.id === archivedNodeId)
    return entry ? entry.data : undefined
  }

  /**
   * Unarchive a node: restore from parent's archivedChildren back into the node tree.
   */
  unarchiveNode(parentNodeId: string, archivedNodeId: string, positionOverride?: { x: number; y: number }): void {
    // Find the archive array
    let archiveArray: import('../shared/state').ArchivedNode[]
    if (parentNodeId === 'root') {
      archiveArray = this.state.rootArchivedChildren
    } else {
      const parent = this.state.nodes[parentNodeId]
      if (!parent) return
      archiveArray = parent.archivedChildren
    }

    // Find and remove the archived entry
    const idx = archiveArray.findIndex(e => e.data.id === archivedNodeId)
    if (idx === -1) return
    const entry = archiveArray[idx]
    archiveArray.splice(idx, 1)

    // Restore node data
    const restoredNode = JSON.parse(JSON.stringify(entry.data)) as import('../shared/state').NodeData
    restoredNode.zIndex = this.state.nextZIndex++
    restoredNode.parentId = parentNodeId
    restoredNode.archivedChildren = []

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

    // Broadcast updated archivedChildren on the parent
    if (parentNodeId === 'root') {
      this.onNodeUpdate('root', { archivedChildren: this.state.rootArchivedChildren } as Partial<NodeData>)
    } else {
      const parent = this.state.nodes[parentNodeId]
      if (parent) {
        this.onNodeUpdate(parentNodeId, { archivedChildren: parent.archivedChildren })
      }
    }

    this.schedulePersist()
  }

  /**
   * Delete an archived node entry permanently.
   */
  deleteArchivedNode(parentNodeId: string, archivedNodeId: string): void {
    let archiveArray: import('../shared/state').ArchivedNode[]
    if (parentNodeId === 'root') {
      archiveArray = this.state.rootArchivedChildren
    } else {
      const parent = this.state.nodes[parentNodeId]
      if (!parent) return
      archiveArray = parent.archivedChildren
    }

    const idx = archiveArray.findIndex(e => e.data.id === archivedNodeId)
    if (idx === -1) return
    archiveArray.splice(idx, 1)

    // Broadcast updated archivedChildren on the parent
    if (parentNodeId === 'root') {
      this.onNodeUpdate('root', { archivedChildren: this.state.rootArchivedChildren } as Partial<NodeData>)
    } else {
      const parent = this.state.nodes[parentNodeId]
      if (parent) {
        this.onNodeUpdate(parentNodeId, { archivedChildren: parent.archivedChildren })
      }
    }

    this.schedulePersist()
  }

  // --- Undo buffer ---

  pushUndoEntry(entry: import('../shared/undo-types').UndoEntry): void {
    this.state.undoBuffer.push(entry)
    if (this.state.undoBuffer.length > 100) this.state.undoBuffer.shift()
    this.schedulePersist()
  }

  popUndoEntry(): import('../shared/undo-types').UndoEntry | null {
    if (this.state.undoBuffer.length === 0) return null
    const entry = this.state.undoBuffer.pop()!
    this.schedulePersist()
    return entry
  }

  // --- Terminal metadata updates (from SessionManager callbacks) ---

  updateTerminalSize(ptySessionId: string, cols: number, rows: number): void {
    const node = this.getTerminalBySession(ptySessionId)
    if (!node) return
    node.cols = cols
    node.rows = rows
    this.onNodeUpdate(node.id, { cols, rows } as Partial<TerminalNodeData>)
    this.schedulePersist()
  }

  updateCwd(ptySessionId: string, cwd: string): void {
    const node = this.getTerminalBySession(ptySessionId)
    if (!node) return
    node.cwd = cwd
    this.onNodeUpdate(node.id, { cwd } as Partial<TerminalNodeData>)
    this.schedulePersist()
    // Check self + descendants for cwd-mismatch alerts
    this.checkCwdMismatchAlert(node)
    this.recheckDescendantCwdAlerts(node.id)
  }

  updateShellTitleHistory(ptySessionId: string, history: string[]): void {
    const node = this.getTerminalBySession(ptySessionId)
    if (!node) return
    node.shellTitleHistory = history

    // Also update the current terminal session's title history
    const currentSession = node.terminalSessions[node.terminalSessions.length - 1]
    if (currentSession) {
      currentSession.shellTitleHistory = [...history]
    }

    this.onNodeUpdate(node.id, { shellTitleHistory: history } as Partial<TerminalNodeData>)
    this.schedulePersist()
  }

  updateClaudeSessionHistory(ptySessionId: string, history: ClaudeSessionEntry[]): void {
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

    this.onNodeUpdate(node.id, { claudeSessionHistory: history } as Partial<TerminalNodeData>)
    this.schedulePersist()
  }

  updateClaudeState(ptySessionId: string, state: import('../shared/state').ClaudeState): void {
    const node = this.getTerminalBySession(ptySessionId)
    if (!node) return
    node.claudeState = state
    this.onNodeUpdate(node.id, { claudeState: state } as Partial<TerminalNodeData>)
    this.schedulePersist()
  }

  updateClaudeModel(ptySessionId: string, model: string): void {
    const node = this.getTerminalBySession(ptySessionId)
    if (!node || node.claudeModel === model) return
    node.claudeModel = model
    this.onNodeUpdate(node.id, { claudeModel: model } as Partial<TerminalNodeData>)
    this.schedulePersist()
  }

  updateClaudeStateDecisionTime(ptySessionId: string, timestamp: number): void {
    const node = this.getTerminalBySession(ptySessionId)
    if (!node) return
    node.claudeStateDecidedAt = timestamp
    this.onNodeUpdate(node.id, { claudeStateDecidedAt: timestamp } as Partial<TerminalNodeData>)
    this.schedulePersist()
  }

  updateClaudeStatusUnread(ptySessionId: string, unread: boolean): void {
    const node = this.getTerminalBySession(ptySessionId)
    if (!node) return
    node.claudeStatusUnread = unread
    this.onNodeUpdate(node.id, { claudeStatusUnread: unread } as Partial<TerminalNodeData>)
    this.schedulePersist()
  }

  updateClaudeStatusAsleep(ptySessionId: string, asleep: boolean): void {
    const node = this.getTerminalBySession(ptySessionId)
    if (!node) return
    node.claudeStatusAsleep = asleep
    this.onNodeUpdate(node.id, { claudeStatusAsleep: asleep } as Partial<TerminalNodeData>)
    this.schedulePersist()
  }

  updateLastInteracted(ptySessionId: string, timestamp: number): void {
    const node = this.getTerminalBySession(ptySessionId)
    if (!node) return
    const prevMinute = node.lastInteractedAt ? Math.floor(node.lastInteractedAt / 60000) : -1
    const curMinute = Math.floor(timestamp / 60000)
    node.lastInteractedAt = timestamp
    // Only broadcast when the displayed minute value changes (or on first activity)
    if (curMinute !== prevMinute) {
      this.onNodeUpdate(node.id, { lastInteractedAt: timestamp } as Partial<TerminalNodeData>)
    }
    this.schedulePersist()
  }

  // --- Directory operations ---

  createDirectory(parentId: string, x: number, y: number, cwd: string): DirectoryNodeData {
    const home = homedir()
    if (cwd === home) {
      cwd = '~'
    } else if (cwd.startsWith(home + '/')) {
      cwd = '~' + cwd.slice(home.length)
    }

    const id = randomUUID()
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

  updateDirectoryCwd(nodeId: string, cwd: string): void {
    const node = this.state.nodes[nodeId]
    if (!node || node.type !== 'directory') return
    node.cwd = cwd
    this.onNodeUpdate(nodeId, { cwd } as Partial<DirectoryNodeData>)
    this.schedulePersist()
    // Recheck cwd-mismatch alerts for descendants whose ancestor cwd changed
    this.recheckDescendantCwdAlerts(nodeId)
  }

  updateDirectoryGitStatus(nodeId: string, gitStatus: GitStatus | null): void {
    const node = this.state.nodes[nodeId]
    if (!node || node.type !== 'directory') return
    node.gitStatus = gitStatus
    this.onNodeUpdate(nodeId, { gitStatus } as Partial<DirectoryNodeData>)
    // Don't persist — ephemeral data, same pattern as updateClaudeState
  }

  getDirectoryNodes(): DirectoryNodeData[] {
    return Object.values(this.state.nodes).filter(
      (n): n is DirectoryNodeData => n.type === 'directory'
    )
  }

  // --- File operations ---

  createFile(parentId: string, x: number, y: number, filePath: string): FileNodeData {
    const id = randomUUID()
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

  updateFilePath(nodeId: string, filePath: string): void {
    const node = this.state.nodes[nodeId]
    if (!node || node.type !== 'file') return
    node.filePath = filePath
    this.onNodeUpdate(nodeId, { filePath } as Partial<FileNodeData>)
    this.schedulePersist()
  }

  // --- Markdown operations ---

  createMarkdown(parentId: string, x: number, y: number, content?: string, fileBacked?: boolean): MarkdownNodeData {
    const id = randomUUID()
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

  resizeMarkdown(nodeId: string, width: number, height: number): void {
    const node = this.state.nodes[nodeId]
    if (!node || node.type !== 'markdown') return
    node.width = width
    node.height = height
    this.onNodeUpdate(nodeId, { width, height } as Partial<MarkdownNodeData>)
    this.schedulePersist()
  }

  updateMarkdownContent(nodeId: string, content: string): void {
    const node = this.state.nodes[nodeId]
    if (!node || node.type !== 'markdown') return
    node.content = content
    this.onNodeUpdate(nodeId, { content } as Partial<MarkdownNodeData>)
    this.schedulePersist()
  }

  setMarkdownMaxWidth(nodeId: string, maxWidth: number): void {
    const node = this.state.nodes[nodeId]
    if (!node || node.type !== 'markdown') return
    node.maxWidth = maxWidth
    this.onNodeUpdate(nodeId, { maxWidth } as Partial<MarkdownNodeData>)
    this.schedulePersist()
  }

  // --- Title operations ---

  createTitle(parentId: string, x: number, y: number, text?: string): TitleNodeData {
    const id = randomUUID()
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

  updateTitleText(nodeId: string, text: string): void {
    const node = this.state.nodes[nodeId]
    if (!node || node.type !== 'title') return
    node.text = text
    this.onNodeUpdate(nodeId, { text } as Partial<TitleNodeData>)
    this.schedulePersist()
  }

  // --- Alerts ---

  /** Normalize a path for comparison: expand ~ and strip trailing slashes. */
  private normalizePath(p: string): string {
    const home = homedir()
    let out = p
    if (out === '~') out = home
    else if (out.startsWith('~/')) out = home + out.slice(1)
    if (out.length > 1 && out.endsWith('/')) out = out.slice(0, -1)
    return out
  }

  /** Abbreviate a path with ~ for the home directory. */
  private abbreviatePath(p: string): string {
    const home = homedir()
    if (p === home) return '~'
    if (p.startsWith(home + '/')) return '~' + p.slice(home.length)
    return p
  }

  /** Scan all existing Claude terminals for cwd-mismatch alerts on startup. */
  private initialAlertScan(): void {
    for (const node of Object.values(this.state.nodes)) {
      if (node.type === 'terminal' && node.claudeSessionHistory.length > 0) {
        this.checkCwdMismatchAlert(node)
      }
    }
  }

  /** Check a single terminal node for cwd-mismatch alert. */
  private checkCwdMismatchAlert(node: TerminalNodeData): void {
    if (node.claudeSessionHistory.length === 0) return
    const parentCwd = getAncestorCwd(this.state.nodes, node.parentId)
    if (!parentCwd || !node.cwd) return

    const normalizedNodeCwd = this.normalizePath(node.cwd)
    const normalizedParentCwd = this.normalizePath(parentCwd)

    const alerts = node.alerts ?? []
    const existingIdx = alerts.findIndex(a => a.type === 'cwd-mismatch')

    if (normalizedNodeCwd !== normalizedParentCwd) {
      // Mismatch detected — add alert if not already present
      if (existingIdx === -1) {
        const message = `Working directory changed to ${this.abbreviatePath(node.cwd)} (parent: ${this.abbreviatePath(parentCwd)})`
        const newAlerts: NodeAlert[] = [...alerts, { type: 'cwd-mismatch', message, timestamp: Date.now() }]
        node.alerts = newAlerts
        this.onNodeUpdate(node.id, { alerts: newAlerts } as Partial<NodeData>)
        this.schedulePersist()
      }
    } else {
      // Match — remove existing cwd-mismatch alert if present
      if (existingIdx !== -1) {
        const newAlerts = alerts.filter(a => a.type !== 'cwd-mismatch')
        node.alerts = newAlerts.length > 0 ? newAlerts : undefined
        this.onNodeUpdate(node.id, { alerts: node.alerts ?? [] } as Partial<NodeData>)
        this.schedulePersist()
      }
    }
  }

  /** BFS descendants of nodeId, calling checkCwdMismatchAlert on every Claude terminal found. */
  recheckDescendantCwdAlerts(nodeId: string): void {
    const queue = [nodeId]
    const visited = new Set<string>()
    while (queue.length > 0) {
      const id = queue.shift()!
      if (visited.has(id)) continue
      visited.add(id)
      const node = this.state.nodes[id]
      if (!node) continue
      if (node.type === 'terminal' && node.claudeSessionHistory.length > 0) {
        this.checkCwdMismatchAlert(node)
      }
      // Enqueue children
      for (const child of Object.values(this.state.nodes)) {
        if (child.parentId === id && !visited.has(child.id)) {
          queue.push(child.id)
        }
      }
    }
  }

  /** Set the alerts-read timestamp on a node. */
  setAlertsReadTimestamp(nodeId: string, timestamp: number): void {
    const node = this.state.nodes[nodeId]
    if (!node) return
    node.alertsReadTimestamp = timestamp
    this.onNodeUpdate(nodeId, { alertsReadTimestamp: timestamp } as Partial<NodeData>)
    this.schedulePersist()
  }

  // --- Persistence ---

  private schedulePersist(): void {
    schedulePersist(this.state)
  }

  /**
   * Immediately persist state. Call on shutdown.
   */
  persistImmediate(): void {
    persistNow(this.state)
  }
}
