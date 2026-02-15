import { randomUUID } from 'crypto'
import type {
  ServerState,
  NodeData,
  TerminalNodeData,
  MarkdownNodeData,
  TerminalSessionEntry
} from '../shared/state'
import type { ClaudeSessionEntry } from '../shared/protocol'
import { schedulePersist, persistNow, loadState } from './persistence'

const STATE_VERSION = 1
const MARKDOWN_DEFAULT_WIDTH = 400
const MARKDOWN_DEFAULT_HEIGHT = 300

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
      this.markAllTerminalsDead()
    } else {
      this.state = {
        version: STATE_VERSION,
        nextZIndex: 1,
        nodes: {}
      }
    }
  }

  /**
   * On startup, all terminals become remnants since PTY processes are gone.
   */
  private markAllTerminalsDead(): void {
    for (const node of Object.values(this.state.nodes)) {
      if (node.type === 'terminal' && node.alive) {
        node.alive = false
        node.waitingForUser = false
      }
    }
    persistNow(this.state)
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
    cwd?: string
  ): TerminalNodeData {
    const zIndex = this.state.nextZIndex++
    const now = new Date().toISOString()
    const initialSession: TerminalSessionEntry = {
      sessionIndex: 0,
      startedAt: now,
      trigger: 'initial',
      shellTitleHistory: []
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
      waitingForUser: false,
      terminalSessions: [initialSession],
      claudeSessionHistory: [],
      shellTitleHistory: [],
      archivedChildren: [],
      colorPresetId: 'default'
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
   * Mark a terminal as dead (remnant) when its PTY exits.
   */
  terminalExited(ptySessionId: string, exitCode: number): void {
    const node = this.getTerminalBySession(ptySessionId)
    if (!node) return

    node.alive = false
    node.exitCode = exitCode
    node.waitingForUser = false

    // End the current terminal session
    const currentSession = node.terminalSessions[node.terminalSessions.length - 1]
    if (currentSession && !currentSession.endedAt) {
      currentSession.endedAt = new Date().toISOString()
    }

    this.sessionToNodeId.delete(ptySessionId)
    this.onNodeUpdate(node.id, { alive: false, exitCode, waitingForUser: false } as Partial<TerminalNodeData>)
    persistNow(this.state)
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
    node.waitingForUser = false

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
      waitingForUser: false
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

    // Snapshot node into parent's archivedChildren (or discard if parent is root)
    if (parentId !== 'root') {
      const parent = this.state.nodes[parentId]
      if (parent) {
        parent.archivedChildren.push({
          archivedAt: new Date().toISOString(),
          data: JSON.parse(JSON.stringify(node)) // deep copy
        })
        this.onNodeUpdate(parentId, { archivedChildren: parent.archivedChildren })
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

  updateWaitingForUser(ptySessionId: string, waiting: boolean): void {
    const node = this.getTerminalBySession(ptySessionId)
    if (!node) return
    node.waitingForUser = waiting
    this.onNodeUpdate(node.id, { waitingForUser: waiting } as Partial<TerminalNodeData>)
    // Don't persist for transient waiting state changes
  }

  // --- Markdown operations ---

  createMarkdown(parentId: string, x: number, y: number): MarkdownNodeData {
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
      content: '',
      archivedChildren: [],
      colorPresetId: 'default'
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
