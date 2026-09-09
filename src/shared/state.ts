import type { ClaudeSessionEntry, CameraBounds } from './protocol'
import type { NodeId, PtySessionId, ClaudeSessionId } from './ids'
import type { AgentType } from './agent-type'
import type { CardType } from './card-types'
import type { UndoEntry } from './undo-types'

// --- Claude state enum ---

export type ClaudeState = 'stopped' | 'working' | 'working_background' | 'waiting_permission' | 'waiting_question' | 'waiting_plan' | 'potential_error'

/**
 * The statuses Claude Code publishes for itself in `~/.claude/sessions/<pid>.json`.
 *
 * Named here rather than in the server's `session-registry.ts` because the
 * footer renders it: a second copy of the union in the renderer would drift the
 * first time Claude Code adds a value. The list doubles as the parser's
 * whitelist, so an unrecognised status reads as *no status* rather than as one
 * whose meaning we would be guessing.
 *
 * This is Claude Code's own view, not ours — it is displayed beside
 * `ClaudeState` precisely so the two can be compared at a glance, and nothing
 * derives state from it. See `session-status-observer.ts`.
 */
export const CC_SESSION_STATUSES = ['busy', 'shell', 'idle', 'waiting'] as const
export type CcSessionStatus = (typeof CC_SESSION_STATUSES)[number]

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

/**
 * The kinds of alert a node can carry.
 *
 * Closed set rather than free-form strings: alerts are produced by more than
 * one thing now (the cwd-mismatch scan, and launch failures), and each producer
 * must replace only its own kind. A typo'd type would leave a stale alert
 * nothing can ever clear, since clearing is by type match.
 */
export const ALERT_TYPES = ['cwd-mismatch', 'launch-failed'] as const
export type AlertType = (typeof ALERT_TYPES)[number]

export interface NodeAlert {
  type: AlertType
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
  /**
   * epoch ms — last *genuine* interaction with this node. Initialized to the
   * node's creation time, then advanced by the server via `recordInteraction`.
   * Sources depend on node type: an agent surface's real transcript/hook
   * activity (incl. question hooks), a user keystroke into a terminal, or a
   * human edit of a markdown/title/directory node. Passive focus, mouse reports,
   * and background PTY output do NOT count. Monotonic within a session;
   * re-seeded from transcript history on load. Drives the "dim stale nodes" view.
   */
  lastInteractedAt?: number
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
  /**
   * Claude Code's own status for this surface, and the reason when it is
   * `waiting`. Ephemeral and deliberately NOT persisted: it describes a live
   * process, so a value restored from disk would be a claim about a session
   * that no longer exists.
   *
   * `null`, not `undefined`, for "no status" — the same distinction `gitStatus`
   * above draws, and for a harder reason: node patches cross the socket as
   * JSON, and `JSON.stringify` DROPS undefined values, so a patch clearing this
   * field would arrive as `{}` and leave the client showing a dead session's
   * last status forever. undefined therefore only ever means "never observed";
   * every clear is an explicit null.
   *
   * Always null on non-Claude surfaces (Codex and Cursor publish no equivalent)
   * and on a Claude Code too old to write a registry.
   */
  ccStatus?: CcSessionStatus | null
  ccWaitingFor?: string | null
  /** Last-known remaining context %, persisted so it survives a server restart. */
  claudeContextPercent?: number
  /** Last-known Claude session JSONL line count, persisted so it survives a server restart. */
  claudeSessionLineCount?: number
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

/**
 * A node that was live on the canvas when one of its ancestors was archived,
 * and that comes back when that ancestor is restored.
 *
 * Deliberately not an {@link ArchivedNode}. A descendant has no `archivedAt` of
 * its own — the group shares the root's — and no independent restore path: a
 * subtree archived as a unit is restored as a unit. Giving it a separate type
 * makes "you cannot restore one of these on its own" a compile error rather
 * than a convention every caller has to remember.
 *
 * Two kinds of nesting meet here and must not be confused:
 *
 * - `data.archivedChildren` — entries that were ALREADY archived beneath this
 *   node before the group was archived. They stay archived through a round
 *   trip.
 * - `descendants` — this node's LIVE children at archive time. They come back.
 *
 * That split is what gives a round trip parity: archive a subtree that already
 * contains archived subtrees, restore it, and exactly the cards that were
 * visible before are visible again.
 */
export interface ArchivedDescendant {
  data: NodeData
  descendants: ArchivedDescendant[]
}

export interface ArchivedNode {
  archivedAt: string
  data: NodeData
  /**
   * The live subtree swept in with this node, absent when a single leaf was
   * archived. See {@link ArchivedDescendant} for why these are not archives in
   * their own right.
   */
  descendants?: ArchivedDescendant[]
  /**
   * Where the node sat relative to its parent when it was archived, so a
   * restore puts it back in the same place even if the parent has since moved.
   *
   * Absent on entries written before subtree archiving existed; those restore
   * at the absolute position recorded in `data`, which is only wrong if the
   * parent moved in the meantime.
   */
  parentOffset?: { dx: number; dy: number }
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
