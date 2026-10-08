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

// The client socket's version lives in its own module, which imports nothing,
// because the protocol client runs in browsers and this file imports `path`
// and `os`. Re-exported so server-side callers are unaffected.
export { CLIENT_PROTOCOL_VERSION, MIN_CLIENT_PROTOCOL_VERSION } from './client-protocol-version'

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
/**
 * Observation log for Claude Code's own `~/.claude/sessions/<pid>.json` status,
 * paired with the state we decided at the same moment. Nothing reads it back —
 * it exists to be analysed after days of real use, to see whether that status
 * is a better or complementary signal to our hook/transcript inference.
 */
export const SESSION_STATUS_LOG_DIR = join(SOCKET_DIR, 'session-status-logs')

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
  /**
   * Grid to spawn the PTY at. Omitted for a brand new surface, which gets the
   * default; supplied when rebinding an existing node, whose stored size the
   * user may have chosen and which reincarnation would otherwise discard.
   */
  cols?: number
  rows?: number
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

/**
 * Ask whether a server restart has been flagged as needed. The PULL half of the
 * restart-required signal — authoritative on every renderer (re)load, since a
 * PUSH does not repeat across a renderer refresh that keeps the socket open.
 * See {@link RestartRequiredMessage} and `src/server/restart-flag.ts`.
 */
export interface RestartFlagQueryMessage {
  type: 'restart-flag-query'
  seq: number
}

/**
 * Ask for the latest AI usage reading (PULL), for a client that has just
 * loaded. See {@link UsageReportMessage} and `src/server/usage-tracker.ts`.
 */
export interface UsageReportQueryMessage {
  type: 'usage-report-query'
  seq: number
}

/**
 * Start or stop receiving the Mac's system monitor. While watching, the
 * client gets a {@link SystemStatsMessage} at once and on every change. Not
 * remembered across a reconnect. See `src/server/system-stats.ts`.
 */
export interface SystemStatsWatchMessage {
  type: 'system-stats-watch'
  watching: boolean
}

/**
 * Start or stop receiving approval requests (opProxy's, for now). While
 * watching, the client gets an {@link ApprovalsMessage} at once and on every
 * change. Not remembered across a reconnect. See `src/server/approval-feed.ts`
 * and APPROVAL_FEED.md.
 */
export interface ApprovalsWatchMessage {
  type: 'approvals-watch'
  watching: boolean
}

/** Answer an approval request with a reply the phone's native code signed. */
export interface ApprovalReplyMessage {
  type: 'approval-reply'
  seq: number
  source: string
  id: string
  reply: SignedApprovalReply
}

/** Ask an approval source to trust this phone's key; confirmed by someone at the Mac. */
export interface ApprovalPairMessage {
  type: 'approval-pair'
  seq: number
  source: string
  publicKey: string
  name: string
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

export interface NodeSetStampMessage {
  type: 'node-set-stamp'
  seq: number
  nodeId: NodeId
  stamp: NodeStamp
}

/** Generate a different auto-stamp icon for a node. See `AutoStamp`. */
export interface NodeRegenerateAutoStampMessage {
  type: 'node-regenerate-auto-stamp'
  seq: number
  nodeId: NodeId
}

export interface NodeArchiveMessage {
  type: 'node-archive'
  seq: number
  nodeId: NodeId
}

export interface NodeUnarchiveMessage {
  type: 'node-unarchive'
  seq: number
  /** The live node (or `ROOT_NODE_ID`) whose archive holds the top of the path. */
  parentNodeId: NodeId
  /**
   * Archive entry ids from the host's own entry down to the one to restore,
   * outermost first — `[id]` for an entry sitting directly in the host's
   * archive.
   *
   * A path rather than a single id because archives nest: an entry can sit
   * inside an archived subtree, and naming only the leaf left the server unable
   * to find it. Restoring brings back the named entry and its whole group.
   */
  path: NodeId[]
}

export interface NodeArchiveDeleteMessage {
  type: 'node-archive-delete'
  seq: number
  parentNodeId: NodeId
  /** Same addressing as {@link NodeUnarchiveMessage.path}. Deletes the entry and its whole group. */
  path: NodeId[]
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
  /** Typed into the shell, followed by Enter, once it draws its first prompt. */
  initialInput?: string
}

/**
 * Paste `text` into a live terminal surface and submit it — see
 * `src/server/ship-it.ts`. Replies `mutation-ack`, or a correlated
 * `server-error` when the node is not a live terminal.
 */
export interface ShipItMessage {
  type: 'ship-it'
  seq: number
  nodeId: NodeId
  text: string
}

/**
 * Dictation for a client that cannot transcribe itself (the phone): it
 * streams PCM to the server, which relays it through Voice Operator. See
 * `src/server/remote-dictation.ts`.
 *
 * `dictation-start` replies `dictation-started` with the session id, or a
 * correlated `server-error` (Voice Operator not running, signed out, …).
 */
export interface DictationStartMessage {
  type: 'dictation-start'
  seq: number
  /** Hz. PCM is signed 16-bit little-endian mono at this rate. */
  sampleRate: number
}

/** One chunk of audio, base64. Fire-and-forget: failures surface at finish. */
export interface DictationAudioMessage {
  type: 'dictation-audio'
  id: string
  pcm: string
}

/** No more audio. Replies `dictation-result`, or a correlated `server-error`. */
export interface DictationFinishMessage {
  type: 'dictation-finish'
  seq: number
  id: string
}

export interface DictationCancelMessage {
  type: 'dictation-cancel'
  id: string
}

/**
 * At a pause: does the speaker sound finished? The server runs the turn model
 * (src/server/turn-detector.ts) over the dictation's last eight seconds as
 * received. Send it after the audio up to the pause. Replies
 * `dictation-turn-result`, or a correlated `server-error`.
 */
export interface DictationTurnCheckMessage {
  type: 'dictation-turn-check'
  seq: number
  id: string
}

/**
 * Hands-free: is this short clip the wake word ("control") said on its own?
 * The client cut it out of what its held-open microphone heard; the server
 * asks Voice Operator, which checks it on the Mac with Apple's on-device
 * speech model — never Wispr, since the clip is whatever was said in the
 * room. Replies `wake-word-result`, or a correlated `server-error`.
 */
export interface WakeWordCheckMessage {
  type: 'wake-word-check'
  seq: number
  /** 16 kHz signed 16-bit little-endian mono, base64. */
  pcm: string
  /**
   * `wake-word` (the default): does it start with "control"? `speech`: in the
   * conversation window, is it words at all — not a cough, not filler (the
   * tuning's `ignoredWords`)? An older server asks the wake-word question.
   */
  mode?: 'wake-word' | 'speech'
}

/**
 * Words dictated hands-free, after the wake word: for Control, whatever the
 * voice target. Takes Control to this device, as speaking to it does.
 */
export interface ReceptionistHandsFreeMessage {
  type: 'receptionist-hands-free'
  text: string
  /**
   * The wake word cut off Control's reply. With no `text` — nothing was caught
   * after it — Control says it had not finished and carries on, rather than
   * falling silent mid-answer. An older server ignores it, and stays silent.
   */
  interrupted?: boolean
}

/**
 * Borrow a terminal surface's grid — the phone fitting it to its screen. The
 * server remembers the surface's own size (persisted, as `homeSize`) and gives
 * it back on `terminal-return-size`, on this client's disconnect, or on the
 * next server start. Re-borrowing while borrowed resizes again. Replies
 * `mutation-ack`.
 */
export interface TerminalBorrowSizeMessage {
  type: 'terminal-borrow-size'
  seq: number
  nodeId: NodeId
  cols: number
  rows: number
}

/** End this client's borrow. A no-op for a surface it does not hold. Replies `mutation-ack`. */
export interface TerminalReturnSizeMessage {
  type: 'terminal-return-size'
  seq: number
  nodeId: NodeId
}

/** Total memory of every process under the PTY daemon. Replies `agent-memory-result`. */
/**
 * A log line from a client with no log file of its own — the phone — written
 * into the server's log so it can be read on the Mac. Fire-and-forget.
 */
export interface ClientLogMessage {
  type: 'client-log'
  message: string
}

/**
 * One entry in the phone's audio and lifecycle record (src/mobile/mobile-events.ts):
 * the microphone, dictation, playback, and the app coming and going.
 */
export interface MobileEventRecord {
  /** When it happened, ISO — on the phone's clock, which for the app's own events is the app's. */
  t: string
  /** The page load that recorded it; with `n`, what makes a resent batch harmless. */
  page: string
  /** Its place in that page load's sequence. */
  n: number
  kind: string
  /**
   * `native`: what the iPhone app saw (NativeEvents.swift); `server`: what the
   * server saw of the phone, written by the server itself; `page` otherwise.
   */
  src: 'page' | 'native' | 'server'
  /** The app's own number for a `native` event, which the app keeps it under until the server has it. */
  nativeSeq?: number
  detail?: Record<string, unknown>
  /** The audio state of the page as it was recorded: hold, dictation, playback, visibility. */
  ctx?: Record<string, unknown>
}

/**
 * The phone's audio and lifecycle events, appended to
 * ~/.spaceterm/mobile-events.jsonl. Replies `mutation-ack` once written, so
 * the phone keeps a batch until the server has it.
 */
export interface MobileEventsMessage {
  type: 'mobile-events'
  seq: number
  events: MobileEventRecord[]
}

export interface AgentMemoryQueryMessage {
  type: 'agent-memory-query'
  seq: number
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

/**
 * Set (or clear, with an empty string) the directory the root node supplies.
 *
 * Named for the action rather than the field, so it cannot be confused with the
 * `root-cwd` broadcast that carries the answer back out — the same split
 * `save-viewport` / `saved-viewports` draws.
 */
export interface SetRootCwdMessage {
  type: 'set-root-cwd'
  seq: number
  cwd: string
}

/** Turn auto-stamp generation on or off for every client. Answered by `auto-stamps-enabled`. */
export interface SetAutoStampsEnabledMessage {
  type: 'set-auto-stamps-enabled'
  seq: number
  enabled: boolean
}

export interface DirectoryGitFetchMessage {
  type: 'directory-git-fetch'
  seq: number
  nodeId: NodeId
}

/**
 * Run `git pull` or `git push` for a directory node, in a new terminal child of
 * it that closes itself on success. Answered with a `directory-command-result`
 * once the command finishes — the terminal exiting, or its shell coming back
 * to a prompt, which means the command failed and the terminal stays open.
 */
export interface DirectoryGitRunMessage {
  type: 'directory-git-run'
  seq: number
  nodeId: NodeId
  command: 'pull' | 'push'
}

/**
 * Open a directory node's repo in GitHub Desktop (`github .`). Answered with a
 * `directory-command-result`.
 */
export interface DirectoryOpenGitHubDesktopMessage {
  type: 'directory-open-github-desktop'
  seq: number
  nodeId: NodeId
}

/** How a command run in a directory node's cwd on the client's behalf ended. */
export interface DirectoryCommandResult {
  type: 'directory-command-result'
  seq: number
  ok: boolean
  /** The command's stderr, or why it could not be run. */
  error?: string
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

export interface CacheTimerMuteMessage {
  type: 'cache-timer-mute'
  seq: number
  nodeId: NodeId
  muted: boolean
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

/** Fire-and-forget: a genuine user interaction (e.g. a keystroke) with a node. */
export interface NodeInteractionMessage {
  type: 'node-interaction'
  nodeId: NodeId
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

/**
 * Right-click on the agent mark: take this surface's dismissed background work
 * back up (`background: true`) or stop counting it (`background: false`).
 * Fire-and-forget — the server may decline (nothing dismissed, or the surface
 * is no longer idle) and the authoritative answer arrives as a node update.
 */
export interface SetClaudeStatusBackgroundMessage {
  type: 'set-claude-status-background'
  sessionId: PtySessionId
  background: boolean
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

/**
 * Request the server to raise whichever surface an id names, without the sender
 * claiming to know what kind of id it is.
 *
 * Carried by the `spaceterm-surface://` deep link, where the id arrives from
 * outside as an opaque string: whoever wrote the URL used whatever they had —
 * a `SPACETERM_SURFACE_ID`, or an agent session id from Claude, Codex, or
 * Cursor. Both are UUIDs, so the kind cannot be told from the value, and it is
 * the server holding node state that can answer. Deliberately `string` rather
 * than a branded id: branding it either way here would be a claim about where
 * the value came from that this sender is in no position to make.
 *
 * See `StateManager.resolveNodeIdForFocus` for the resolution order.
 */
export interface FocusIdRequestMessage {
  type: 'focus-id-request'
  id: string
}

/**
 * Request the server to focus whichever surface hosts a given Claude session.
 * Used by external senders (e.g. Voice Operator) that know only claude session
 * ids, not spaceterm's surface/node ids — the server resolves it against each
 * node's persisted `claudeSessionHistory` (see `getNodeIdForClaudeSession`),
 * the same restart-surviving matching the speaking indicator uses. Keeps
 * spaceterm's internal id vocabulary out of external clients.
 *
 * Distinct from {@link FocusIdRequestMessage}, which guesses: this one is for a
 * sender that *knows* it holds an agent session id and wants only that reading,
 * so a stray match against the surface namespace can never raise a wrong card.
 */
export interface FocusClaudeSessionMessage {
  type: 'focus-claude-session'
  claudeSessionId: ClaudeSessionId
}

/**
 * One press of the Summary Chat chord. Deliberately an *intent*, not a verb.
 *
 * Whether a press starts an answer or cuts one off is a question about the
 * conversations the server owns, and the client's view of those lags by a
 * broadcast hop. A client that decided for itself would send a second `start`
 * for a press made milliseconds after the first — exactly the press that is
 * meant to cancel. So the client reports what is focused and the server rules.
 *
 * `nodeId` is the focused terminal surface, absent when nothing eligible is
 * focused. A press with nothing focused still cancels: silencing an answer must
 * not depend on which surface the listener happens to be looking at.
 */
/**
 * Speak a selection, or stop the speech a previous press started.
 *
 * The client sends what it has — the text under the cursor — and the server
 * rules on whether this press starts or stops, for the same reason
 * `summary-chat-toggle` does: only the side holding the Voice Operator job
 * knows whether anything is still being said.
 */
export interface SpeakToggleMessage {
  type: 'speak-toggle'
  seq: number
  text: string
}

/** Stop anything the direct speech path is saying. Ignored when it is silent. */
export interface SpeakStopMessage {
  type: 'speak-stop'
}

export interface SummaryChatToggleMessage {
  type: 'summary-chat-toggle'
  seq: number
  nodeId?: NodeId
  mode: SummaryChatMode
  /**
   * Speak on this client rather than through Voice Operator on the Mac — the
   * phone. See `src/server/remote-speech.ts`.
   */
  playHere?: boolean
}

/**
 * Build the iPhone app on this Mac and install it on the paired phone — the
 * phone's update badge. See `src/server/mobile-install.ts`.
 */
export interface MobileAppInstallMessage {
  type: 'mobile-app-install'
  seq: number
}

/** What a client playing speech reports: a sentence began, ended, or could not be played. */
export type SpeechProgressEvent = 'started' | 'finished' | 'failed'

/** A client's playback of a {@link SpeechAudioMessage}, sentence by sentence. */
export interface SpeechProgressMessage {
  type: 'speech-progress'
  id: string
  index: number
  event: SpeechProgressEvent
}

/**
 * What a press asks to be read out.
 *
 * `summary` sends the transcript to Haiku and speaks what comes back.
 * `verbatim` speaks the agent's final message as written and involves no model
 * at all — until the listener asks a follow-up, at which point the conversation
 * catches up. Required rather than optional: a mode that could go missing on
 * the wire would silently read the wrong thing out loud.
 */
export type SummaryChatMode = 'summary' | 'verbatim'

/**
 * Something the listener said to Summary Chat from a client — the phone's talk
 * button, or dictation the desktop caught pasting into nothing — rather than through Voice Operator's command mode on the Mac. Goes
 * to the same conversation a voice command would.
 */
export interface SummaryChatFollowUpMessage {
  type: 'summary-chat-follow-up'
  text: string
}

/**
 * The Control button. Held by another device or by none, it brings Control to
 * this client's device and makes it the target of the listener's voice (Voice
 * Operator command-mode transcripts and the phone's talk button go to it until
 * a Summary Chat press takes them back). Held here with the voice on Summary
 * Chat, it makes Control the target again. Held here and the target, it lets
 * go of Control, which silences it. Answered by `receptionist-holder` and
 * `receptionist-status`.
 */
export interface ReceptionistSelectMessage {
  type: 'receptionist-select'
}

/** Stop Control mid-answer, without letting go of it: a talk button pressed over it. */
export interface ReceptionistStopMessage {
  type: 'receptionist-stop'
}

/**
 * Where Control speaks, said outright rather than toggled, so two presses
 * cannot cross: `speak-here` brings it to this device, unmuted, and makes it
 * the voice's target; `mute` keeps it here but has it write rather than speak
 * (taking it here first if need be); `release` lets go of it, if this device
 * holds it, so that it speaks nowhere. Answered by `receptionist-holder`.
 */
export interface ReceptionistHoldMessage {
  type: 'receptionist-hold'
  action: 'speak-here' | 'mute' | 'release'
}

/**
 * The user has read part `part` of the reply at `of` in the transcript view —
 * the whole of it: it was on screen long enough. See `ConsumptionLedger`.
 */
export interface ReceptionistReadMessage {
  type: 'receptionist-read'
  of: number
  part: number
}

/** Play part `part` of the reply at `of` again, on this device, in the voice it was said in. */
export interface ReceptionistReplayMessage {
  type: 'receptionist-replay'
  of: number
  part: number
}

/** Stop this device's replay, if one is playing. */
export interface ReceptionistReplayStopMessage {
  type: 'receptionist-replay-stop'
}

/** Have Control say, in a few words, what its unread replies said: it comes to this device, unmuted, to say it. */
export interface ReceptionistCatchUpMessage {
  type: 'receptionist-catch-up'
}

/**
 * Words typed to Control in its transcript view: for Control, whatever the
 * voice target, and — as speaking to it does — it brings Control here.
 */
export interface ReceptionistSayMessage {
  type: 'receptionist-say'
  text: string
}

/**
 * A page of Control's full record, for its transcript view: up to `count`
 * entries ending before byte `before`, or the newest when it is left out.
 * Replies `receptionist-transcript-result`.
 */
export interface ReceptionistTranscriptMessage {
  type: 'receptionist-transcript'
  seq: number
  before?: number
  count: number
}

/** Abandon every Summary Chat conversation: stop speaking and forget them. */
export interface SummaryChatEndMessage {
  type: 'summary-chat-end'
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
  | VoiceCommandMessage

/**
 * Version handshake, sent by a client immediately on connect.
 *
 * Optional in the sense that the server serves a client that never sends it —
 * but the Electron client does send it, and a mismatch is reported rather than
 * discovered later as a message that does not parse.
 */
export interface ClientHelloMessage {
  type: 'client-hello'
  seq: number
  /** The version the client was built against. */
  protocolVersion: number
  /** Free-form identifier for the server log, e.g. "spaceterm-electron/0.1.0". */
  client?: string
  /**
   * The device this client runs on, the same across reconnects and restarts:
   * what holds Control (see `ReceptionistHolder`). Every Electron window on
   * the Mac is one device.
   */
  device?: ClientDevice
}

export interface ClientDevice {
  id: string
  /** What the device is called where Control's holder is shown, e.g. "Phone". */
  label: string
}

export interface ClientHelloResult {
  type: 'client-hello-result'
  seq: number
  /** True when `protocolVersion` is within this build's supported range. */
  compatible: boolean
  /** What this build speaks. */
  protocolVersion: number
  /** Oldest version this build still serves. */
  minProtocolVersion: number
  /** Present when `compatible` is false. Safe to show a user. */
  error?: string
}

/** Bidirectional messages received on the main socket (may trigger responses/broadcasts). */
/**
 * A message the base relays without understanding: the whole of a mod's wire
 * protocol, as far as spaceterm is concerned.
 *
 * ## Why one variant instead of a channel per mod
 *
 * A mod's two halves — the part that draws and the part that runs
 * out-of-process — need to talk, and every previous answer to that meant
 * widening `ClientMessage`, `ServerMessage`, the preload `Api` and the socket
 * dispatch once per mod. That is the same 45% "wiring in shared files" tax
 * MODDING.md measures, charged to every mod forever.
 *
 * Instead the base learns exactly one variant per union and routes it by
 * `modId`. `payload` is `unknown` and stays that way — nothing in this repo may
 * inspect it, and there is a test that says so. The mod ships its own
 * discriminated union and its own `assertNever`, so it keeps the safety the
 * base has, internally, without the base being a party to it.
 *
 * This is the same shape the theme facets use (`Theme.modFacets` is
 * `Record<string, unknown>`): the base stores and routes, the mod owns the
 * type. Two subsystems solving extension two different ways would be the smell.
 *
 * Exhaustiveness survives, which is the reason this is safe. Every `switch`
 * over these unions gains one `case 'mod':` that routes and returns; the union
 * stays closed while the payload is open.
 */
export interface ModMessage {
  type: 'mod'
  /**
   * The owning mod. The only field the base reads, and the namespace that
   * keeps two mods' traffic apart.
   */
  modId: string
  /** The mod's own discriminant, in the mod's own vocabulary. */
  event: string
  /** The mod's own shape. Opaque here, by design. */
  payload: unknown
}

// --- Agent meta ---

/**
 * Open or close a host's agent-meta branch. The server decides which, and says
 * so in the ack — the client cannot know whether a host has anything to show
 * without doing the filesystem work itself.
 */
export interface AgentMetaToggleMessage {
  type: 'agent-meta-toggle'
  seq: number
  nodeId: NodeId
}

export interface AgentMetaToggleResult {
  type: 'agent-meta-toggle-result'
  seq: number
  open: boolean
}

/** Re-read a branch's tree now, rather than waiting for a watch event. */
export interface AgentMetaRescanMessage {
  type: 'agent-meta-rescan'
  seq: number
  nodeId: NodeId
}

/** A generated document card reporting the size it measured for itself. */
export interface MetaDocResizeMessage {
  type: 'meta-doc-resize'
  seq: number
  nodeId: NodeId
  width: number
  height: number
}

/**
 * An edit to a generated document, written straight through to the file.
 *
 * Deliberately not `markdown-content`: that one also writes `node.content` for
 * cards that are not file-backed, and a generated card has no content field to
 * write. Keeping them separate means neither has to ask which kind it is.
 */
export interface MetaDocContentMessage {
  type: 'meta-doc-content'
  seq: number
  nodeId: NodeId
  content: string
}

/**
 * Whether a host has an agent-meta branch available, pushed as it changes.
 *
 * A dedicated broadcast rather than a `node-updated` patch: the root node is
 * not in `state.nodes`, and the existing `'root'` special case in the client
 * store exists to carry `archivedChildren` — it is a wart, not an extension
 * point. This is also ephemeral in the same sense `gitStatus` is, so it has no
 * business on `NodeData`.
 */
export interface AgentMetaAvailabilityMessage {
  type: 'agent-meta-availability'
  nodeId: NodeId
  available: boolean
}

/**
 * Ask for every host's availability at once (the PULL).
 *
 * The broadcast above fires when the *socket* connects and then only on change,
 * which a renderer that loaded afterwards — or reloaded over a socket that
 * stayed up — never hears. Exactly the trap `restartFlagStatus` documents. The
 * renderer asks for this once at startup and is authoritative from then on.
 */
export interface AgentMetaAvailabilityQueryMessage {
  type: 'agent-meta-availability-query'
  seq: number
}

export interface AgentMetaAvailabilityResult {
  type: 'agent-meta-availability-result'
  seq: number
  entries: Array<{ nodeId: NodeId; available: boolean }>
}

/** Which Jev passes an agent search ran. See `src/server/agent-search.ts`. */
export type AgentSearchPass = 'titles' | 'transcripts'

/**
 * `auto` runs the titles pass, then the transcripts pass only if needed.
 * `transcripts` runs just the transcripts pass, for when the user wants it
 * after an `auto` search stopped at titles.
 */
export type AgentSearchMode = 'auto' | 'transcripts'

export interface AgentSearchHit {
  nodeId: NodeId
  probability: number
}

/**
 * Ask Jev which agent surface — live, or one of the most recently archived —
 * a free-text query is about. Answered with an `agent-search-result`.
 */
export interface AgentSearchMessage {
  type: 'agent-search'
  seq: number
  query: string
  /** Absent means `auto`. */
  mode?: AgentSearchMode
}

export type AgentSearchResult =
  | {
      type: 'agent-search-result'
      seq: number
      ok: true
      /** The last pass that ran: `transcripts` means both did. */
      pass: AgentSearchPass
      /** Every candidate, most probable first. */
      hits: AgentSearchHit[]
      noneProbability: number
      /** Summed over the passes this request ran; null if a pass could not be priced. */
      costUsd: number | null
    }
  | { type: 'agent-search-result'; seq: number; ok: false; error: string }

export type ClientMessage =
  | ShipItMessage
  | ClientLogMessage
  | MobileEventsMessage
  | AgentMemoryQueryMessage
  | TerminalBorrowSizeMessage
  | TerminalReturnSizeMessage
  | DictationStartMessage
  | DictationAudioMessage
  | DictationFinishMessage
  | DictationCancelMessage
  | DictationTurnCheckMessage
  | WakeWordCheckMessage
  | ReceptionistHandsFreeMessage
  | AgentSearchMessage
  | AgentMetaAvailabilityQueryMessage
  | AgentMetaToggleMessage
  | AgentMetaRescanMessage
  | MetaDocResizeMessage
  | MetaDocContentMessage
  | ModMessage
  | ClientHelloMessage
  | CreateMessage
  | ListMessage
  | ServerRestartMessage
  | RestartFlagQueryMessage
  | UsageReportQueryMessage
  | SystemStatsWatchMessage
  | ApprovalsWatchMessage
  | ApprovalReplyMessage
  | ApprovalPairMessage
  | AttachMessage
  | DetachMessage
  | DestroyMessage
  | WriteMessage
  | NodeSyncRequestMessage
  | NodeMoveMessage
  | NodeBatchMoveMessage
  | NodeRenameMessage
  | NodeSetColorMessage
  | NodeSetStampMessage
  | NodeRegenerateAutoStampMessage
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
  | NodeInteractionMessage
  | SetClaudeStatusUnreadMessage
  | SetClaudeStatusAsleepMessage
  | SetClaudeStatusBackgroundMessage
  | DirectoryAddMessage
  | DirectoryCwdMessage
  | DirectoryGitFetchMessage
  | DirectoryGitRunMessage
  | DirectoryOpenGitHubDesktopMessage
  | ValidateDirectoryMessage
  | FileAddMessage
  | FilePathMessage
  | ValidateFileMessage
  | TitleAddMessage
  | TitleTextMessage
  | CacheTimerMuteMessage
  | ForkSessionMessage
  | TerminalRestartMessage
  | CrabReorderMessage
  | SetAlertsReadTimestampMessage
  | UndoBufferPushMessage
  | UndoBufferSetCursorMessage
  | CameraBoundsMessage
  | FocusIdRequestMessage
  | FocusClaudeSessionMessage
  | SummaryChatToggleMessage
  | SummaryChatFollowUpMessage
  | SummaryChatEndMessage
  | SpeechProgressMessage
  | MobileAppInstallMessage
  | SpeakToggleMessage
  | SpeakStopMessage
  | SaveViewportMessage
  | SetRootCwdMessage
  | SetAutoStampsEnabledMessage
  | ReceptionistSelectMessage
  | ReceptionistSayMessage
  | ReceptionistTranscriptMessage
  | ReceptionistStopMessage
  | ReceptionistHoldMessage
  | ReceptionistReadMessage
  | ReceptionistReplayMessage
  | ReceptionistReplayStopMessage
  | ReceptionistCatchUpMessage

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

/** Reply to {@link RestartFlagQueryMessage}: the current restart-required state. */
export interface RestartFlagResultMessage {
  type: 'restart-flag-result'
  seq: number
  required: boolean
  /** Human-readable why, or '' when not required. */
  reason: string
}

/**
 * Unsolicited broadcast: the restart-required flag changed. The PUSH half of the
 * signal, so a badge appears the moment an agent raises the flag mid-session
 * without waiting for a reload. See `src/server/restart-flag.ts`.
 */
export interface RestartRequiredMessage {
  type: 'restart-required'
  required: boolean
  /** Human-readable why, or '' when not required. */
  reason: string
}

/** Reply to {@link UsageReportQueryMessage}; null until the tracker has been read. */
export interface UsageReportResultMessage {
  type: 'usage-report-result'
  seq: number
  snapshot: UsageSnapshot | null
}

/**
 * One sentence of a speech job for this client to play, after any before it.
 * Signed 16-bit mono PCM, base64. See `src/server/remote-speech.ts`.
 */
export interface SpeechAudioMessage {
  type: 'speech-audio'
  id: string
  index: number
  /** Sentences in the whole job; the last is `count - 1`. */
  count: number
  sampleRate: number
  pcm: string
}

/**
 * Reply to {@link MobileAppInstallMessage}. A success rarely arrives: the new
 * app replaces the one that asked.
 */
export interface MobileAppInstallResultMessage {
  type: 'mobile-app-install-result'
  seq: number
  ok: boolean
  message?: string
}

/** Stop playing a speech job now, and drop what is queued of it. */
export interface SpeechStopMessage {
  type: 'speech-stop'
  id: string
}

/**
 * Unsolicited broadcast: the server now serves a new build of the mobile web
 * app. A phone checks whether that leaves its page behind
 * (src/mobile/update-check.ts) rather than waiting for its next look.
 */
export interface MobileBuildChangedMessage {
  type: 'mobile-build-changed'
}

/** To watching clients only: the system monitor, or null when mini-stats is not running (PUSH). */
export interface SystemStatsMessage {
  type: 'system-stats'
  snapshot: SystemStatsSnapshot | null
}

/** To watching clients only: every pending approval request (PUSH). */
export interface ApprovalsMessage {
  type: 'approvals'
  snapshot: ApprovalsSnapshot
}

/** Reply to {@link ApprovalReplyMessage} or {@link ApprovalPairMessage}: the source's verdict. */
export interface ApprovalResultMessage {
  type: 'approval-result'
  seq: number
  outcome: ApprovalOutcome
}

/** Unsolicited broadcast: a new AI usage reading (PUSH). */
export interface UsageReportMessage {
  type: 'usage-report'
  snapshot: UsageSnapshot
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

// --- Server → Client node state messages ---

import type { ServerState, NodeData, NodeStamp, ReceptionistHolder } from './state'
import type { NodeId, PtySessionId, ClaudeSessionId } from './ids'
import type { UsageSnapshot } from './usage-report'
import type { SystemStatsSnapshot } from './system-stats'
import type { ApprovalOutcome, ApprovalsSnapshot, SignedApprovalReply } from './approvals'

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

export interface ServerErrorMessage {
  type: 'server-error'
  message: string
  /** When set, correlates with a pending client request so it can reject. */
  seq?: number
}

export interface PlaySoundServerMessage {
  type: 'play-sound'
  sound: SoundName
}

/** What a speak request did, as far as the listener is concerned. */
export type SpeakOutcome = 'started' | 'stopped' | 'unavailable' | 'muted' | 'empty'

/**
 * The answer to one `speak-toggle`, sent to the client that pressed the key
 * rather than broadcast — the toast it may raise belongs to one person.
 */
export interface SpeakToggleResultMessage {
  type: 'speak-toggle-result'
  seq: number
  outcome: SpeakOutcome
}

/**
 * Whether the direct speech path is saying anything, broadcast so every client
 * can play its start and stop cues.
 */
export interface SpeechActiveMessage {
  type: 'speech-active'
  active: boolean
}

export interface SpeakingChangedMessage {
  type: 'speaking-changed'
  nodeId: NodeId
  speaking: boolean
  voice?: string
}

/**
 * What a Summary Chat surface is doing.
 *
 * `thinking`, `synthesizing`, `speaking` and `ready` are one *phase*: the
 * server emits them from a single transition point, so exactly one is true at
 * a time and no consumer has to reconcile overlapping signals. `target` and
 * `error` are notifications about a surface that leave the phase alone.
 *
 * This mattered: the waiting cue used to be driven by "is thinking" while the
 * server left a surface in `thinking` for the whole duration of its spoken
 * answer, so the cue played *over* the speech — and never stopped at all if
 * the speech job never reached a terminal state.
 *
 * `synthesizing` exists for the same reason, one handoff earlier. It is the
 * stretch after Voice Operator has accepted the speech job and before any
 * sound comes out of it — a wait that *is* still a wait, but not spaceterm's
 * any more. Voice Operator runs its own echo and its own menu-bar colour
 * across exactly this window, so a surface that stayed `thinking` here put two
 * different waiting cues on top of each other. The rule the phase encodes:
 * spaceterm is audible only while Haiku is the thing being waited on.
 */
export type SummaryChatPhase = 'thinking' | 'synthesizing' | 'speaking' | 'ready'
/**
 * `ended`: the surface's conversation has been abandoned and forgotten — the
 * phone's talk button goes with it. See `SummaryChat.end`.
 */
export type SummaryChatUiState = SummaryChatPhase | 'target' | 'error' | 'ended'

/** Summary Chat lifecycle for the toolbar's thinking and target indicators. */
export interface SummaryChatStatusMessage {
  type: 'summary-chat-status'
  nodeId: NodeId
  state: SummaryChatUiState
  message?: string
}

/** What one press of the chord turned out to mean. */
export type SummaryChatToggleOutcome = 'started' | 'cancelled' | 'rejected'

/**
 * The answer to one `summary-chat-toggle`, sent to the client that pressed the
 * key rather than broadcast.
 *
 * The press produces feedback that belongs to a person — a confirming chirp, an
 * abort chirp, a shake and a toast — and there is exactly one person it belongs
 * to. Phase changes stay broadcast, because every client draws them.
 */
export interface SummaryChatToggleResultMessage {
  type: 'summary-chat-toggle-result'
  seq: number
  outcome: SummaryChatToggleOutcome
  /** Why the press was rejected. Present only for `rejected`. */
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

/**
 * Sent to exactly one client, instructing it to raise its window and show what
 * a focus request named.
 *
 * `nodeId: null` is the answer to a request whose id matched nothing — not on
 * the canvas and not in the archive either, so a stale or rotated surface id, a
 * deleted surface, or a typo. The client still raises, but zooms out to the
 * whole canvas instead of flying to a node, so the user sees that they landed
 * in spaceterm without their surface rather than being left staring at whatever
 * they happened to be zoomed into. Silence would be indistinguishable from a
 * successful focus on the surface already under the camera.
 *
 * An id the server found in the archive arrives here as an ordinary node id:
 * the server restores that surface first, so by the time this message is sent
 * the node exists and is focused like any other.
 */
export interface FocusSurfaceMessage {
  type: 'focus-surface'
  nodeId: NodeId | null
}

/**
 * The root node's working directory. Sent on connect and broadcast on every
 * change; `cwd` is absent when the root supplies none.
 */
export interface RootCwdMessage {
  type: 'root-cwd'
  cwd?: string
}

/**
 * The receptionist's lifecycle. Sent on connect and broadcast on every change.
 * `target` says whether the listener's voice currently goes to it rather than
 * to Summary Chat; `message` explains an error.
 */
export interface ReceptionistStatusMessage {
  type: 'receptionist-status'
  phase: SummaryChatPhase
  target: boolean
  message?: string
  /** Who is being heard while `phase` is `speaking`: "Control", or the agent it is quoting. */
  speaker?: string
}

/**
 * How many of Control's replies were written to a muted device and are not
 * read yet, and where the oldest of them is in the record. Sent on connect
 * and broadcast on every change.
 */
export interface ReceptionistUnreadMessage {
  type: 'receptionist-unread'
  count: number
  first?: number
}

/** This client's replay: the part playing, or null once it has stopped. Sent only to the client that asked. */
export interface ReceptionistReplayingMessage {
  type: 'receptionist-replaying'
  playing: { of: number; part: number } | null
  /** Why it would not play, when it would not. */
  refused?: string
}

/** Which device holds Control, if any. Sent on connect and broadcast on every change. */
export interface ReceptionistHolderMessage {
  type: 'receptionist-holder'
  holder: ReceptionistHolder | null
}

/**
 * One entry of Control's full record (`~/.spaceterm/receptionist/conversation.jsonl`),
 * which compaction never touches: what the user said, what Control said —
 * each part in the voice it was spoken in — or something Control did.
 */
export type ControlTranscriptEntry = {
  /** Where it starts in the record, in bytes: its id, and the cursor for the page before it. */
  offset: number
  /** When it was recorded, ISO. */
  timestamp: string
} & (
  /** `context` is what came with the user's words: events, news on their return. */
  | { kind: 'user'; text: string; context?: string }
  /**
   * `from` is "Control", or the agent Control quoted in its voice. `delivery`
   * is `text` when it was written to a muted device rather than spoken: unread
   * until it is read (see `consumed`).
   */
  | { kind: 'reply'; parts: Array<{ from: string; text: string }>; delivery?: 'text' }
  /**
   * Something Control did: sent to an agent, started, archived, renamed one.
   * `notDone` when it never ran, because the user spoke before Control's reply was said.
   */
  | { kind: 'log'; text: string; notDone?: true }
  /**
   * Not shown itself: the reply at offset `of` was cut off, and `parts[i]` is
   * how many characters of its part `i` were heard. The rest is shown as not
   * heard. `unread` when the rest went on as text instead — the user muted
   * Control partway through it — so it is unread rather than lost.
   */
  | { kind: 'heard'; of: number; parts: number[]; unread?: true }
  /**
   * Not shown itself: part `part` of the reply at `of` has since been taken
   * in — characters `from` to `to` of it — by reading it, hearing it replayed,
   * or hearing Control sum it up.
   */
  | { kind: 'consumed'; of: number; part: number; from: number; to: number; how: 'read' | 'replayed' | 'summary' }
  /** Why Control did or did not speak: see `ControlTrace`. Shown only when the view is asked to show Control's reasoning. */
  | ({ kind: 'trace' } & ControlTrace)
)

/**
 * What Control's reasoning entries are about, which the transcript view
 * colours by: news arriving (`events`), or a turn on it dropped and its news
 * kept for the next (`requeued`); the backlog gaining an item, losing one, or
 * holding back while the user is mid-topic; a watch on an agent set up,
 * firing, or ending; a reply that was never spoken; Control cutting its own
 * reply short for news.
 */
export type ControlTraceKind =
  | 'events' | 'requeued'
  | 'backlog-add' | 'backlog-take' | 'backlog-back' | 'backlog-dropped' | 'backlog-wait'
  | 'watch' | 'fired' | 'unwatch'
  | 'unspoken' | 'cut-in'

/** One reasoning entry: a line, and the detail behind it when there is more to say. */
export interface ControlTrace {
  what: ControlTraceKind
  text: string
  detail?: string
}

/** A page of the record, oldest first; `more` when the record goes back further. */
export interface ReceptionistTranscriptResultMessage {
  type: 'receptionist-transcript-result'
  seq: number
  entries: ControlTranscriptEntry[]
  more: boolean
}

/** Entries just added to Control's record. Broadcast; not replayed — a page request catches up. */
export interface ReceptionistTranscriptAppendedMessage {
  type: 'receptionist-transcript-appended'
  entries: ControlTranscriptEntry[]
}

/**
 * Move the camera to a surface because the conversation is about it — the
 * receptionist naming or quoting an agent. Unlike `focus-surface` it never
 * raises a window or takes focus: it follows talk, it does not answer a request.
 */
export interface CameraFollowMessage {
  type: 'camera-follow'
  nodeId: NodeId
}

/**
 * Something the receptionist did that costs money, worth a toast on every
 * client — a fork of an agent, or a follow-up to one — with what it cost.
 * Not replayed to late clients: it is news, not state.
 */
export interface ReceptionistNoticeMessage {
  type: 'receptionist-notice'
  text: string
}

/**
 * Every agent surface's receptionist name, whole, keyed by node id. Sent on
 * connect and broadcast whenever a name is assigned or released.
 */
export interface AgentNamesMessage {
  type: 'agent-names'
  names: Record<string, string>
}

/** Whether auto-stamp generation is on. Sent on connect and broadcast on every change. */
export interface AutoStampsEnabledMessage {
  type: 'auto-stamps-enabled'
  enabled: boolean
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
  /**
   * Mod envelopes to receive, by `modId`. Omit for none.
   *
   * Opt-in rather than opt-out, and not covered by the `events` wildcard: a
   * script asking for "all events" wants spaceterm's events, not every other
   * mod's private traffic. A mod that genuinely wants to observe another names
   * it, which is also what makes that dependency visible.
   */
  modIds?: string[]
}

/**
 * Version handshake. A script sends this first; the reply says what this build
 * speaks and what it offers, so a script can fail loudly on a mismatch instead
 * of misreading a message it half-understands.
 *
 * Optional — every existing tool works without it — but a mod should send it.
 */
/**
 * A mod process emitting one envelope to the rest of spaceterm.
 *
 * Fire-and-forget: the reply only acknowledges receipt, because the base has
 * no idea what a meaningful answer would be. A mod that wants a response
 * defines one in its own vocabulary and correlates it itself.
 */
export interface ScriptModEmitMessage {
  type: 'script-mod-emit'
  seq: number
  modId: string
  event: string
  payload: unknown
}

export interface ScriptHelloMessage {
  type: 'script-hello'
  seq: number
  /** The version the script was written against. */
  protocolVersion: number
  /** Free-form identifier for logs, e.g. "spaceterm-mcp/1.2.0". */
  client?: string
  /**
   * The mod this connection belongs to, matching a manifest's `id`.
   *
   * Optional, and omitting it means unscoped access — which is what the nine
   * existing MCP tools do. Sending it is how a mod opts into being held to its
   * manifest, so capability scoping can land without breaking anything.
   */
  modId?: string
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
  | ScriptModEmitMessage
  | ScriptHelloMessage
  | ScriptGetAncestorsMessage
  | ScriptGetNodeMessage
  | ScriptShipItMessage
  | ScriptSubscribeMessage
  | ScriptForkClaudeMessage
  | ScriptUnreadMessage
  | ScriptResolveHandoffMessage

// --- Script socket responses ---

export interface ScriptModEmitResult {
  type: 'script-mod-emit-result'
  seq: number
  /** How many listeners it reached. Zero is normal and not an error. */
  delivered: number
}

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
  /** The name the receptionist gave this surface's agent ("Kevin"), if it has one. */
  agentName?: string
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
  | ScriptModEmitResult
  | ScriptHelloResult
  | ScriptGetAncestorsResult
  | ScriptGetNodeResult
  | ScriptShipItResult
  | ScriptSubscribeResult
  | ScriptForkClaudeResult
  | ScriptResolveHandoffResult

export interface DictationStartedMessage {
  type: 'dictation-started'
  seq: number
  id: string
}

export interface DictationResultMessage {
  type: 'dictation-result'
  seq: number
  /** Exactly what Wispr returned, trailing space and all. */
  text: string
}

/**
 * The verdict on a `wake-word-check`. A failed check (Voice Operator not
 * running, too old) is no match plus `error`, not a `server-error`: a broadcast
 * error would toast on every short word said near the phone.
 */
/** Probability, 0..1, that the speaker has finished; null when the server has no turn model. */
export interface DictationTurnResultMessage {
  type: 'dictation-turn-result'
  seq: number
  probability: number | null
}

export interface WakeWordResultMessage {
  type: 'wake-word-result'
  seq: number
  match: boolean
  error?: string
  /**
   * Which question was answered. A server too old for `speech` answers the
   * wake-word question instead and leaves this out — which is how the phone
   * tells it is talking to a server that needs restarting, rather than going
   * quietly deaf in the conversation window.
   */
  mode?: 'wake-word' | 'speech'
  /** For `speech`: the words began with the wake word ("Control." alone, in the window). */
  wakeWord?: boolean
}

/**
 * Hands-free mode's thresholds, in milliseconds but for `turnThreshold`. Defaults live with
 * the listener (`src/mobile/wake-listener.ts`); the operator overrides any of
 * them in `~/.spaceterm/hands-free.json`, read again whenever it changes.
 */
export interface HandsFreeTuning {
  /**
   * No speech for this long before speech for its start to be checked for the
   * wake word — speech as a voice-activity model hears it, so music or a noisy
   * room does not count, only someone talking.
   */
  noSpeechBeforeMs: number
  /** How much of the start of what is said is sent to be checked. */
  onsetWindowMs: number
  /** Shorter bursts of speech (a click, a cough) are not checked at all. */
  wordMinMs: number
  /**
   * After the wake word, at each pause this long: ask the turn model whether
   * the speaker sounds finished (src/server/turn-detector.ts).
   */
  pauseCheckMs: number
  /** Its probability at or above this — 0 to 1, not ms — ends the dictation there and then. */
  turnThreshold: number
  /**
   * A first pause this soon after the start is the one after "Control." said
   * on its own: the turn model is not asked about it, and it waits at least
   * `afterWakeWordMs` for the speaker to go on.
   */
  wakeWordOnlyMs: number
  afterWakeWordMs: number
  /**
   * Otherwise — the model unsure, or unavailable — quiet this long ends it: from
   * `endSilenceMinMs` for a short request, growing with how long the speaker has
   * been going to `endSilenceMaxMs` at `endSilenceRampMs`, room for a next thought.
   */
  endSilenceMinMs: number
  endSilenceMaxMs: number
  endSilenceRampMs: number
  /** The longest anything said hands-free may run. */
  maxUtteranceMs: number
  /** After this device stops playing sound, how long before listening resumes (echo). */
  playbackTailMs: number
  /**
   * The conversation window: after "Control", anything said starts a
   * dictation without it, until neither side has spoken for this long. Paused
   * while either is speaking.
   */
  conversationMs: number
  /** Words that do not count as speech in the conversation window (server-side; see hands-free.ts). */
  ignoredWords?: string[]
}

/** The operator's overrides from `~/.spaceterm/hands-free.json`. Sent on connect and on every change. */
export interface HandsFreeTuningMessage {
  type: 'hands-free-tuning'
  tuning: Partial<HandsFreeTuning>
}

export interface AgentMemoryResultMessage {
  type: 'agent-memory-result'
  seq: number
  /** Bytes, or null when no daemon is running. */
  bytes: number | null
}

export type ServerMessage =
  | AgentMemoryResultMessage
  | DictationStartedMessage
  | DictationResultMessage
  | AgentMetaAvailabilityResult
  | AgentSearchResult
  | AgentMetaToggleResult
  | AgentMetaAvailabilityMessage
  | ModMessage
  | ClientHelloResult
  | CreatedMessage
  | ServerRestartedMessage
  | ListedMessage
  | AttachedMessage
  | DetachedMessage
  | DestroyedMessage
  | DataMessage
  | ExitMessage
  | SyncStateMessage
  | NodeUpdatedMessage
  | NodeAddedMessage
  | NodeRemovedMessage
  | MutationAckMessage
  | NodeAddAckMessage
  | SnapshotMessage
  | ValidateDirectoryResult
  | DirectoryCommandResult
  | ValidateFileResult
  | FileContentMessage
  | ServerErrorMessage
  | PlaySoundServerMessage
  | SpeakToggleResultMessage
  | SpeechActiveMessage
  | SpeakingChangedMessage
  | SummaryChatStatusMessage
  | SummaryChatToggleResultMessage
  | PeerConnectedMessage
  | PeerDisconnectedMessage
  | PeerCameraBoundsMessage
  | FocusSurfaceMessage
  | SavedViewportsMessage
  | RootCwdMessage
  | AutoStampsEnabledMessage
  | ReceptionistStatusMessage
  | ReceptionistHolderMessage
  | ReceptionistUnreadMessage
  | ReceptionistReplayingMessage
  | CameraFollowMessage
  | ReceptionistNoticeMessage
  | ReceptionistTranscriptResultMessage
  | ReceptionistTranscriptAppendedMessage
  | WakeWordResultMessage
  | HandsFreeTuningMessage
  | DictationTurnResultMessage
  | AgentNamesMessage
  | RestartFlagResultMessage
  | RestartRequiredMessage
  | UsageReportResultMessage
  | UsageReportMessage
  | SystemStatsMessage
  | SpeechAudioMessage
  | ApprovalsMessage
  | ApprovalResultMessage
  | SpeechStopMessage
  | MobileAppInstallResultMessage
  | MobileBuildChangedMessage
