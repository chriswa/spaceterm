/**
 * The contextBridge contract — the single source of truth for `window.api`.
 *
 * This shape was previously declared three times: once in `src/client/preload/index.ts`
 * (as the annotation on the object literal that implements it) and once in
 * `src/client/renderer/src/global.d.ts` (as what the renderer type-checks against),
 * with `src/shared/protocol.ts` separately owning the wire types. Nothing linked the
 * copies, because preload lives in the `tsconfig.node.json` project and the renderer
 * in `tsconfig.web.json`, and `global.d.ts` was a `.d.ts` that `skipLibCheck` skipped
 * entirely. They drifted: `directoryAdd`'s parameters were declared in the opposite
 * order from the implementation, eleven implemented members were missing from the
 * preload interface, and six were missing from the renderer's.
 *
 * Both sides now import from here, so a change to the bridge is one edit and any
 * mismatch is a compile error in the project that got it wrong.
 *
 * Rule of thumb when editing: this file describes the *IPC bridge*, not the socket
 * protocol. Wire message shapes live in `./protocol` — import them here rather than
 * restating them.
 */
import type {
  AgentSearchMode,
  AgentSearchResult,
  DirectoryCommandResult,
  CameraBounds,
  ClaudeSessionEntry,
  CreateOptions,
  SessionInfo,
  SnapshotMessage,
  SpeakOutcome,
  SummaryChatMode,
  SummaryChatPhase,
  SummaryChatToggleOutcome,
  SummaryChatUiState, SpeechProgressEvent, HandsFreeTuning, ControlTranscriptEntry
} from './protocol'
import type { LaunchPrefs } from './launch-prefs'
import type { NodeData, NodeStamp, ReceptionistHolder, ServerState } from './state'
import type { SystemMetricsSample } from './system-metrics'
import type { UndoEntry } from './undo-types'
import type { NodeId, PtySessionId } from './ids'
import type { UsageSnapshot } from './usage-report'
import type { ApprovalOutcome, ApprovalsSnapshot, SignedApprovalReply } from './approvals'
import type { SystemStatsSnapshot } from './system-stats'

export type { CameraBounds, ClaudeSessionEntry, CreateOptions, SessionInfo }

/**
 * `pty:attach` forwards exactly the fields carried by the `attached` wire message
 * (see `AttachedMessage` in ./protocol): the terminal's serialized state and
 * nothing else. Surface metadata — context %, line count, title history, cwd,
 * claudeSessionHistory — is node state and arrives via node-updated, so nothing
 * needs to attach to learn about a surface; attaching starts the raw stream.
 */
export interface AttachResult {
  scrollback: string
}

export interface PtyApi {
  create(options?: CreateOptions): Promise<SessionInfo>
  list(): Promise<SessionInfo[]>
  attach(sessionId: PtySessionId): Promise<AttachResult>
  write(sessionId: PtySessionId, data: string): void
  destroy(sessionId: PtySessionId): Promise<void>
  onData(sessionId: PtySessionId, callback: (data: string) => void): () => void
  onExit(sessionId: PtySessionId, callback: (exitCode: number) => void): () => void
}

/** How a command the server ran in a directory node's cwd ended. */
export type CommandOutcome = Pick<DirectoryCommandResult, 'ok' | 'error'>

/** An `agent-search-result` without its wire envelope. */
export type AgentSearchResponse = AgentSearchResult extends infer R ? (R extends unknown ? Omit<R, 'type' | 'seq'> : never) : never

export interface NodeApi {
  syncRequest(): Promise<ServerState>
  move(nodeId: NodeId, x: number, y: number): Promise<void>
  batchMove(moves: Array<{ nodeId: NodeId; x: number; y: number }>): Promise<void>
  rename(nodeId: NodeId, name: string): Promise<void>
  setColor(nodeId: NodeId, colorPresetId: string): Promise<void>
  setStamp(nodeId: NodeId, stamp: NodeStamp): Promise<void>
  /** Replace the node's auto-stamp with a different icon. */
  regenerateAutoStamp(nodeId: NodeId): Promise<void>
  /** Archive a node and everything beneath it, as one restorable entry. */
  archive(nodeId: NodeId): Promise<void>
  /**
   * Restore an archive entry, and the subtree archived with it, under
   * `parentNodeId`. `path` names the entry from that node's archive down — see
   * `NodeUnarchiveMessage`.
   */
  unarchive(parentNodeId: NodeId, path: NodeId[]): Promise<void>
  archiveDelete(parentNodeId: NodeId, path: NodeId[]): Promise<void>
  undoPush(entry: UndoEntry): Promise<void>
  undoSetCursor(cursor: number): Promise<void>
  bringToFront(nodeId: NodeId): Promise<void>
  /** Fire-and-forget: record a genuine user interaction (e.g. a keystroke) with a node. */
  recordInteraction(nodeId: NodeId): void
  reparent(nodeId: NodeId, newParentId: NodeId): Promise<void>
  swapParentChild(nodeId: NodeId, childId: NodeId): Promise<void>

  terminalCreate(
    parentId: NodeId,
    options?: CreateOptions,
    initialTitleHistory?: string[],
    initialName?: string,
    x?: number,
    y?: number,
    initialInput?: string,
  ): Promise<SessionInfo>
  terminalResize(nodeId: NodeId, cols: number, rows: number): Promise<void>
  /**
   * Fit a surface to this client for a while, without changing its own size:
   * the server gives that back on `terminalReturnSize`, on disconnect, or at
   * its next start. See `TerminalBorrowSizeMessage`.
   */
  terminalBorrowSize(nodeId: NodeId, cols: number, rows: number): Promise<void>
  terminalReturnSize(nodeId: NodeId): Promise<void>
  terminalReincarnate(nodeId: NodeId, options?: CreateOptions): Promise<SessionInfo>
  terminalRestart(nodeId: NodeId, extraCliArgs: string): Promise<SessionInfo>
  forkSession(nodeId: NodeId): Promise<SessionInfo>
  /**
   * Paste `text` into a live terminal surface and submit it. The server owns
   * the paste framing and the submit delay — see `src/server/ship-it.ts`.
   */
  shipIt(nodeId: NodeId, text: string): Promise<void>
  setTerminalMode(sessionId: PtySessionId, mode: 'live' | 'snapshot'): void
  crabReorder(order: string[]): Promise<void>

  directoryAdd(parentId: NodeId, cwd: string, x?: number, y?: number): Promise<{ nodeId: NodeId }>
  directoryCwd(nodeId: NodeId, cwd: string): Promise<void>
  /**
   * Set the working directory the root node supplies to everything hung off it.
   * An empty string clears it, leaving top-level cards with no inherited cwd.
   */
  setRootCwd(cwd: string): Promise<void>
  /** Turn auto-stamp generation on or off, for every client. */
  setAutoStampsEnabled(enabled: boolean): Promise<void>
  directoryGitFetch(nodeId: NodeId): Promise<void>
  /**
   * Run `git pull`/`git push` in a new terminal child of the directory node.
   * Resolves when the command finishes; on failure its terminal stays open.
   */
  directoryGitRun(nodeId: NodeId, command: 'pull' | 'push'): Promise<CommandOutcome>
  /** Open the directory in GitHub Desktop, via its `github` CLI. */
  directoryOpenGitHubDesktop(nodeId: NodeId): Promise<CommandOutcome>
  validateDirectory(path: string): Promise<{ valid: boolean; error?: string }>

  fileAdd(parentId: NodeId, filePath: string, x?: number, y?: number): Promise<{ nodeId: NodeId }>
  filePath(nodeId: NodeId, filePath: string): Promise<void>
  validateFile(path: string, cwd?: string): Promise<{ valid: boolean; error?: string }>

  markdownAdd(parentId: NodeId, x?: number, y?: number): Promise<{ nodeId: NodeId }>
  markdownResize(nodeId: NodeId, width: number, height: number): Promise<void>
  markdownContent(nodeId: NodeId, content: string): Promise<void>
  markdownSetMaxWidth(nodeId: NodeId, maxWidth: number): Promise<void>

  /**
   * Open or close a host's agent-meta branch, resolving to whether it is open
   * afterwards. The server decides: only it knows whether the host's directory
   * has a CLAUDE.md or any skills.
   */
  agentMetaToggle(nodeId: NodeId): Promise<boolean>
  /** Re-read a branch's tree now rather than waiting for a filesystem event. */
  agentMetaRescan(nodeId: NodeId): Promise<void>
  metaDocResize(nodeId: NodeId, width: number, height: number): Promise<void>
  /** Edit a generated document. Written straight to the file; there is no node content. */
  metaDocContent(nodeId: NodeId, content: string): Promise<void>

  titleAdd(parentId: NodeId, x?: number, y?: number): Promise<{ nodeId: NodeId }>
  titleText(nodeId: NodeId, text: string): Promise<void>
  /** Mute or watch a surface's cache countdown. Muting a cold surface does nothing. */
  cacheTimerMute(nodeId: NodeId, muted: boolean): Promise<void>

  setClaudeStatusUnread(sessionId: PtySessionId, unread: boolean): void
  setClaudeStatusAsleep(sessionId: PtySessionId, asleep: boolean): void
  setClaudeStatusBackground(sessionId: PtySessionId, background: boolean): void
  setAlertsReadTimestamp(nodeId: NodeId, timestamp: number): void
  sendCameraBounds(bounds: CameraBounds): void
  saveViewport(slot: string, bounds: CameraBounds): void

  onSnapshot(sessionId: PtySessionId, callback: (snapshot: SnapshotMessage) => void): () => void
  onUpdated(callback: (nodeId: NodeId, fields: Partial<NodeData>) => void): () => void
  onAdded(callback: (node: NodeData) => void): () => void
  onRemoved(callback: (nodeId: NodeId) => void): () => void
  onFileContent(callback: (nodeId: NodeId, content: string) => void): () => void
  onServerError(callback: (message: string) => void): () => void
  onPlaySound(callback: (sound: string) => void): () => void
  onSpeakingChanged(
    callback: (nodeId: NodeId, speaking: boolean, voice: string | undefined) => void,
  ): () => void
  onSummaryChatStatus(
    callback: (nodeId: NodeId, state: SummaryChatUiState, message?: string) => void,
  ): () => void
  onSavedViewports(callback: (viewports: Record<string, CameraBounds>) => void): () => void
  /** The root node's working directory, pushed on connect and on every change. */
  onRootCwd(callback: (cwd: string | undefined) => void): () => void
  /** Whether auto-stamp generation is on, pushed on connect and on every change. */
  onAutoStampsEnabled(callback: (enabled: boolean) => void): () => void
  /** Live changes to the restart-required flag (PUSH). See restartFlagStatus for the PULL. */
  onRestartRequired(callback: (required: boolean, reason: string) => void): () => void
  /** Whether a host has an agent-meta branch to show, as the server learns it (PUSH). */
  onAgentMetaAvailability(callback: (nodeId: NodeId, available: boolean) => void): () => void
  /**
   * Every host's availability right now (PULL). Authoritative on every renderer
   * (re)load — the PUSH above fires on socket connect and then only on change,
   * so a renderer that loaded after it, or reloaded over a socket that stayed
   * up, would never hear anything and would show every button greyed out.
   */
  agentMetaAvailabilityStatus(): Promise<Array<{ nodeId: NodeId; available: boolean }>>
  /**
   * Ask Jev which agent surface a free-text query is about. Takes seconds, and
   * spends money: one or two TypeSafe requests. See `src/server/agent-search.ts`.
   */
  agentSearch(query: string, mode: AgentSearchMode): Promise<AgentSearchResponse>
  /**
   * Current restart-required state (PULL). Authoritative on every renderer
   * (re)load — the PUSH above does not repeat across a reload that keeps the
   * main-process socket open.
   */
  restartFlagStatus(): Promise<{ required: boolean; reason: string }>
  /** Each new AI usage reading from AI Spend Tracker (PUSH). */
  onUsageReport(callback: (snapshot: UsageSnapshot) => void): () => void
  /** The server is serving a new mobile web build (PUSH). */
  onMobileBuildChanged(callback: () => void): () => void
  /** The latest AI usage reading (PULL), or null until there is one. */
  usageReportStatus(): Promise<UsageSnapshot | null>
  /**
   * The Mac's system monitor from mini-stats, at once and on every change,
   * until the returned function is called — the server reads it only while
   * someone watches. Null while mini-stats is not running.
   */
  watchSystemStats(callback: (snapshot: SystemStatsSnapshot | null) => void): () => void
  /**
   * Pending approval requests (opProxy's), at once and on every change, until
   * the returned function is called. Asked for again on every reconnect, so a
   * phone that was away sees what is pending the moment it is back.
   */
  watchApprovals(callback: (snapshot: ApprovalsSnapshot) => void): () => void
  /** Answer an approval request with a reply the phone's native code signed; resolves with the source's verdict. */
  answerApproval(source: string, id: string, reply: SignedApprovalReply): Promise<ApprovalOutcome>
  /** Ask an approval source to trust this phone's key. Someone at the Mac has to confirm it. */
  pairApprovalSource(source: string, publicKey: string, name: string): Promise<ApprovalOutcome>
}

/** Status the toolbar renders for a surface's summary-chat session. */
export type { SummaryChatPhase, SummaryChatUiState, SummaryChatToggleOutcome, SummaryChatMode } from './protocol'

/**
 * What one press of the Summary Chat chord did.
 *
 * The press is a toggle whose meaning the server decides, so the outcome is the
 * only way the renderer knows which feedback to give: a confirming chirp, an
 * abort chirp, or a shake and a toast carrying `message`.
 */
export interface SummaryChatToggleResult {
  outcome: SummaryChatToggleOutcome
  message?: string
}

/**
 * Speech for text the app already has in hand: a terminal selection.
 *
 * Every member routes to the server, which owns the Voice Operator job. The
 * renderer deliberately keeps no "am I speaking" flag of its own: it used to,
 * and that second opinion drifted from the engine's whenever an utterance ended
 * on its own.
 */
export interface TtsApi {
  /**
   * Speak the text, or stop if this path is already speaking — the server
   * decides which, since only it knows whether a job is still live. Sending
   * empty text is how a press with no selection still stops speech.
   */
  toggle(text: string): Promise<SpeakOutcome>
  /** Stop anything being said. A no-op when nothing is. */
  stop(): void
  /** Fires whenever speech starts or stops, on this client or another. */
  onActiveChanged(callback: (active: boolean) => void): () => void
}

/**
 * Dictation for a client that captures audio but cannot transcribe it — the
 * phone. The server relays PCM through Voice Operator; see
 * `src/server/remote-dictation.ts`. Unused on the desktop, where Voice
 * Operator listens to the microphone itself.
 */
export interface DictationApi {
  /**
   * Open a session for s16le mono PCM at `sampleRate`. Rejects with a readable
   * reason. `forControl`: the words go to Control, which then waits for them
   * — so the caller must hand them over, or say there were none.
   */
  start(sampleRate: number, forControl?: boolean): Promise<string>
  /** One chunk, base64. */
  audio(id: string, pcmBase64: string): void
  /** No more audio; resolves to the transcript exactly as Wispr returned it. */
  finish(id: string): Promise<string>
  cancel(id: string): void
  /**
   * At a pause: the probability, 0..1, that the speaker has finished — the
   * server's turn model on the audio sent so far. Null when it has none.
   */
  turnCheck(id: string): Promise<number | null>
}

/**
 * A wake-word or speech check's answer. `answered`: which question the server
 * answered — absent from one too old to know `speech`. `wakeWord`: a `speech`
 * check's words began with "control".
 */
export interface WakeWordCheckResult {
  match: boolean
  error?: string
  answered?: 'wake-word' | 'speech'
  wakeWord?: boolean
}

/**
 * Hands-free mode: a client holding its microphone open listens for the wake
 * word on its own, and talks to Control without a press. See
 * `src/mobile/hands-free.ts`.
 */
export interface HandsFreeApi {
  /**
   * Is this clip (16 kHz s16le mono, base64) the wake word alone? Checked on
   * the Mac, on-device. `error` says why it could not be checked at all.
   */
  checkWakeWord(pcmBase64: string, mode?: 'wake-word' | 'speech'): Promise<WakeWordCheckResult>
  /**
   * Words said after the wake word: to Control, which comes to this device.
   * `interrupted`: the wake word cut Control's reply off — with no words, it
   * then says it had not finished and carries on.
   */
  say(text: string, interrupted?: boolean): void
  /** The operator's tuning overrides; replayed to a late subscriber. */
  onTuning(callback: (tuning: Partial<HandsFreeTuning>) => void): () => void
}

/**
 * Speech played on this client — the phone — rather than by Voice Operator on
 * the Mac: audio arrives a sentence at a time, and the client reports what it
 * has played. See `src/server/remote-speech.ts`.
 */
export interface RemoteSpeechApi {
  onAudio(callback: (audio: { id: string; index: number; count: number; sampleRate: number; pcm: string }) => void): () => void
  onStop(callback: (id: string) => void): () => void
  progress(id: string, index: number, event: SpeechProgressEvent): void
}

/** A page of Control's record; `more` when it goes back further. */
export interface ControlTranscriptPage {
  entries: ControlTranscriptEntry[]
  more: boolean
}

/** What `receptionist-status` says, minus the envelope. */
export interface ReceptionistStatus {
  phase: SummaryChatPhase
  /** Whether the listener's voice goes to the receptionist rather than Summary Chat. */
  target: boolean
  /** Why it failed, when it did. */
  message?: string
}

/**
 * The receptionist, "Control": a server-side voice agent that talks about every
 * live agent surface. See `src/server/receptionist/`.
 *
 * The `on*` channels whose server message is "sent on connect and broadcast on
 * change" replay the latest value to a late subscriber, because the on-connect
 * push lands before the renderer has subscribed. `onCameraFollow` does not:
 * a camera move is an instruction for now, not state.
 */
export interface ReceptionistApi {
  /**
   * Press Control: bring it to this device and talk to it, or talk to it again
   * after Summary Chat, or — when it is here and talked to — let go of it,
   * which silences it until some device takes it. The server decides which.
   */
  select(): void
  /** Stop Control mid-answer without letting go of it, as a talk button pressed over it does. */
  stop(): void
  /** Words typed to Control: for it whatever the voice target, and they bring it here, as speaking to it does. */
  say(text: string): void
  /**
   * A page of Control's full record, oldest first: the newest entries, or
   * those before `before` (an entry's `offset`). Never what compaction left.
   */
  transcript(before?: number): Promise<ControlTranscriptPage>
  /** Entries as they join the record. Not replayed. */
  onTranscriptAppended(callback: (entries: ControlTranscriptEntry[]) => void): () => void
  /** This client's device, to tell whether it is the one holding Control. */
  readonly deviceId: string
  onStatus(callback: (status: ReceptionistStatus) => void): () => void
  /** Who holds Control: null when nobody does. */
  onHolder(callback: (holder: ReceptionistHolder | null) => void): () => void
  /** Every agent surface's name, whole, keyed by node id. */
  onAgentNames(callback: (names: Record<string, string>) => void): () => void
  /** Move the camera to a surface the conversation is about — no raise, no focus. */
  onCameraFollow(callback: (nodeId: NodeId) => void): () => void
  /** Something the receptionist spent money on, for a toast. Not replayed. */
  onNotice(callback: (text: string) => void): () => void
}

export interface PerfApi {
  startTrace(): Promise<void>
  stopTrace(): Promise<string>
}

/**
 * A mod's own wire, in both directions.
 *
 * Two methods rather than two per mod: `modId` namespaces the traffic and
 * `payload` is opaque, so the bridge does not widen when a mod is added. See
 * `ModMessage` in `./protocol` for why that is the whole design.
 */
export interface ModsApi {
  /** Send one envelope toward the server and any listening mod process. */
  send(modId: string, event: string, payload: unknown): void
  /**
   * Listen for envelopes belonging to one mod. Other mods' traffic is filtered
   * out here rather than delivered and ignored, so a mod cannot accidentally
   * come to depend on another's messages.
   */
  onMessage(modId: string, callback: (event: string, payload: unknown) => void): () => void
}

/**
 * The power monitor's feed.
 *
 * Sampling is opt-in rather than always-on: reading GPU and battery state
 * means spawning `ioreg` twice a second, and a measuring instrument that runs
 * unasked would show up in its own readings. `setMetricsEnabled(false)` stops
 * the timer outright.
 */
export interface SystemApi {
  setMetricsEnabled(enabled: boolean): void
  onMetrics(callback: (sample: SystemMetricsSample) => void): () => void
  /** What the *next* launch will use. */
  getLaunchPrefs(): Promise<LaunchPrefs>
  /** Merge a patch into the stored prefs. Returns what is now stored. */
  setLaunchPrefs(patch: Partial<LaunchPrefs>): Promise<LaunchPrefs>
  /** What the *running* process launched with, so unapplied changes are visible. */
  getActiveLaunchPrefs(): Promise<LaunchPrefs>
  /**
   * Total resident memory of every process under the PTY daemon, in bytes, or
   * `null` when no daemon is running. Polled by the toolbar's readout.
   */
  getAgentMemory(): Promise<number | null>
}

export interface WindowApi {
  /** Resize the window to fill the current display's work area (screen minus menu bar and dock). */
  fitToWorkArea(): Promise<void>
  onVisibilityChanged(callback: (visible: boolean) => void): () => void
  /**
   * Keyboard focus, which is *not* visibility: an unfocused window is still on
   * screen and may be the one being watched. Consumed by `frame-policy` to pick
   * a frame rate, never to decide whether to draw at all.
   */
  onFocusChanged(callback: (focused: boolean) => void): () => void
  /**
   * An external focus request (a `spaceterm-surface://` deep link) reached this
   * window. `null` means the id it carried matched nothing — no live surface, no
   * agent session, and nothing in the archive the server could restore: the
   * renderer zooms out to the whole canvas so the miss is visible, rather than
   * silently leaving the camera where it was.
   */
  onFocusNode(callback: (nodeId: NodeId | null) => void): () => void
}

/** The object exposed as `window.api` by `src/client/preload/index.ts`. */
export interface Api {
  pty: PtyApi
  node: NodeApi
  log(message: string): void
  /**
   * Press the Summary Chat chord. Pass the focused terminal surface, or
   * undefined when nothing eligible is focused — a press with nothing focused
   * still cancels whatever is speaking, in either mode.
   */
  toggleSummaryChat(nodeId: NodeId | undefined, mode: SummaryChatMode): Promise<SummaryChatToggleResult>
  /** Say something to Summary Chat, as Voice Operator's command mode would. */
  summaryChatFollowUp(text: string): void
  /** Abandon every Summary Chat conversation. */
  endSummaryChat(): void
  restartSpaceterm(): Promise<void>
  /**
   * Build the iPhone app on the Mac and install it on the paired phone. On
   * success the new app replaces this one, so mostly only failures come back.
   */
  installMobileApp(): Promise<{ ok: boolean; message?: string }>
  writeDebugLog(content: string): Promise<string>
  openExternal(url: string): Promise<void>
  tts: TtsApi
  dictation: DictationApi
  handsFree: HandsFreeApi
  remoteSpeech: RemoteSpeechApi
  receptionist: ReceptionistApi
  perf: PerfApi
  window: WindowApi
  system: SystemApi
  mods: ModsApi
}

/**
 * What the host a client runs in provides, as opposed to what the server does.
 *
 * `window.api` is assembled in the renderer from a `ServerClient` and one of
 * these (see `./client-api`). Electron's preload supplies the real window,
 * perf and system hooks; the mobile web app supplies what a browser can and
 * no-ops the rest. Everything that talks to the server is shared code, so it
 * behaves identically on both.
 */
export interface PlatformApi {
  log(message: string): void
  writeDebugLog(content: string): Promise<string>
  openExternal(url: string): Promise<void>
  /**
   * The server has accepted a restart; bring this client back up against the
   * new one. Electron exits for its supervisor to relaunch; a browser reloads.
   */
  restartClient(): void
  /** Bring this client to the front for a focus request the server routed here. */
  raiseWindow(): void
  /**
   * Ids from outside the app asking to be focused — Electron's
   * `spaceterm-surface://` deep links. The server resolves them.
   */
  onFocusRequest(callback: (id: string) => void): () => void
  perf: PerfApi
  window: Omit<WindowApi, 'onFocusNode'>
  /** Agent memory is measured by the server, not the host; see `createApi`. */
  system: Omit<SystemApi, 'getAgentMemory'>
  /** This client plays Summary Chat's speech itself, rather than the Mac. */
  playsSpeech?: boolean
}

export type ServerPipeEventKind = 'open' | 'data' | 'close'

/**
 * The renderer's end of Electron main's byte pipe to the server socket — see
 * `src/client/main/server-pipe.ts`. Text in both directions, unread by main.
 */
export interface ServerPipeBridge {
  open(attempt: string): void
  send(text: string): void
  close(): void
  onEvent(callback: (attempt: string, kind: ServerPipeEventKind, chunk?: string) => void): () => void
}

/** What Electron's preload exposes as `window.electronHost`. */
export interface ElectronHost {
  platform: PlatformApi
  pipe: ServerPipeBridge
}
