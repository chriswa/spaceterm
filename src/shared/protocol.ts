import { join } from 'path'
import { homedir } from 'os'

/** Sound names available for the play-sound MCP tool. */
export const SOUND_NAMES = ['done', 'error'] as const
export type SoundName = (typeof SOUND_NAMES)[number]

export const SOCKET_DIR = process.env.SPACETERM_HOME ?? join(homedir(), '.spaceterm')
/** Bidirectional socket for Electron client ↔ server communication. */
export const SOCKET_PATH = join(SOCKET_DIR, 'bidirectional.sock')
/** Ingest-only socket for fire-and-forget messages (hooks, status-line, MCP tools). */
export const HOOKS_SOCKET_PATH = join(SOCKET_DIR, 'hooks.sock')
/** Request/response socket for scripts running inside PTYs. */
export const SCRIPTS_SOCKET_PATH = join(SOCKET_DIR, 'scripts.sock')
/** Unix socket for the persistent PTY daemon. */
export const DAEMON_SOCKET_PATH = join(SOCKET_DIR, 'pty-daemon.sock')
export const HOOK_LOG_DIR = join(SOCKET_DIR, 'hook-logs')
export const DECISION_LOG_DIR = join(SOCKET_DIR, 'decision-logs')

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
  claude?: { prompt?: string; resumeSessionId?: string; appendSystemPrompt?: boolean }
  /** Stable node ID for SPACETERM_NODE_ID env var. Used during reincarnation when nodeId !== sessionId. */
  nodeId?: string
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
  ts?: number          // epoch ms — when hook event fired (added by hook-handler.sh)
  payload: Record<string, unknown>
}

export interface StatusLineMessage {
  type: 'status-line'
  surfaceId: string
  payload: Record<string, unknown>
}

export interface EmitMarkdownMessage {
  type: 'emit-markdown'
  surfaceId: string
  content: string
}

export interface SpawnClaudeSurfaceMessage {
  type: 'spawn-claude-surface'
  surfaceId: string
  prompt: string
  title: string
}

export interface SpacetermBroadcastMessage {
  type: 'spaceterm-broadcast'
  surfaceId: string
  content: string
}

export interface PlaySoundMessage {
  type: 'play-sound'
  surfaceId: string
  sound: SoundName
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

export interface UndoBufferPushMessage {
  type: 'undo-buffer-push'
  seq: number
  entry: import('./undo-types').UndoEntry
}

export interface UndoBufferSetCursorMessage {
  type: 'undo-buffer-set-cursor'
  seq: number
  cursor: number
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

export interface NodeSwapParentChildMessage {
  type: 'node-swap-parent-child'
  seq: number
  nodeId: string   // P — the node being re-parented
  childId: string  // C — P's immediate child that becomes P's new parent
}

export interface TerminalCreateMessage {
  type: 'terminal-create'
  seq: number
  parentId: string
  x?: number
  y?: number
  options?: CreateOptions
  initialTitleHistory?: string[]
  initialName?: string
  initialInput?: string
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
  x?: number
  y?: number
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

export interface MarkdownSetMaxWidthMessage {
  type: 'markdown-set-max-width'
  seq: number
  nodeId: string
  maxWidth: number
}

export interface TerminalReincarnateMessage {
  type: 'terminal-reincarnate'
  seq: number
  nodeId: string
  options?: CreateOptions
}

export interface DirectoryAddMessage {
  type: 'directory-add'
  seq: number
  parentId: string
  x?: number
  y?: number
  cwd: string
}

export interface DirectoryCwdMessage {
  type: 'directory-cwd'
  seq: number
  nodeId: string
  cwd: string
}

export interface DirectoryGitFetchMessage {
  type: 'directory-git-fetch'
  seq: number
  nodeId: string
}

export interface DirectoryWtSpawnMessage {
  type: 'directory-wt-spawn'
  seq: number
  nodeId: string
  branchName: string
}

export interface ValidateDirectoryMessage {
  type: 'validate-directory'
  seq: number
  path: string
}

export interface ValidateDirectoryResult {
  type: 'validate-directory-result'
  seq: number
  valid: boolean
  error?: string
}

export interface FileAddMessage {
  type: 'file-add'
  seq: number
  parentId: string
  x?: number
  y?: number
  filePath: string
}

export interface FilePathMessage {
  type: 'file-path'
  seq: number
  nodeId: string
  filePath: string
}

export interface TitleAddMessage {
  type: 'title-add'
  seq: number
  parentId: string
  x?: number
  y?: number
}

export interface TitleTextMessage {
  type: 'title-text'
  seq: number
  nodeId: string
  text: string
}

export interface ValidateFileMessage {
  type: 'validate-file'
  seq: number
  path: string
  cwd?: string
}

export interface ValidateFileResult {
  type: 'validate-file-result'
  seq: number
  valid: boolean
  error?: string
}

export interface SetTerminalModeMessage {
  type: 'set-terminal-mode'
  sessionId: string
  mode: 'live' | 'snapshot'
}

export interface SetClaudeStatusUnreadMessage {
  type: 'set-claude-status-unread'
  sessionId: string
  unread: boolean
}

export interface SetClaudeStatusAsleepMessage {
  type: 'set-claude-status-asleep'
  sessionId: string
  asleep: boolean
}

export interface ForkSessionMessage {
  type: 'fork-session'
  seq: number
  nodeId: string
}

export interface TerminalRestartMessage {
  type: 'terminal-restart'
  seq: number
  nodeId: string
  extraCliArgs: string
}

export interface CrabReorderMessage {
  type: 'crab-reorder'
  seq: number
  order: string[]  // Node IDs in desired visual order
}

export interface SetAlertsReadTimestampMessage {
  type: 'set-alerts-read-timestamp'
  nodeId: string
  timestamp: number
}

/** Fire-and-forget messages received on the hooks socket (no response sent). */
export type IngestMessage =
  | HookMessage
  | StatusLineMessage
  | EmitMarkdownMessage
  | SpawnClaudeSurfaceMessage
  | SpacetermBroadcastMessage
  | PlaySoundMessage
  | SpeakMessage

/** Bidirectional messages received on the main socket (may trigger responses/broadcasts). */
export type ClientMessage =
  | CreateMessage
  | ListMessage
  | AttachMessage
  | DetachMessage
  | DestroyMessage
  | WriteMessage
  | ResizeMessage
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
  | NodeSwapParentChildMessage
  | TerminalCreateMessage
  | TerminalResizeMessage
  | MarkdownAddMessage
  | MarkdownResizeMessage
  | MarkdownContentMessage
  | MarkdownSetMaxWidthMessage
  | TerminalReincarnateMessage
  | SetTerminalModeMessage
  | SetClaudeStatusUnreadMessage
  | SetClaudeStatusAsleepMessage
  | DirectoryAddMessage
  | DirectoryCwdMessage
  | DirectoryGitFetchMessage
  | DirectoryWtSpawnMessage
  | ValidateDirectoryMessage
  | FileAddMessage
  | FilePathMessage
  | ValidateFileMessage
  | TitleAddMessage
  | TitleTextMessage
  | ForkSessionMessage
  | TerminalRestartMessage
  | CrabReorderMessage
  | SetAlertsReadTimestampMessage
  | UndoBufferPushMessage
  | UndoBufferSetCursorMessage

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
  claudeContextPercent?: number
  claudeSessionLineCount?: number
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

export interface ClaudeContextMessage {
  type: 'claude-context'
  sessionId: string
  contextRemainingPercent: number
}

export interface ClaudeSessionLineCountMessage {
  type: 'claude-session-line-count'
  sessionId: string
  lineCount: number
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

export interface NodeAddAckMessage {
  type: 'node-add-ack'
  seq: number
  nodeId: string
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

export interface FileContentMessage {
  type: 'file-content'
  nodeId: string   // markdown node ID
  content: string  // full file contents
}

export interface PlanCacheUpdateMessage {
  type: 'plan-cache-update'
  sessionId: string
  count: number
  files: string[]
}

export interface ServerErrorMessage {
  type: 'server-error'
  message: string
}

export interface ClaudeUsageMessage {
  type: 'claude-usage'
  usage: import('../server/claude-usage').ClaudeUsageData
  subscriptionType: string
  rateLimitTier: string
  creditHistory: (number | null)[]
  fiveHourHistory: (number | null)[]
  sevenDayHistory: (number | null)[]
}

export interface GhRateLimitData {
  limit: number
  used: number
  resetAt: string  // ISO 8601
}

export interface GhRateLimitMessage {
  type: 'gh-rate-limit'
  data: GhRateLimitData
  usedHistory: (number | null)[]
}

export interface PlaySoundServerMessage {
  type: 'play-sound'
  sound: SoundName
}

export interface SpeakMessage {
  type: 'speak'
  surfaceId: string
  text: string
}

export interface SpeakServerMessage {
  type: 'speak'
  text: string
}

// --- Script socket messages (scripts.sock) ---

export interface ScriptGetAncestorsMessage {
  type: 'script-get-ancestors'
  seq: number
  nodeId: string
}

export interface ScriptGetNodeMessage {
  type: 'script-get-node'
  seq: number
  nodeId: string
}

export interface ScriptShipItMessage {
  type: 'script-ship-it'
  seq: number
  nodeId: string
  data: string
  submit?: boolean  // default true — send \r after 200ms delay
}

export interface ScriptSubscribeMessage {
  type: 'script-subscribe'
  seq: number
  events?: string[]   // event types to receive; omit for all
  nodeIds?: string[]  // node IDs to filter on; omit for all
}

export interface ScriptForkClaudeMessage {
  type: 'script-fork-claude'
  seq: number
  nodeId: string    // source terminal node to fork from
  parentId: string  // parent node for placement (new terminal goes below this)
}

export interface ScriptUnreadMessage {
  type: 'script-unread'
  nodeId: string
}

export type ScriptMessage =
  | ScriptGetAncestorsMessage
  | ScriptGetNodeMessage
  | ScriptShipItMessage
  | ScriptSubscribeMessage
  | ScriptForkClaudeMessage
  | ScriptUnreadMessage

// --- Script socket responses ---

export interface ScriptGetAncestorsResult {
  type: 'script-get-ancestors-result'
  seq: number
  ancestors: string[]  // [self, parent, grandparent, ...]
  error?: string
}

export interface ScriptGetNodeResult {
  type: 'script-get-node-result'
  seq: number
  node?: Omit<NodeData, 'archivedChildren'> & { archivedChildren: [] }
  error?: string
}

export interface ScriptShipItResult {
  type: 'script-ship-it-result'
  seq: number
  ok: boolean
  error?: string
}

export interface ScriptSubscribeResult {
  type: 'script-subscribe-result'
  seq: number
  ok: boolean
}

export interface ScriptForkClaudeResult {
  type: 'script-fork-claude-result'
  seq: number
  nodeId: string   // new node ID (empty string on error)
  error?: string
}

export type ScriptResponse =
  | ScriptGetAncestorsResult
  | ScriptGetNodeResult
  | ScriptShipItResult
  | ScriptSubscribeResult
  | ScriptForkClaudeResult

export type ServerMessage =
  | CreatedMessage
  | ListedMessage
  | AttachedMessage
  | DetachedMessage
  | DestroyedMessage
  | DataMessage
  | ExitMessage
  | ClaudeContextMessage
  | ClaudeSessionLineCountMessage
  | SyncStateMessage
  | NodeUpdatedMessage
  | NodeAddedMessage
  | NodeRemovedMessage
  | MutationAckMessage
  | NodeAddAckMessage
  | SnapshotMessage
  | ValidateDirectoryResult
  | ValidateFileResult
  | FileContentMessage
  | PlanCacheUpdateMessage
  | ServerErrorMessage
  | ClaudeUsageMessage
  | GhRateLimitMessage
  | PlaySoundServerMessage
  | SpeakServerMessage
