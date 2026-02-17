import type { ClaudeSessionEntry } from './protocol'

// --- Claude state enum ---

export type ClaudeState = 'stopped' | 'working' | 'waiting_permission' | 'waiting_plan'

// --- Terminal session tracking ---

export interface TerminalSessionEntry {
  sessionIndex: number
  startedAt: string
  endedAt?: string
  trigger: 'initial' | 'claude-session-change' | 'claude-exit' | 'reincarnation'
  claudeSessionId?: string
  shellTitleHistory: string[]
}

// --- Node types (unified terminal/remnant) ---

export interface BaseNodeData {
  id: string
  parentId: string // 'root' for top-level
  x: number
  y: number
  zIndex: number
  name?: string
  colorPresetId?: string
  archivedChildren: ArchivedNode[]
}

export interface TerminalNodeData extends BaseNodeData {
  type: 'terminal'
  alive: boolean // true = live PTY, false = remnant
  /** Active PTY session ID. Initially same as node id. Changes on reincarnation. */
  sessionId: string
  cols: number
  rows: number
  exitCode?: number // set when alive → false
  cwd?: string
  claudeState: ClaudeState
  claudeStatusUnread: boolean
  terminalSessions: TerminalSessionEntry[]
  /** Legacy field — kept for backward compat with existing client code during migration */
  claudeSessionHistory: ClaudeSessionEntry[]
  shellTitleHistory: string[]
}

export interface MarkdownNodeData extends BaseNodeData {
  type: 'markdown'
  width: number
  height: number
  content: string
  maxWidth?: number
  food?: boolean
  fileBacked?: boolean  // true = content lives on disk, set permanently at creation
}

export interface DirectoryNodeData extends BaseNodeData {
  type: 'directory'
  cwd: string
}

export interface FileNodeData extends BaseNodeData {
  type: 'file'
  filePath: string  // raw user input — may be relative, absolute, or ~-prefixed
}

export type NodeData = TerminalNodeData | MarkdownNodeData | DirectoryNodeData | FileNodeData

// --- Archived nodes ---

export interface ArchivedNode {
  archivedAt: string
  data: NodeData
}

// --- Server state ---

export interface ServerState {
  version: number
  nextZIndex: number
  nodes: Record<string, NodeData>
  rootArchivedChildren: ArchivedNode[]
}
