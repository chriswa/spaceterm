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
  /**
   * Generated, not authored: this node is a view of something on disk, kept in
   * `state.nodes` only so the canvas can lay it out.
   *
   * Living in `state.nodes` is what gets these cards edges, camera fit, focus,
   * z-order, colour inheritance and hit-testing for free, instead of a second
   * node source every one of those would have to learn about. The cost is that
   * every generic path over `state.nodes` — archive, reparent, batch move,
   * bring-to-front, the undo buffer — would otherwise treat them as real, and
   * a single one of those reaching disk puts a node id in `state.json` that
   * nothing can ever resolve again.
   *
   * So this flag is checked in exactly two places rather than at each call
   * site: `StateManager.refuseEphemeral` refuses every persisting mutation, and
   * `serializeState` drops the nodes on the way out. See `AgentMetaManager`,
   * the only thing that sets it.
   */
  ephemeral?: true
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
  /**
   * epoch ms — last activity by the *agent* on this surface: a hook firing, or
   * a new entry landing in its transcript. Written only by
   * `StateManager.recordAgentActivity`.
   *
   * Narrower than `lastInteractedAt`, deliberately, and the two are not
   * redundant. `lastInteractedAt` answers "has anything happened here",
   * counting the human's keystrokes, which is what the "dim stale nodes" lens
   * wants. This one answers "is the agent still moving", which a keystroke must
   * not be allowed to reset — typing into a stalled surface would otherwise
   * make it look alive.
   *
   * Absent means nothing has been heard from an agent on this surface yet, not
   * "never": like `lastInteractedAt`, it is re-seeded from transcript history
   * on load, so a surface that has a past acquires the value at startup.
   */
  lastAgentActivityAt?: number
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
  /**
   * How many background launches this surface has dismissed — work the ledger
   * tracked and then stopped counting as blocking (see background-ledger.ts).
   * Non-zero is what makes "wait on background work again" an available action
   * on the agent mark; zero means there is nothing to wait for.
   *
   * Ephemeral and NOT persisted *on the node*: it is a projection of the
   * ledger, which is persisted in its own right under
   * `ServerState.backgroundLedgers`. Republished from the restored ledger as
   * soon as a surface is adopted at startup, so a second copy on the node
   * could only ever disagree with it.
   */
  claudeDismissedBackground?: number
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
  /**
   * The branch work normally lands on, short form (e.g. "main"), or null if the
   * repo never recorded one. Comes from `refs/remotes/<remote>/HEAD`, which
   * `git clone` sets and `git init` does not — so null means "unknown", not
   * "none", and callers fall back to the main/master convention. See
   * `isOffDefaultBranch` in shared/git-status.ts.
   */
  defaultBranch: string | null
  upstream: string | null      // e.g. "origin/main"
  /**
   * Whether the repo has any remote configured at all. Separates "this branch
   * was never pushed" from "this repo is local by design".
   */
  hasRemote: boolean
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

/**
 * The header card of a generated agent-meta branch, and of the Skills group
 * nested inside it.
 *
 * Shaped like a title card and deliberately not one: its text is derived, so it
 * cannot be edited, renamed, coloured or closed. Clicking its label rescans.
 */
export interface MetaGroupNodeData extends BaseNodeData {
  type: 'meta-group'
  /** The directory node — or the root — whose branch this belongs to. */
  hostId: NodeId
  /**
   * What this group heads.
   *
   * `meta` is the branch root the toolbar button toggles. `skills` groups a set
   * of skills — a host's own, or one plugin's. `marketplace` and `plugin` are
   * the two levels a published marketplace adds, and they nest inside the same
   * branch as the host's own documents rather than replacing them: a repo can
   * have its own CLAUDE.md and skills AND publish plugins that have theirs.
   */
  groupKind: 'meta' | 'skills' | 'marketplace' | 'plugin'
  /** Rendered caption, derived by the server from the scan. */
  label: string
  /** Absolute path this group summarises, for the tooltip. */
  sourcePath: string
}

/**
 * One markdown document on disk, shown as a card: a skill's `SKILL.md`, or a
 * `CLAUDE.md`.
 *
 * Content is NOT held here. It reaches the client through the same
 * `file-content` broadcast that file-backed markdown uses, and lands in the
 * renderer's `fileContents` map — so the card's caption is parsed from text the
 * renderer already has, and re-renders as you type in it.
 */
export interface MetaDocNodeData extends BaseNodeData {
  type: 'meta-doc'
  hostId: NodeId
  /** `skill` titles itself from its directory; `doc` from its first heading. */
  docKind: 'skill' | 'doc'
  /** Stable identity within the branch, and the caption's last-resort fallback. */
  docKey: string
  /** Absolute path to the file being shown. */
  docPath: string
  /** Measured by the client, like markdown. Never persisted, so re-measured each mount. */
  width: number
  height: number
}

export type NodeData =
  | TerminalNodeData
  | MarkdownNodeData
  | DirectoryNodeData
  | FileNodeData
  | TitleNodeData
  | MetaGroupNodeData
  | MetaDocNodeData

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
  /**
   * Which nodes have their agent-meta branch open, and where its cards sit.
   *
   * Presence of a key IS the enabled flag. Nothing else about the branch is
   * persisted — not the generated node ids, not the file contents, not the
   * sizes, not which cards are expanded — because all of it is re-derived from
   * disk on the next scan.
   *
   * One top-level key rather than a field on `DirectoryNodeData`: the root node
   * is not in `state.nodes` and would have needed a second home anyway, and
   * this keeps `NodeData` — which every archive snapshot deep-copies — free of
   * it.
   */
  metaHosts: Record<string, MetaHostEntry>
  /**
   * Outstanding background work per surface, keyed by **pty session id**.
   *
   * The ledger behind the yellow `working_background` indicator lives in
   * memory (see `background-ledger.ts`); this is its durable copy, so a server
   * restart does not silently turn a surface that is still running background
   * work back to white and fire the completion tone.
   *
   * Keyed by pty session id — not node id — because that is the ledger's own
   * key, and because it makes the entry self-invalidating: a surface whose pty
   * survived the restart is re-adopted under the *same* session id and finds
   * its launches waiting, while one that had to be respawned gets a fresh id
   * and correctly finds nothing (its background processes were children of the
   * pty that died). Entries no live surface claims are reaped at startup.
   *
   * Top-level rather than a field on `TerminalNodeData` for the same reason as
   * `metaHosts`: `NodeData` is deep-copied into every archive snapshot, and
   * this is bookkeeping about a running process, not something the user
   * authored.
   */
  backgroundLedgers: Record<string, PersistedSurfaceLedger>
}

/** What kind of background work a launch represents. Mirrors `LaunchKind`. */
export type BackgroundLaunchKind = 'bash' | 'agent' | 'monitor' | 'workflow'

/**
 * One tracked background launch, as written to disk.
 *
 * A structural mirror of `Launch` in `background-ledger.ts` rather than an
 * import of it: the ledger's interface is free to grow fields that only make
 * sense in memory, and this one is a wire/disk format that a migration has to
 * answer for. The ledger converts between them explicitly, so a field added
 * there without being added here is visible at that seam.
 */
export interface PersistedBackgroundLaunch {
  id: string
  kind: BackgroundLaunchKind
  /** bash only: the `.output` file its process tree holds open (lsof probe target). */
  outputPath?: string
  /** workflow only: the `wf_…` id naming its on-disk state file. */
  runId?: string
  /** Epoch ms when a completion was enqueued but not yet delivered to the agent. */
  queuedSinceMs?: number
  /** True once dismissed: still tracked, no longer counted as blocking. */
  dismissed?: boolean
}

/** A surface's background ledger, as written to disk. */
export interface PersistedSurfaceLedger {
  launches: PersistedBackgroundLaunch[]
  /** Directory holding the transcript, used to build subagent/workflow probe paths. */
  transcriptDir?: string
  sessionId?: ClaudeSessionId
  /** True when the next launch to resolve should re-dismiss the rest. */
  awaitingAnyResolution?: boolean
}

export interface MetaHostEntry {
  /**
   * Whether the branch is currently showing.
   *
   * An explicit flag rather than presence-of-key, which is what this started
   * as. Presence had to double as both "is open" and "here is your layout", so
   * closing the branch — an ordinary thing to do repeatedly — threw away every
   * card position with it. The entry outlives the branch; only this says
   * whether to rebuild it.
   */
  open: boolean
  /** Where the user dragged the group card, absent until they move it. */
  groupPos?: { x: number; y: number }
  /**
   * Remembered card positions, keyed by what the card describes (a skill's
   * directory name, or a document's path relative to the host) rather than by
   * node id — ids are regenerated every boot, keys are not.
   *
   * Pruned to the current scan on every rescan, so it cannot grow without
   * bound and cannot re-apply one repo's layout to another's same-named skill.
   */
  cardPos?: Record<string, { x: number; y: number }>
}
