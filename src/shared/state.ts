import type { ClaudeSessionEntry } from './protocol'

// --- Claude state enum ---

export type ClaudeState = 'stopped' | 'working' | 'waiting_permission' | 'waiting_question' | 'waiting_plan' | 'stuck'

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
  name?: string | null
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
  extraCliArgs?: string
  claudeSwapProfile?: string
  claudeState: ClaudeState
  claudeStateDecidedAt?: number
  claudeStatusUnread: boolean
  claudeModel?: string
  sortOrder: number
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
  fileBacked?: boolean  // true = content lives on disk, set permanently at creation
}

export interface GitStatus {
  branch: string | null        // null = detached HEAD
  upstream: string | null      // e.g. "origin/main"
  ahead: number
  behind: number
  conflicts: number
  staged: number               // total staged changes
  unstaged: number             // total unstaged modifications + deletions
  untracked: number
  lastFetchTimestamp: number | null  // epoch ms from FETCH_HEAD mtime
}

export interface DirectoryNodeData extends BaseNodeData {
  type: 'directory'
  cwd: string
  gitStatus?: GitStatus | null  // undefined=not polled yet, null=not a git repo
}

export interface FileNodeData extends BaseNodeData {
  type: 'file'
  filePath: string  // raw user input — may be relative, absolute, or ~-prefixed
}

export interface TitleNodeData extends BaseNodeData {
  type: 'title'
  text: string
}

export type NodeData = TerminalNodeData | MarkdownNodeData | DirectoryNodeData | FileNodeData | TitleNodeData

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
