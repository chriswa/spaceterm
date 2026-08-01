import { join } from 'path'
import { homedir } from 'os'

/** Sound names available for the play-sound MCP tool. */
export const SOUND_NAMES = ['done', 'error', 'success'] as const
export type SoundName = (typeof SOUND_NAMES)[number]

/**
 * Version of the scripts-socket contract this build speaks.
 *
 * Bump on any change a script written against an older version could notice:
 * a removed or renamed message or event, a field that stops being sent, a
 * changed meaning. Adding a new message type or an optional field does not
 * need a bump — an older script simply will not use it.
 *
 * Until this existed, the first tool written against `scripts.sock` froze the
 * protocol by accident, because there was no way for either side to say what it
 * expected. Nine tools already speak it (`src/claude-code-plugin/mcp-server/`).
 */
export const SCRIPT_PROTOCOL_VERSION = 1

/**
 * Oldest version this build still serves. Kept separate from the current
 * version so a script can be told "too old" rather than silently misbehaving.
 */
export const MIN_SCRIPT_PROTOCOL_VERSION = 1

/**
 * The events a script may subscribe to.
 *
 * Documented as a closed set rather than "whatever the server happens to
 * broadcast" — a subscriber cannot discover events by reading server source it
 * does not have, and `broadcastToScriptSubscribers` is typed against this so
 * emitting an undocumented event is a compile error.
 */
export const SCRIPT_EVENTS = [
  /** A node's fields changed. Payload: `node-updated`. */
  'node-updated',
  /** A node was created. Payload: `node-added`. */
  'node-added',
  /** A node was archived or deleted. Payload: `node-removed`. */
  'node-removed',
  /** A terminal's PTY exited. Payload: `{ nodeId, sessionId, exitCode }`. */
  'exit',
  /** Another script called spaceterm-broadcast. Payload: the broadcast body. */
  'broadcast',
] as const
export type ScriptEvent = (typeof SCRIPT_EVENTS)[number]

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
  sessionId: PtySessionId
  cols: number
  rows: number
}

// --- Client → Server messages ---

export interface CreateOptions {
  cwd?: string
  command?: string
  args?: string[]
  claude?: { prompt?: string; resumeSessionId?: string; appendSystemPrompt?: boolean }
  /** Cursor Agent CLI surface (binary: `agent`). Mutually exclusive with `claude`/`codex` in practice. */
  cursor?: { prompt?: string; resumeSessionId?: string }
  /** Codex CLI surface (binary: `codex`). Mutually exclusive with `claude`/`cursor` in practice. */
  codex?: { prompt?: string; resumeSessionId?: string; forkSessionId?: string }
  /** Stable node ID for SPACETERM_NODE_ID env var. Used during reincarnation when nodeId !== sessionId. */
  nodeId?: NodeId
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

/** Request a graceful server process restart. The persistent PTY daemon is left running. */
export interface ServerRestartMessage {
  type: 'server-restart'
  seq: number
}

export interface AttachMessage {
  type: 'attach'
  seq: number
  sessionId: PtySessionId
}

export interface DetachMessage {
  type: 'detach'
  seq: number
  sessionId: PtySessionId
}

export interface DestroyMessage {
  type: 'destroy'
  seq: number
  sessionId: PtySessionId
}

export interface WriteMessage {
  type: 'write'
  sessionId: PtySessionId
  data: string
}

export interface ResizeMessage {
  type: 'resize'
  sessionId: PtySessionId
  cols: number
  rows: number
}

export interface HookMessage {
  type: 'hook'
  surfaceId: PtySessionId
  ts?: number          // epoch ms — when hook event fired (added by hook-handler.sh)
  payload: Record<string, unknown>
}

export interface StatusLineMessage {
  type: 'status-line'
  surfaceId: PtySessionId
  payload: Record<string, unknown>
}

export interface EmitMarkdownMessage {
  type: 'emit-markdown'
  surfaceId: PtySessionId
  content: string
}

export interface EmitMarkdownOnParentMessage {
  type: 'emit-markdown-on-parent'
  surfaceId: PtySessionId
  content: string
}

export interface SpawnClaudeSurfaceMessage {
  type: 'spawn-claude-surface'
  surfaceId: PtySessionId
  prompt: string
  title: string
}

export interface ForkClaudeSurfaceMessage {
  type: 'fork-claude-surface'
  surfaceId: PtySessionId
  prompt: string
  title: string
}

export interface SpacetermBroadcastMessage {
  type: 'spaceterm-broadcast'
  surfaceId: PtySessionId
  content: string
}

export interface PlaySoundMessage {
  type: 'play-sound'
  surfaceId: PtySessionId
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
  nodeId: NodeId
  x: number
  y: number
}

export interface NodeBatchMoveMessage {
  type: 'node-batch-move'
  seq: number
  moves: Array<{ nodeId: NodeId; x: number; y: number }>
}

export interface NodeRenameMessage {
  type: 'node-rename'
  seq: number
  nodeId: NodeId
  name: string
}

export interface NodeSetColorMessage {
  type: 'node-set-color'
  seq: number
  nodeId: NodeId
  colorPresetId: string
}

export interface NodeArchiveMessage {
  type: 'node-archive'
  seq: number
  nodeId: NodeId
}

export interface NodeUnarchiveMessage {
  type: 'node-unarchive'
  seq: number
  parentNodeId: NodeId
  archivedNodeId: NodeId
}

export interface NodeArchiveDeleteMessage {
  type: 'node-archive-delete'
  seq: number
  parentNodeId: NodeId
  archivedNodeId: NodeId
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
  nodeId: NodeId
}

export interface NodeReparentMessage {
  type: 'node-reparent'
  seq: number
  nodeId: NodeId
  newParentId: NodeId
}

export interface NodeSwapParentChildMessage {
  type: 'node-swap-parent-child'
  seq: number
  nodeId: NodeId   // P — the node being re-parented
  childId: NodeId  // C — P's immediate child that becomes P's new parent
}

export interface TerminalCreateMessage {
  type: 'terminal-create'
  seq: number
  parentId: NodeId
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
  nodeId: NodeId
  cols: number
  rows: number
}

export interface MarkdownAddMessage {
  type: 'markdown-add'
  seq: number
  parentId: NodeId
  x?: number
  y?: number
}

export interface MarkdownResizeMessage {
  type: 'markdown-resize'
  seq: number
  nodeId: NodeId
  width: number
  height: number
}

export interface MarkdownContentMessage {
  type: 'markdown-content'
  seq: number
  nodeId: NodeId
  content: string
}

export interface MarkdownSetMaxWidthMessage {
  type: 'markdown-set-max-width'
  seq: number
  nodeId: NodeId
  maxWidth: number
}

export interface TerminalReincarnateMessage {
  type: 'terminal-reincarnate'
  seq: number
  nodeId: NodeId
  options?: CreateOptions
}

export interface DirectoryAddMessage {
  type: 'directory-add'
  seq: number
  parentId: NodeId
  x?: number
  y?: number
  cwd: string
}

export interface DirectoryCwdMessage {
  type: 'directory-cwd'
  seq: number
  nodeId: NodeId
  cwd: string
}

export interface DirectoryGitFetchMessage {
  type: 'directory-git-fetch'
  seq: number
  nodeId: NodeId
}

export interface DirectoryWtSpawnMessage {
  type: 'directory-wt-spawn'
  seq: number
  nodeId: NodeId
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
  parentId: NodeId
  x?: number
  y?: number
  filePath: string
}

export interface FilePathMessage {
  type: 'file-path'
  seq: number
  nodeId: NodeId
  filePath: string
}

export interface TitleAddMessage {
  type: 'title-add'
  seq: number
  parentId: NodeId
  x?: number
  y?: number
}

export interface TitleTextMessage {
  type: 'title-text'
  seq: number
  nodeId: NodeId
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
  sessionId: PtySessionId
  mode: 'live' | 'snapshot'
}

export interface SetClaudeStatusUnreadMessage {
  type: 'set-claude-status-unread'
  sessionId: PtySessionId
  unread: boolean
}

export interface SetClaudeStatusAsleepMessage {
  type: 'set-claude-status-asleep'
  sessionId: PtySessionId
  asleep: boolean
}

export interface ForkSessionMessage {
  type: 'fork-session'
  seq: number
  nodeId: NodeId
}

export interface TerminalRestartMessage {
  type: 'terminal-restart'
  seq: number
  nodeId: NodeId
  extraCliArgs: string
}

export interface CrabReorderMessage {
  type: 'crab-reorder'
  seq: number
  order: NodeId[]  // Node IDs in desired visual order
}

export interface SetAlertsReadTimestampMessage {
  type: 'set-alerts-read-timestamp'
  nodeId: NodeId
  timestamp: number
}

export interface CameraBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface CameraBoundsMessage {
  type: 'camera-bounds'
  bounds: CameraBounds
}

/** Request the server to focus the surface with this SPACETERM_SURFACE_ID on one client. */
export interface FocusSurfaceRequestMessage {
  type: 'focus-surface-request'
  surfaceId: PtySessionId
}

/**
 * Request the server to focus whichever surface hosts a given Claude session.
 * Used by external senders (e.g. Voice Operator) that know only claude session
 * ids, not spaceterm's surface/node ids — the server resolves it against each
 * node's persisted `claudeSessionHistory` (see `getNodeIdForClaudeSession`),
 * the same restart-surviving matching the speaking indicator uses. Keeps
 * spaceterm's internal id vocabulary out of external clients.
 */
export interface FocusClaudeSessionMessage {
  type: 'focus-claude-session'
  claudeSessionId: ClaudeSessionId
}

export interface SummaryChatStartMessage {
  type: 'summary-chat-start'
  nodeId: NodeId
}

export interface VoiceCommandMessage {
  type: 'voice-command'
  text: string
}

/** Store the camera bounds for a numbered viewport slot ('0'..'9'), shared across all clients. */
export interface SaveViewportMessage {
  type: 'save-viewport'
  slot: string
  bounds: CameraBounds
}

/** Fire-and-forget messages received on the hooks socket (no response sent). */
export type IngestMessage =
  | HookMessage
  | StatusLineMessage
  | EmitMarkdownMessage
  | EmitMarkdownOnParentMessage
  | SpawnClaudeSurfaceMessage
  | ForkClaudeSurfaceMessage
  | SpacetermBroadcastMessage
  | PlaySoundMessage
  | SpeakMessage
  | VoiceCommandMessage

/** Bidirectional messages received on the main socket (may trigger responses/broadcasts). */
export type ClientMessage =
  | CreateMessage
  | ListMessage
  | ServerRestartMessage
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
  | CameraBoundsMessage
  | FocusSurfaceRequestMessage
  | FocusClaudeSessionMessage
  | SummaryChatStartMessage
  | SaveViewportMessage

// --- Server → Client messages ---

export interface CreatedMessage {
  type: 'created'
  seq: number
  sessionId: PtySessionId
  cols: number
  rows: number
}

/** Acknowledges that the server has begun its graceful restart sequence. */
export interface ServerRestartedMessage {
  type: 'server-restarted'
  seq: number
}

export interface ListedMessage {
  type: 'listed'
  seq: number
  sessions: SessionInfo[]
}

export interface ClaudeSessionEntry {
  claudeSessionId: ClaudeSessionId
  reason: 'startup' | 'fork' | 'clear' | 'compact' | 'resume'
  timestamp: string
}

export interface AttachedMessage {
  type: 'attached'
  seq: number
  sessionId: PtySessionId
  scrollback: string
  claudeContextPercent?: number
  claudeSessionLineCount?: number
}

export interface DetachedMessage {
  type: 'detached'
  seq: number
  sessionId: PtySessionId
}

export interface DestroyedMessage {
  type: 'destroyed'
  seq: number
}

export interface DataMessage {
  type: 'data'
  sessionId: PtySessionId
  data: string
}

export interface ExitMessage {
  type: 'exit'
  sessionId: PtySessionId
  exitCode: number
}

export interface ClaudeContextMessage {
  type: 'claude-context'
  sessionId: PtySessionId
  contextRemainingPercent: number
}

export interface ClaudeSessionLineCountMessage {
  type: 'claude-session-line-count'
  sessionId: PtySessionId
  lineCount: number
}

// --- Server → Client node state messages ---

import type { ServerState, NodeData } from './state'
import type { NodeId, PtySessionId, ClaudeSessionId } from './ids'

export interface SyncStateMessage {
  type: 'sync-state'
  seq: number
  state: ServerState
}

export interface NodeUpdatedMessage {
  type: 'node-updated'
  nodeId: NodeId
  fields: Partial<NodeData>
}

export interface NodeAddedMessage {
  type: 'node-added'
  node: NodeData
}

export interface NodeRemovedMessage {
  type: 'node-removed'
  nodeId: NodeId
}

export interface MutationAckMessage {
  type: 'mutation-ack'
  seq: number
}

export interface NodeAddAckMessage {
  type: 'node-add-ack'
  seq: number
  nodeId: NodeId
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
  sessionId: PtySessionId
  cols: number
  rows: number
  cursorX: number
  cursorY: number
  lines: SnapshotRow[]
}

export interface FileContentMessage {
  type: 'file-content'
  nodeId: NodeId   // markdown node ID
  content: string  // full file contents
}

export interface PlanCacheUpdateMessage {
  type: 'plan-cache-update'
  sessionId: PtySessionId
  count: number
  files: string[]
}

export interface ServerErrorMessage {
  type: 'server-error'
  message: string
  /** When set, correlates with a pending client request so it can reject. */
  seq?: number
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
  /** Minutes per history slot (matches the server's polling interval). */
  slotMinutes: number
}

export interface PlaySoundServerMessage {
  type: 'play-sound'
  sound: SoundName
}

export interface SpeakMessage {
  type: 'speak'
  surfaceId: PtySessionId
  text: string
}

export interface SpeakServerMessage {
  type: 'speak'
  text: string
}

export interface SpeakingChangedMessage {
  type: 'speaking-changed'
  nodeId: NodeId
  speaking: boolean
  voice?: string
}

/** Summary Chat lifecycle for the toolbar's thinking and target indicators. */
export interface SummaryChatStatusMessage {
  type: 'summary-chat-status'
  nodeId: NodeId
  state: 'thinking' | 'ready' | 'target' | 'error'
  message?: string
}

export interface PeerConnectedMessage {
  type: 'peer-connected'
  clientId: string
}

export interface PeerDisconnectedMessage {
  type: 'peer-disconnected'
  clientId: string
}

export interface PeerCameraBoundsMessage {
  type: 'peer-camera-bounds'
  clientId: string
  bounds: CameraBounds
}

/** Sent to exactly one client, instructing it to raise its window and focus this node. */
export interface FocusSurfaceMessage {
  type: 'focus-surface'
  nodeId: NodeId
}

/** Full set of saved viewport slots (slot -> bounds). Sent on connect and broadcast on every save. */
export interface SavedViewportsMessage {
  type: 'saved-viewports'
  viewports: Record<string, CameraBounds>
}

// --- Script socket messages (scripts.sock) ---

export interface ScriptGetAncestorsMessage {
  type: 'script-get-ancestors'
  seq: number
  nodeId: NodeId
}

export interface ScriptGetNodeMessage {
  type: 'script-get-node'
  seq: number
  nodeId: NodeId
}

export interface ScriptShipItMessage {
  type: 'script-ship-it'
  seq: number
  nodeId: NodeId
  data: string
  submit?: boolean  // default true — send \r after 200ms delay
}

export interface ScriptSubscribeMessage {
  type: 'script-subscribe'
  seq: number
  events?: ScriptEvent[]  // event types to receive; omit for all
  nodeIds?: NodeId[]      // node IDs to filter on; omit for all
}

/**
 * Version handshake. A script sends this first; the reply says what this build
 * speaks and what it offers, so a script can fail loudly on a mismatch instead
 * of misreading a message it half-understands.
 *
 * Optional — every existing tool works without it — but a mod should send it.
 */
export interface ScriptHelloMessage {
  type: 'script-hello'
  seq: number
  /** The version the script was written against. */
  protocolVersion: number
  /** Free-form identifier for logs, e.g. "spaceterm-mcp/1.2.0". */
  client?: string
}

export interface ScriptHelloResult {
  type: 'script-hello-result'
  seq: number
  /** True when `protocolVersion` is within this build's supported range. */
  compatible: boolean
  /** What this build speaks. */
  protocolVersion: number
  /** Oldest version this build still serves. */
  minProtocolVersion: number
  /** The complete set of subscribable events. */
  events: ScriptEvent[]
  /** Present when `compatible` is false. */
  error?: string
}

export interface ScriptForkClaudeMessage {
  type: 'script-fork-claude'
  seq: number
  nodeId: NodeId    // source terminal node to fork from
  parentId: NodeId  // parent node for placement (new terminal goes below this)
}

export interface ScriptUnreadMessage {
  type: 'script-unread'
  nodeId: NodeId
}

/**
 * Resolve everything the fork-handoff command needs, in one round-trip: the
 * caller surface's current transcript path, whether it is a fork (its transcript
 * carries `forkedFrom` markers), and the nearest ancestor terminal surface to
 * hand the summary off to (skipping intermediate nodes such as title cards).
 *
 * `surfaceId` is the caller's SPACETERM_SURFACE_ID — a *pty session id*, which is
 * resolved to a node id server-side via `getNodeIdForSession`. It is NOT a node
 * id: the two coincide only at a terminal's first launch and diverge after a
 * restart/resume (which rebinds the node to a fresh pty session id).
 */
export interface ScriptResolveHandoffMessage {
  type: 'script-resolve-handoff'
  seq: number
  surfaceId: PtySessionId
}

export type ScriptMessage =
  | ScriptHelloMessage
  | ScriptGetAncestorsMessage
  | ScriptGetNodeMessage
  | ScriptShipItMessage
  | ScriptSubscribeMessage
  | ScriptForkClaudeMessage
  | ScriptUnreadMessage
  | ScriptResolveHandoffMessage

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
  nodeId: NodeId   // new node ID (empty string on error)
  error?: string
}

/** The parent surface a handoff can be shipped to. */
export interface HandoffTargetSurface {
  nodeId: NodeId
  title: string | null
  alive: boolean
}

export interface ScriptResolveHandoffResult {
  type: 'script-resolve-handoff-result'
  seq: number
  transcriptPath?: string                        // absent if no transcript found on disk
  isFork?: boolean                               // true when the transcript carries `forkedFrom` markers
  targetSurface?: HandoffTargetSurface | null    // null when there is no ancestor terminal to hand off to
  error?: string
}

export type ScriptResponse =
  | ScriptHelloResult
  | ScriptGetAncestorsResult
  | ScriptGetNodeResult
  | ScriptShipItResult
  | ScriptSubscribeResult
  | ScriptForkClaudeResult
  | ScriptResolveHandoffResult

export type ServerMessage =
  | CreatedMessage
  | ServerRestartedMessage
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
  | GhRateLimitMessage
  | PlaySoundServerMessage
  | SpeakServerMessage
  | SpeakingChangedMessage
  | SummaryChatStatusMessage
  | PeerConnectedMessage
  | PeerDisconnectedMessage
  | PeerCameraBoundsMessage
  | FocusSurfaceMessage
  | SavedViewportsMessage
