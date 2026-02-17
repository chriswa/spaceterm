import { randomUUID } from 'crypto'
import { homedir } from 'os'
import type {
  ServerState,
  NodeData,
  TerminalNodeData,
  MarkdownNodeData,
  DirectoryNodeData,
  FileNodeData,
  TitleNodeData,
  TerminalSessionEntry
} from '../shared/state'
import type { ClaudeSessionEntry } from '../shared/protocol'
import { schedulePersist, persistNow, loadState } from './persistence'
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
      // Dead terminal processing is done by the caller via processDeadTerminals()
    } else {
      this.state = {
        version: STATE_VERSION,
        nextZIndex: 1,
        nodes: {},
        rootArchivedChildren: []
      }
    }
  }

  /**
   * On startup, mark all terminals dead and return info for the caller to decide
   * whether to revive (spawn new PTY) or archive each one.
   */
  processDeadTerminals(): Array<{ nodeId: string; claudeSessionId?: string; cwd?: string }> {
    const deadList: Array<{ nodeId: string; claudeSessionId?: string; cwd?: string }> = []

    for (const node of Object.values(this.state.nodes)) {
      // Backward compat: remove old waitingForUser key if present in persisted state
      if (node.type === 'terminal' && 'waitingForUser' in node) {
        delete (node as any).waitingForUser
      }

      if (node.type === 'terminal' && node.claudeStatusUnread === undefined) {
        (node as any).claudeStatusUnread = false
      }

      if (node.type === 'terminal' && node.alive) {
        node.alive = false
        node.claudeState = 'stopped'
        node.claudeStatusUnread = false

        // End current terminal session
        const currentSession = node.terminalSessions[node.terminalSessions.length - 1]
        if (currentSession && !currentSession.endedAt) {
          currentSession.endedAt = new Date().toISOString()
        }

        // Get most recent Claude session ID if any
        const history = node.claudeSessionHistory ?? []
        const latestClaude = history.length > 0 ? history[history.length - 1].claudeSessionId : undefined

        deadList.push({ nodeId: node.id, claudeSessionId: latestClaude, cwd: node.cwd })
      }
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
    initialTitleHistory?: string[]
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
      terminalSessions: [initialSession],
      claudeSessionHistory: [],
      shellTitleHistory: [...seedHistory],
      archivedChildren: [],
      colorPresetId: 'inherit'
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

    node.alive = false
    node.exitCode = exitCode
    node.claudeState = 'stopped'

    // End the current terminal session
    const currentSession = node.terminalSessions[node.terminalSessions.length - 1]
    if (currentSession && !currentSession.endedAt) {
      currentSession.endedAt = new Date().toISOString()
    }

    this.sessionToNodeId.delete(ptySessionId)

    // Immediately archive instead of leaving as remnant
    this.archiveNode(node.id)
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
    node.name = name || undefined
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

  setNodeFood(nodeId: string, food: boolean): void {
    const node = this.state.nodes[nodeId]
    if (!node || node.type !== 'markdown') return
    node.food = food
    this.onNodeUpdate(nodeId, { food } as Partial<MarkdownNodeData>)
    this.schedulePersist()
  }

  bringToFront(nodeId: string): void {
    const node = this.state.nodes[nodeId]
    if (!node) return
    node.zIndex = this.state.nextZIndex++
    this.onNodeUpdate(nodeId, { zIndex: node.zIndex })
    this.schedulePersist()
  }

  reparentNode(nodeId: string, newParentId: string): void {
    const node = this.state.nodes[nodeId]
    if (!node) return
    node.parentId = newParentId
    this.onNodeUpdate(nodeId, { parentId: newParentId })
    this.schedulePersist()
  }

  /**
   * Archive a node: snapshot into parent's archivedChildren, reparent children, remove node.
   */
  archiveNode(nodeId: string): void {
    const node = this.state.nodes[nodeId]
    if (!node) return

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
    // Don't persist for transient state changes
  }

  updateClaudeStatusUnread(ptySessionId: string, unread: boolean): void {
    const node = this.getTerminalBySession(ptySessionId)
    if (!node) return
    node.claudeStatusUnread = unread
    this.onNodeUpdate(node.id, { claudeStatusUnread: unread } as Partial<TerminalNodeData>)
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
