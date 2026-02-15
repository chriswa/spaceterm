import { join } from 'path'
import { homedir } from 'os'

export const SOCKET_DIR = join(homedir(), '.spaceterm')
export const SOCKET_PATH = join(SOCKET_DIR, 'spaceterm.sock')
export const HOOK_LOG_DIR = join(SOCKET_DIR, 'hook-logs')

export interface SessionInfo {
  sessionId: string
  cols: number
  rows: number
}

// --- Client → Server messages ---

export interface CreateOptions {
  cwd?: string
  command?: string
  args?: string[]
}

export interface CreateMessage {
  type: 'create'
  seq: number
  options?: CreateOptions
}

export interface ListMessage {
  type: 'list'
  seq: number
}

export interface AttachMessage {
  type: 'attach'
  seq: number
  sessionId: string
}

export interface DetachMessage {
  type: 'detach'
  seq: number
  sessionId: string
}

export interface DestroyMessage {
  type: 'destroy'
  seq: number
  sessionId: string
}

export interface WriteMessage {
  type: 'write'
  sessionId: string
  data: string
}

export interface ResizeMessage {
  type: 'resize'
  sessionId: string
  cols: number
  rows: number
}

export interface HookMessage {
  type: 'hook'
  surfaceId: string
  payload: Record<string, unknown>
}

// --- Client → Server node mutation messages ---

export interface NodeSyncRequestMessage {
  type: 'node-sync-request'
  seq: number
}

export interface NodeMoveMessage {
  type: 'node-move'
  seq: number
  nodeId: string
  x: number
  y: number
}

export interface NodeBatchMoveMessage {
  type: 'node-batch-move'
  seq: number
  moves: Array<{ nodeId: string; x: number; y: number }>
}

export interface NodeRenameMessage {
  type: 'node-rename'
  seq: number
  nodeId: string
  name: string
}

export interface NodeSetColorMessage {
  type: 'node-set-color'
  seq: number
  nodeId: string
  colorPresetId: string
}

export interface NodeArchiveMessage {
  type: 'node-archive'
  seq: number
  nodeId: string
}

export interface NodeUnarchiveMessage {
  type: 'node-unarchive'
  seq: number
  parentNodeId: string
  archivedNodeId: string
}

export interface NodeArchiveDeleteMessage {
  type: 'node-archive-delete'
  seq: number
  parentNodeId: string
  archivedNodeId: string
}

export interface NodeBringToFrontMessage {
  type: 'node-bring-to-front'
  seq: number
  nodeId: string
}

export interface NodeReparentMessage {
  type: 'node-reparent'
  seq: number
  nodeId: string
  newParentId: string
}

export interface TerminalCreateMessage {
  type: 'terminal-create'
  seq: number
  parentId: string
  x: number
  y: number
  options?: CreateOptions
  initialTitleHistory?: string[]
}

export interface TerminalResizeMessage {
  type: 'terminal-resize'
  seq: number
  nodeId: string
  cols: number
  rows: number
}

export interface MarkdownAddMessage {
  type: 'markdown-add'
  seq: number
  parentId: string
  x: number
  y: number
}

export interface MarkdownResizeMessage {
  type: 'markdown-resize'
  seq: number
  nodeId: string
  width: number
  height: number
}

export interface MarkdownContentMessage {
  type: 'markdown-content'
  seq: number
  nodeId: string
  content: string
}

export interface TerminalReincarnateMessage {
  type: 'terminal-reincarnate'
  seq: number
  nodeId: string
  options?: CreateOptions
}

export interface SetTerminalModeMessage {
  type: 'set-terminal-mode'
  sessionId: string
  mode: 'live' | 'snapshot'
}

export type ClientMessage =
  | CreateMessage
  | ListMessage
  | AttachMessage
  | DetachMessage
  | DestroyMessage
  | WriteMessage
  | ResizeMessage
  | HookMessage
  | NodeSyncRequestMessage
  | NodeMoveMessage
  | NodeBatchMoveMessage
  | NodeRenameMessage
  | NodeSetColorMessage
  | NodeArchiveMessage
  | NodeUnarchiveMessage
  | NodeArchiveDeleteMessage
  | NodeBringToFrontMessage
  | NodeReparentMessage
  | TerminalCreateMessage
  | TerminalResizeMessage
  | MarkdownAddMessage
  | MarkdownResizeMessage
  | MarkdownContentMessage
  | TerminalReincarnateMessage
  | SetTerminalModeMessage

// --- Server → Client messages ---

export interface CreatedMessage {
  type: 'created'
  seq: number
  sessionId: string
  cols: number
  rows: number
}

export interface ListedMessage {
  type: 'listed'
  seq: number
  sessions: SessionInfo[]
}

export interface ClaudeSessionEntry {
  claudeSessionId: string
  reason: 'startup' | 'fork' | 'clear' | 'compact' | 'resume'
  timestamp: string
}

export interface AttachedMessage {
  type: 'attached'
  seq: number
  sessionId: string
  scrollback: string
  shellTitleHistory?: string[]
  cwd?: string
  claudeSessionHistory?: ClaudeSessionEntry[]
  claudeState?: import('./state').ClaudeState
}

export interface DetachedMessage {
  type: 'detached'
  seq: number
  sessionId: string
}

export interface DestroyedMessage {
  type: 'destroyed'
  seq: number
}

export interface DataMessage {
  type: 'data'
  sessionId: string
  data: string
}

export interface ExitMessage {
  type: 'exit'
  sessionId: string
  exitCode: number
}

export interface ShellTitleHistoryMessage {
  type: 'shell-title-history'
  sessionId: string
  history: string[]
}

export interface CwdMessage {
  type: 'cwd'
  sessionId: string
  cwd: string
}

export interface ClaudeSessionHistoryMessage {
  type: 'claude-session-history'
  sessionId: string
  history: ClaudeSessionEntry[]
}

export interface ClaudeStateMessage {
  type: 'claude-state'
  sessionId: string
  state: import('./state').ClaudeState
}

// --- Server → Client node state messages ---

import type { ServerState, NodeData } from './state'

export interface SyncStateMessage {
  type: 'sync-state'
  seq: number
  state: ServerState
}

export interface NodeUpdatedMessage {
  type: 'node-updated'
  nodeId: string
  fields: Partial<NodeData>
}

export interface NodeAddedMessage {
  type: 'node-added'
  node: NodeData
}

export interface NodeRemovedMessage {
  type: 'node-removed'
  nodeId: string
}

export interface MutationAckMessage {
  type: 'mutation-ack'
  seq: number
}

// --- Snapshot types ---

/** A single run of characters with the same attributes */
export interface AttrSpan {
  text: string
  fg: string  // hex color
  bg: string  // hex color
  bold?: boolean
  italic?: boolean
  underline?: boolean
}

/** One row of the terminal snapshot */
export type SnapshotRow = AttrSpan[]

export interface SnapshotMessage {
  type: 'snapshot'
  sessionId: string
  cols: number
  rows: number
  cursorX: number
  cursorY: number
  lines: SnapshotRow[]
}

export type ServerMessage =
  | CreatedMessage
  | ListedMessage
  | AttachedMessage
  | DetachedMessage
  | DestroyedMessage
  | DataMessage
  | ExitMessage
  | ShellTitleHistoryMessage
  | CwdMessage
  | ClaudeSessionHistoryMessage
  | ClaudeStateMessage
  | SyncStateMessage
  | NodeUpdatedMessage
  | NodeAddedMessage
  | NodeRemovedMessage
  | MutationAckMessage
  | SnapshotMessage
