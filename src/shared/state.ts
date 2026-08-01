import type { ClaudeSessionEntry, CameraBounds } from './protocol'
import type { NodeId, PtySessionId, ClaudeSessionId } from './ids'
import type { AgentType } from './agent-type'
import type { CardType } from './card-types'
import type { UndoEntry } from './undo-types'

// --- Claude state enum ---

export type ClaudeState = 'stopped' | 'working' | 'working_background' | 'waiting_permission' | 'waiting_question' | 'waiting_plan' | 'potential_error'

// --- Terminal session tracking ---

export interface TerminalSessionEntry {
  sessionIndex: number
  startedAt: string
  endedAt?: string
  trigger: 'initial' | 'claude-session-change' | 'claude-exit' | 'reincarnation'
  claudeSessionId?: ClaudeSessionId
  shellTitleHistory: string[]
}

// --- Node alerts ---

export interface NodeAlert {
  type: string
  message: string
  timestamp: number  // epoch ms, set once when first detected
}

// --- Node types (unified terminal/remnant) ---

export interface BaseNodeData {
  id: NodeId
  parentId: NodeId // ROOT_NODE_ID for top-level
  x: number
  y: number
  zIndex: number
  lastFocusedAt?: string // ISO 8601, set by server on bringToFront
  name?: string | null
  colorPresetId?: string
  archivedChildren: ArchivedNode[]
  alerts?: NodeAlert[]
  alertsReadTimestamp?: number  // epoch ms, set by client
}

export interface TerminalNodeData extends BaseNodeData {
  type: 'terminal'
  alive: boolean // true = live PTY, false = remnant
  /** Active PTY session ID. Initially same as node id. Changes on reincarnation. */
  sessionId: PtySessionId
  cols: number
  rows: number
  exitCode?: number // set when alive → false
  cwd?: string
  extraCliArgs?: string
  /** Which agent CLI this surface runs. Absent = plain terminal or legacy Claude (inferred from session history). */
  agentType?: AgentType
  claudeState: ClaudeState
  claudeStateDecidedAt?: number
  claudeStatusUnread: boolean
  claudeStatusAsleep: boolean
  claudeModel?: string
  /** Last-known remaining context %, persisted so it survives a server restart. */
  claudeContextPercent?: number
  /** Last-known Claude session JSONL line count, persisted so it survives a server restart. */
  claudeSessionLineCount?: number
  lastInteractedAt?: number  // epoch ms — max of last PTY input and last PTY output
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

/**
 * Compile-time check that the node union and the CardType registry describe the
 * same set of cards, in both directions. Adding a node type here without adding
 * it to `CARD_TYPES` — or the reverse — is a type error, rather than a card
 * that places at `undefined × undefined` or a menu entry that creates nothing.
 *
 * The constraint has to sit on a type *parameter* to bite: a conditional type
 * that evaluates to `never` is still a perfectly legal type and reports
 * nothing. Two one-way assertions rather than one mutual constraint, which
 * TypeScript rejects as circular.
 */
type Assignable<Sub extends Super, Super> = Sub
type _EveryNodeTypeIsACardType = Assignable<NodeData['type'], CardType>
type _EveryCardTypeIsANodeType = Assignable<CardType, NodeData['type']>

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
  undoBuffer: UndoEntry[]
  undoCursor: number
  /** Numbered viewport bookmarks (slot '0'..'9' -> canvas-space camera bounds), shared across clients. */
  savedViewports: Record<string, CameraBounds>
}
