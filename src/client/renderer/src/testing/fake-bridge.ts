import type {
  AgentSearchResponse, CommandOutcome,
  Api, AttachResult, CameraBounds, CreateOptions, ModsApi, NodeApi, PerfApi, PtyApi,
  SessionInfo, SummaryChatMode, SummaryChatToggleResult, SummaryChatUiState, SystemApi, TtsApi, WindowApi, DictationApi, RemoteSpeechApi,
  ReceptionistApi, ReceptionistStatus, HandsFreeApi, WakeWordCheckResult, ControlTranscriptPage
} from '../../../../shared/api'
import type { SystemMetricsSample } from '../../../../shared/system-metrics'
import { DEFAULT_LAUNCH_PREFS, type LaunchPrefs } from '../../../../shared/launch-prefs'
import type { ControlTranscriptEntry, HandsFreeTuning, SnapshotMessage, SpeakOutcome } from '../../../../shared/protocol'
import type { NodeData, ReceptionistHolder, ServerState } from '../../../../shared/state'
import type { UndoEntry } from '../../../../shared/undo-types'
import type { NodeId, PtySessionId } from '../../../../shared/ids'
import type { UsageSnapshot } from '../../../../shared/usage-report'
import type { SystemStatsSnapshot } from '../../../../shared/system-stats'
import type { ApprovalOutcome, ApprovalsSnapshot } from '../../../../shared/approvals'

/**
 * A stand-in for `window.api`, the preload bridge.
 *
 * The bridge is the renderer's *only* Electron-specific dependency — no
 * `electron` import, no ipcRenderer, no node builtins anywhere in its reachable
 * graph (`renderer-purity.test.ts` keeps it that way). So faking this one
 * object is the whole cost of running the real renderer without Electron:
 * under jsdom for component tests, or injected into a real browser page.
 *
 * That matters because the Electron binary cannot be downloaded in the
 * container this project's agents and CI run in — `npm install
 * --ignore-scripts` skips the postinstall that fetches it. Everything under
 * `src/client/` was therefore untestable, which is why a whole class of work
 * kept being deferred to "do this at a keyboard".
 *
 * Three things make it useful rather than just present:
 *
 * - **It implements `Api` explicitly.** A method added to the bridge that is
 *   not added here is a compile error, so the fake cannot silently drift out of
 *   date and start lying about what the renderer can call.
 * - **It records every call**, so a test can assert what the renderer asked the
 *   server to do — which is most of what a renderer integration test is for.
 * - **It can push events**, so a test can drive the renderer from the server
 *   side: a node arriving, pty output, a peer's camera moving.
 *
 * Subscription channels come in two kinds and the difference is load-bearing:
 * `pty.*` and `node.onSnapshot` are per-session, everything else is global.
 * Getting that wrong produces a fake where output for one terminal shows up in
 * all of them.
 */

/** One recorded bridge call. */
export interface BridgeCall {
  method: string
  args: unknown[]
}

/** Registered listeners for one global channel. */
type Listeners<F> = Set<F>

/** Registered listeners keyed by pty session. */
type SessionListeners<F> = Map<string, Set<F>>

function subscribe<F>(set: Listeners<F>, fn: F): () => void {
  set.add(fn)
  return () => { set.delete(fn) }
}

function subscribeToSession<F>(map: SessionListeners<F>, sessionId: string, fn: F): () => void {
  const existing = map.get(sessionId) ?? new Set<F>()
  existing.add(fn)
  map.set(sessionId, existing)
  return () => { map.get(sessionId)?.delete(fn) }
}

function fireForSession<F extends (...a: never[]) => void>(
  map: SessionListeners<F>, sessionId: string, invoke: (fn: F) => void
): void {
  for (const fn of map.get(sessionId) ?? []) invoke(fn)
}

/** Responses the fake returns, overridable per test. */
export interface FakeBridgeResponses {
  syncRequest: ServerState
  /** Returned by every call that spawns or rebinds a pty. */
  sessionInfo: SessionInfo
  attach: AttachResult
  validate: { valid: boolean; error?: string }
  /** What every directory command (`directoryGitRun`, …) resolves to. */
  command: CommandOutcome
  newNodeId: NodeId
  /** What a `tts.toggle` press resolves to. */
  speakOutcome: SpeakOutcome
  /** What the next launch would use. `setLaunchPrefs` mutates this. */
  launchPrefs: LaunchPrefs
  /** What the running process launched with; differs once a change is unapplied. */
  activeLaunchPrefs: LaunchPrefs
  /** Current restart-required state returned by `restartFlagStatus` (the PULL). */
  restartFlag: { required: boolean; reason: string }
  /** What `usageReportStatus` returns (the PULL). */
  usageReport: UsageSnapshot | null
  /** What `answerApproval` and `pairApprovalSource` resolve with. */
  approvalOutcome: ApprovalOutcome
  /** What `agentMetaToggle` reports the branch state as, afterwards. */
  agentMetaOpen: boolean
  /** What the availability PULL reports. */
  agentMetaAvailability: Array<{ nodeId: NodeId; available: boolean }>
  /** What `agentSearch` resolves to. */
  agentSearch: AgentSearchResponse
  /** Bytes reported by the toolbar's agent-memory poll; `null` = no daemon. */
  agentMemoryBytes: number | null
  /** The page `receptionist.transcript(before)` resolves to. */
  controlTranscript: (before?: number) => ControlTranscriptPage
}

/** The device the fake bridge says it runs on: emit a holder with this id to make it this client's. */
export const FAKE_DEVICE_ID = 'fake-device'

const EMPTY_STATE: ServerState = {
  version: 0,
  nextZIndex: 1,
  nodes: {},
  metaHosts: {},
  backgroundLedgers: {},
  rootArchivedChildren: [],
  undoBuffer: [],
  undoCursor: -1,
  savedViewports: {}
}

export class FakeBridge implements Api {
  /** Every call the renderer made, in order. Assert against this. */
  readonly calls: BridgeCall[] = []

  /** What each request/response method resolves with. Mutate freely mid-test. */
  readonly responses: FakeBridgeResponses = {
    syncRequest: EMPTY_STATE,
    sessionInfo: { sessionId: 'pty-fake' as PtySessionId, cols: 80, rows: 24 },
    attach: { scrollback: '' },
    validate: { valid: true },
    command: { ok: true },
    newNodeId: 'node-fake' as NodeId,
    speakOutcome: 'started',
    launchPrefs: { ...DEFAULT_LAUNCH_PREFS },
    activeLaunchPrefs: { ...DEFAULT_LAUNCH_PREFS },
    agentMetaOpen: true,
    agentMetaAvailability: [],
    agentSearch: { ok: true, pass: 'titles', hits: [], noneProbability: 1, costUsd: 0 },
    restartFlag: { required: false, reason: '' },
    usageReport: null,
    approvalOutcome: { ok: true },
    agentMemoryBytes: null,
    controlTranscript: () => ({ entries: [], more: false })
  }

  /**
   * Methods that should reject, by name.
   *
   * The renderer has to survive a disconnected server — `initServerSync` already
   * tolerates a failing `syncRequest` — and that path is otherwise unreachable
   * in a test.
   */
  readonly failing = new Set<string>()

  // --- global channels ---
  private readonly updated = new Set<(nodeId: NodeId, fields: Partial<NodeData>) => void>()
  private readonly added = new Set<(node: NodeData) => void>()
  private readonly removed = new Set<(nodeId: NodeId) => void>()
  private readonly fileContent = new Set<(nodeId: NodeId, content: string) => void>()
  private readonly serverError = new Set<(message: string) => void>()
  private readonly playSound = new Set<(sound: string) => void>()
  private readonly speechActive = new Set<(active: boolean) => void>()
  private readonly speakingChanged = new Set<(nodeId: NodeId, speaking: boolean, voice?: string) => void>()
  private readonly summaryChatStatus = new Set<(nodeId: NodeId, s: SummaryChatUiState, m?: string) => void>()
  private readonly savedViewports = new Set<(v: Record<string, CameraBounds>) => void>()
  private readonly rootCwd = new Set<(cwd: string | undefined) => void>()
  private readonly autoStampsEnabled = new Set<(enabled: boolean) => void>()
  private readonly restartRequired = new Set<(required: boolean, reason: string) => void>()
  private readonly usageReport = new Set<(snapshot: UsageSnapshot) => void>()
  private readonly systemStats = new Set<(snapshot: SystemStatsSnapshot | null) => void>()
  private readonly approvals = new Set<(snapshot: ApprovalsSnapshot) => void>()
  private readonly agentMetaAvailability = new Set<(nodeId: NodeId, available: boolean) => void>()
  private readonly visibilityChanged = new Set<(visible: boolean) => void>()
  private readonly focusChanged = new Set<(focused: boolean) => void>()
  private readonly focusNode = new Set<(nodeId: NodeId | null) => void>()
  private readonly receptionistStatus = new Set<(status: ReceptionistStatus) => void>()
  private readonly receptionistHolder = new Set<(holder: ReceptionistHolder | null) => void>()
  private readonly agentNames = new Set<(names: Record<string, string>) => void>()
  private readonly cameraFollow = new Set<(nodeId: NodeId) => void>()
  private readonly receptionistNotice = new Set<(text: string) => void>()
  private readonly receptionistUnread = new Set<(unread: { count: number; first?: number }) => void>()
  private readonly receptionistReplaying = new Set<(playing: { of: number; part: number } | null, refused?: string) => void>()
  private readonly transcriptAppended = new Set<(entries: ControlTranscriptEntry[]) => void>()
  private readonly handsFreeTuning = new Set<(tuning: Partial<HandsFreeTuning>) => void>()
  private readonly systemMetrics = new Set<(sample: SystemMetricsSample) => void>()
  /** Mod envelope listeners, keyed by the modId they asked for. */
  private readonly modListeners = new Map<string, Set<(event: string, payload: unknown) => void>>()

  // --- per-session channels ---
  private readonly ptyData: SessionListeners<(data: string) => void> = new Map()
  private readonly ptyExit: SessionListeners<(exitCode: number) => void> = new Map()
  private readonly snapshot: SessionListeners<(snapshot: SnapshotMessage) => void> = new Map()

  // ─── recording ────────────────────────────────────────────────────────────

  private record(method: string, ...args: unknown[]): void {
    this.calls.push({ method, args })
  }

  private async reply<T>(method: string, value: T, ...args: unknown[]): Promise<T> {
    this.record(method, ...args)
    if (this.failing.has(method)) throw new Error(`FakeBridge: ${method} configured to fail`)
    return value
  }

  /** Calls to `method`, in order. */
  callsTo(method: string): BridgeCall[] {
    return this.calls.filter((c) => c.method === method)
  }

  /** Arguments of the last call to `method`, or undefined if it was never called. */
  lastCall(method: string): unknown[] | undefined {
    return this.calls.filter((c) => c.method === method).at(-1)?.args
  }

  /** Forget every recorded call. Useful after an arrange step. */
  resetCalls(): void {
    this.calls.length = 0
  }

  /** Listener counts per channel — for asserting that unsubscribe actually unsubscribed. */
  listenerCount(channel: 'updated' | 'added' | 'removed' | 'serverError' | 'focusNode' | 'cameraFollow'): number {
    return this[channel].size
  }

  // ─── driving the renderer from the server side ────────────────────────────

  /**
   * Events the "server" can push. Grouped so a test reads as
   * `bridge.emit.nodeAdded(...)` rather than as another method on a 79-member
   * object.
   */
  readonly emit = {
    nodeAdded: (node: NodeData): void => { for (const fn of this.added) fn(node) },
    nodeUpdated: (nodeId: NodeId, fields: Partial<NodeData>): void => {
      for (const fn of this.updated) fn(nodeId, fields)
    },
    nodeRemoved: (nodeId: NodeId): void => { for (const fn of this.removed) fn(nodeId) },
    fileContent: (nodeId: NodeId, content: string): void => {
      for (const fn of this.fileContent) fn(nodeId, content)
    },
    serverError: (message: string): void => { for (const fn of this.serverError) fn(message) },
    playSound: (sound: string): void => { for (const fn of this.playSound) fn(sound) },
    speechActive: (active: boolean): void => { for (const fn of this.speechActive) fn(active) },
    speakingChanged: (nodeId: NodeId, speaking: boolean, voice?: string): void => {
      for (const fn of this.speakingChanged) fn(nodeId, speaking, voice)
    },
    summaryChatStatus: (nodeId: NodeId, state: SummaryChatUiState, message?: string): void => {
      for (const fn of this.summaryChatStatus) fn(nodeId, state, message)
    },
    savedViewports: (viewports: Record<string, CameraBounds>): void => {
      for (const fn of this.savedViewports) fn(viewports)
    },
    autoStampsEnabled: (enabled: boolean): void => {
      for (const fn of this.autoStampsEnabled) fn(enabled)
    },
    rootCwd: (cwd: string | undefined): void => {
      for (const fn of this.rootCwd) fn(cwd)
    },
    restartRequired: (required: boolean, reason: string): void => {
      for (const fn of this.restartRequired) fn(required, reason)
    },
    usageReport: (snapshot: UsageSnapshot): void => {
      for (const fn of this.usageReport) fn(snapshot)
    },
    /** To each `watchSystemStats` watcher, as the server would. */
    systemStats: (snapshot: SystemStatsSnapshot | null): void => {
      for (const fn of this.systemStats) fn(snapshot)
    },
    /** To each `watchApprovals` watcher, as the server would. */
    approvals: (snapshot: ApprovalsSnapshot): void => {
      for (const fn of this.approvals) fn(snapshot)
    },
    visibilityChanged: (visible: boolean): void => {
      for (const fn of this.visibilityChanged) fn(visible)
    },
    focusChanged: (focused: boolean): void => {
      for (const fn of this.focusChanged) fn(focused)
    },
    /** `null` stands for a deep link whose id matched nothing. */
    focusNode: (nodeId: NodeId | null): void => { for (const fn of this.focusNode) fn(nodeId) },
    receptionistStatus: (status: ReceptionistStatus): void => {
      for (const fn of this.receptionistStatus) fn(status)
    },
    receptionistHolder: (holder: ReceptionistHolder | null): void => {
      for (const fn of this.receptionistHolder) fn(holder)
    },
    agentNames: (names: Record<string, string>): void => {
      for (const fn of this.agentNames) fn(names)
    },
    cameraFollow: (nodeId: NodeId): void => { for (const fn of this.cameraFollow) fn(nodeId) },
    receptionistNotice: (text: string): void => { for (const fn of this.receptionistNotice) fn(text) },
    receptionistUnread: (unread: { count: number; first?: number }): void => { for (const fn of this.receptionistUnread) fn(unread) },
    receptionistReplaying: (playing: { of: number; part: number } | null, refused?: string): void => {
      for (const fn of this.receptionistReplaying) fn(playing, refused)
    },
    transcriptAppended: (entries: ControlTranscriptEntry[]): void => { for (const fn of this.transcriptAppended) fn(entries) },
    handsFreeTuning: (tuning: Partial<HandsFreeTuning>): void => { for (const fn of this.handsFreeTuning) fn(tuning) },
    systemMetrics: (sample: SystemMetricsSample): void => {
      for (const fn of this.systemMetrics) fn(sample)
    },
    /** Deliver one envelope, as the real bridge does — only to that mod. */
    modMessage: (modId: string, event: string, payload: unknown): void => {
      for (const fn of this.modListeners.get(modId) ?? []) fn(event, payload)
    },

    // Per-session. Emitting for a session nobody subscribed to is a silent
    // no-op on purpose: that is what the real bridge does.
    ptyData: (sessionId: PtySessionId, data: string): void =>
      fireForSession(this.ptyData, sessionId, (fn) => fn(data)),
    ptyExit: (sessionId: PtySessionId, exitCode: number): void =>
      fireForSession(this.ptyExit, sessionId, (fn) => fn(exitCode)),
    snapshot: (sessionId: PtySessionId, snapshot: SnapshotMessage): void =>
      fireForSession(this.snapshot, sessionId, (fn) => fn(snapshot))
  }

  // ─── the bridge itself ────────────────────────────────────────────────────

  readonly pty: PtyApi = {
    create: (options?: CreateOptions) => this.reply('pty.create', this.responses.sessionInfo, options),
    list: () => this.reply('pty.list', [] as SessionInfo[]),
    attach: (sessionId) => this.reply('pty.attach', this.responses.attach, sessionId),
    destroy: (sessionId) => this.reply('pty.destroy', undefined, sessionId),
    write: (sessionId, data) => this.record('pty.write', sessionId, data),
    onData: (sessionId, cb) => subscribeToSession(this.ptyData, sessionId, cb),
    onExit: (sessionId, cb) => subscribeToSession(this.ptyExit, sessionId, cb)
  }

  readonly node: NodeApi = {
    syncRequest: () => this.reply('node.syncRequest', this.responses.syncRequest),
    move: (nodeId, x, y) => this.reply('node.move', undefined, nodeId, x, y),
    batchMove: (moves) => this.reply('node.batchMove', undefined, moves),
    rename: (nodeId, name) => this.reply('node.rename', undefined, nodeId, name),
    setColor: (nodeId, colorPresetId) => this.reply('node.setColor', undefined, nodeId, colorPresetId),
    setStamp: (nodeId, stamp) => this.reply('node.setStamp', undefined, nodeId, stamp),
    regenerateAutoStamp: (nodeId) => this.reply('node.regenerateAutoStamp', undefined, nodeId),
    archive: (nodeId) => this.reply('node.archive', undefined, nodeId),
    unarchive: (parentNodeId, archivedNodeId) =>
      this.reply('node.unarchive', undefined, parentNodeId, archivedNodeId),
    archiveDelete: (parentNodeId, archivedNodeId) =>
      this.reply('node.archiveDelete', undefined, parentNodeId, archivedNodeId),
    undoPush: (entry: UndoEntry) => this.reply('node.undoPush', undefined, entry),
    undoSetCursor: (cursor) => this.reply('node.undoSetCursor', undefined, cursor),
    bringToFront: (nodeId) => this.reply('node.bringToFront', undefined, nodeId),
    recordInteraction: (nodeId) => this.record('node.recordInteraction', nodeId),
    reparent: (nodeId, newParentId) => this.reply('node.reparent', undefined, nodeId, newParentId),
    swapParentChild: (nodeId, childId) => this.reply('node.swapParentChild', undefined, nodeId, childId),

    terminalCreate: (parentId, options, initialTitleHistory, initialName, x, y, initialInput) =>
      this.reply('node.terminalCreate', this.responses.sessionInfo,
        parentId, options, initialTitleHistory, initialName, x, y, initialInput),
    terminalResize: (nodeId, cols, rows) => this.reply('node.terminalResize', undefined, nodeId, cols, rows),
    terminalBorrowSize: (nodeId, cols, rows) => this.reply('node.terminalBorrowSize', undefined, nodeId, cols, rows),
    terminalReturnSize: (nodeId) => this.reply('node.terminalReturnSize', undefined, nodeId),
    terminalReincarnate: (nodeId, options) =>
      this.reply('node.terminalReincarnate', this.responses.sessionInfo, nodeId, options),
    terminalRestart: (nodeId, extraCliArgs) =>
      this.reply('node.terminalRestart', this.responses.sessionInfo, nodeId, extraCliArgs),
    forkSession: (nodeId) => this.reply('node.forkSession', this.responses.sessionInfo, nodeId),
    shipIt: (nodeId, text) => this.reply('node.shipIt', undefined, nodeId, text),
    setTerminalMode: (sessionId, mode) => this.record('node.setTerminalMode', sessionId, mode),
    crabReorder: (order) => this.reply('node.crabReorder', undefined, order),

    directoryAdd: (parentId, cwd, x, y) =>
      this.reply('node.directoryAdd', { nodeId: this.responses.newNodeId }, parentId, cwd, x, y),
    directoryCwd: (nodeId, cwd) => this.reply('node.directoryCwd', undefined, nodeId, cwd),
    setRootCwd: (cwd) => this.reply('node.setRootCwd', undefined, cwd),
    setAutoStampsEnabled: (enabled) => this.reply('node.setAutoStampsEnabled', undefined, enabled),
    directoryGitFetch: (nodeId) => this.reply('node.directoryGitFetch', undefined, nodeId),
    directoryGitRun: (nodeId, command) => this.reply('node.directoryGitRun', this.responses.command, nodeId, command),
    directoryOpenGitHubDesktop: (nodeId) =>
      this.reply('node.directoryOpenGitHubDesktop', this.responses.command, nodeId),
    validateDirectory: (p) => this.reply('node.validateDirectory', this.responses.validate, p),

    fileAdd: (parentId, filePath, x, y) =>
      this.reply('node.fileAdd', { nodeId: this.responses.newNodeId }, parentId, filePath, x, y),
    filePath: (nodeId, filePath) => this.reply('node.filePath', undefined, nodeId, filePath),
    validateFile: (p, cwd) => this.reply('node.validateFile', this.responses.validate, p, cwd),

    markdownAdd: (parentId, x, y) =>
      this.reply('node.markdownAdd', { nodeId: this.responses.newNodeId }, parentId, x, y),
    markdownResize: (nodeId, width, height) =>
      this.reply('node.markdownResize', undefined, nodeId, width, height),
    markdownContent: (nodeId, content) => this.reply('node.markdownContent', undefined, nodeId, content),
    agentMetaToggle: (nodeId) => this.reply('node.agentMetaToggle', this.responses.agentMetaOpen, nodeId),
    agentMetaAvailabilityStatus: () => this.reply('node.agentMetaAvailabilityStatus', this.responses.agentMetaAvailability),
    agentSearch: (query, mode) => this.reply('node.agentSearch', this.responses.agentSearch, query, mode),
    agentMetaRescan: (nodeId) => this.reply('node.agentMetaRescan', undefined, nodeId),
    metaDocResize: (nodeId, width, height) => this.reply('node.metaDocResize', undefined, nodeId, width, height),
    metaDocContent: (nodeId, content) => this.reply('node.metaDocContent', undefined, nodeId, content),
    markdownSetMaxWidth: (nodeId, maxWidth) =>
      this.reply('node.markdownSetMaxWidth', undefined, nodeId, maxWidth),

    titleAdd: (parentId, x, y) =>
      this.reply('node.titleAdd', { nodeId: this.responses.newNodeId }, parentId, x, y),
    titleText: (nodeId, text) => this.reply('node.titleText', undefined, nodeId, text),
    cacheTimerMute: (nodeId, muted) => this.reply('node.cacheTimerMute', undefined, nodeId, muted),

    setClaudeStatusUnread: (sessionId, unread) =>
      this.record('node.setClaudeStatusUnread', sessionId, unread),
    setClaudeStatusAsleep: (sessionId, asleep) =>
      this.record('node.setClaudeStatusAsleep', sessionId, asleep),
    setClaudeStatusBackground: (sessionId, background) =>
      this.record('node.setClaudeStatusBackground', sessionId, background),
    setAlertsReadTimestamp: (nodeId, timestamp) =>
      this.record('node.setAlertsReadTimestamp', nodeId, timestamp),
    sendCameraBounds: (bounds) => this.record('node.sendCameraBounds', bounds),
    saveViewport: (slot, bounds) => this.record('node.saveViewport', slot, bounds),

    onSnapshot: (sessionId, cb) => subscribeToSession(this.snapshot, sessionId, cb),
    onUpdated: (cb) => subscribe(this.updated, cb),
    onAdded: (cb) => subscribe(this.added, cb),
    onRemoved: (cb) => subscribe(this.removed, cb),
    onFileContent: (cb) => subscribe(this.fileContent, cb),
    onServerError: (cb) => subscribe(this.serverError, cb),
    onPlaySound: (cb) => subscribe(this.playSound, cb),
    onSpeakingChanged: (cb) => subscribe(this.speakingChanged, cb),
    onSummaryChatStatus: (cb) => subscribe(this.summaryChatStatus, cb),
    onSavedViewports: (cb) => subscribe(this.savedViewports, cb),
    onRootCwd: (cb) => subscribe(this.rootCwd, cb),
    onAutoStampsEnabled: (cb) => subscribe(this.autoStampsEnabled, cb),
    onRestartRequired: (cb) => subscribe(this.restartRequired, cb),
    onAgentMetaAvailability: (cb) => subscribe(this.agentMetaAvailability, cb),
    restartFlagStatus: () => this.reply('node.restartFlagStatus', this.responses.restartFlag),
    onUsageReport: (cb) => subscribe(this.usageReport, cb),
    onMobileBuildChanged: () => () => undefined,
    usageReportStatus: () => this.reply('node.usageReportStatus', this.responses.usageReport),
    watchSystemStats: (cb) => subscribe(this.systemStats, cb),
    watchApprovals: (cb) => subscribe(this.approvals, cb),
    answerApproval: (source, id, reply) =>
      this.reply('node.answerApproval', this.responses.approvalOutcome, source, id, reply),
    pairApprovalSource: (source, publicKey, name) =>
      this.reply('node.pairApprovalSource', this.responses.approvalOutcome, source, publicKey, name)
  }

  readonly tts: TtsApi = {
    toggle: (text) => this.reply('tts.toggle', this.responses.speakOutcome, text),
    stop: () => this.record('tts.stop'),
    onActiveChanged: (cb) => subscribe(this.speechActive, cb)
  }

  readonly dictation: DictationApi = {
    start: (sampleRate, forControl) => this.reply('dictation.start', 'fake-dictation', sampleRate, forControl),
    audio: (id, pcm) => this.record('dictation.audio', id, pcm),
    finish: (id) => this.reply('dictation.finish', '', id),
    cancel: (id) => this.record('dictation.cancel', id),
    turnCheck: (id) => this.reply('dictation.turnCheck', null as number | null, id)
  }

  readonly handsFree: HandsFreeApi = {
    checkWakeWord: (pcm, mode) => this.reply('handsFree.checkWakeWord', { match: false, answered: mode ?? 'wake-word' } as WakeWordCheckResult, pcm, mode),
    say: (text, interrupted) => this.record('handsFree.say', text, interrupted),
    onTuning: (cb) => subscribe(this.handsFreeTuning, cb)
  }

  private readonly speechAudio = new Set<Parameters<RemoteSpeechApi['onAudio']>[0]>()
  private readonly speechStop = new Set<(id: string) => void>()
  readonly remoteSpeech: RemoteSpeechApi = {
    onAudio: (cb) => subscribe(this.speechAudio, cb),
    onStop: (cb) => subscribe(this.speechStop, cb),
    progress: (id, index, event) => this.record('remoteSpeech.progress', id, index, event)
  }

  /**
   * Unlike the real bridge, these channels do not replay the latest value to a
   * late subscriber: a test emits after rendering, so it never needs to.
   */
  readonly receptionist: ReceptionistApi = {
    select: () => this.record('receptionist.select'),
    stop: () => this.record('receptionist.stop'),
    hold: (action) => this.record('receptionist.hold', action),
    say: (text) => this.record('receptionist.say', text),
    read: (of, part) => this.record('receptionist.read', of, part),
    replay: (of, part) => this.record('receptionist.replay', of, part),
    stopReplay: () => this.record('receptionist.stopReplay'),
    catchUp: () => this.record('receptionist.catchUp'),
    onUnread: (cb) => subscribe(this.receptionistUnread, cb),
    onReplaying: (cb) => subscribe(this.receptionistReplaying, cb),
    transcript: (before) => this.reply('receptionist.transcript', this.responses.controlTranscript(before), before),
    onTranscriptAppended: (cb) => subscribe(this.transcriptAppended, cb),
    deviceId: FAKE_DEVICE_ID,
    onStatus: (cb) => subscribe(this.receptionistStatus, cb),
    onHolder: (cb) => subscribe(this.receptionistHolder, cb),
    onAgentNames: (cb) => subscribe(this.agentNames, cb),
    onCameraFollow: (cb) => subscribe(this.cameraFollow, cb),
    onNotice: (cb) => subscribe(this.receptionistNotice, cb)
  }

  readonly perf: PerfApi = {
    startTrace: () => this.reply('perf.startTrace', undefined),
    stopTrace: () => this.reply('perf.stopTrace', '/tmp/fake-trace.json')
  }

  readonly window: WindowApi = {
    fitToWorkArea: () => this.reply('window.fitToWorkArea', undefined),
    onVisibilityChanged: (cb) => subscribe(this.visibilityChanged, cb),
    onFocusChanged: (cb) => subscribe(this.focusChanged, cb),
    onFocusNode: (cb) => subscribe(this.focusNode, cb)
  }

  readonly mods: ModsApi = {
    send: (modId, event, payload) => this.record('mods.send', modId, event, payload),
    onMessage: (modId, callback) => {
      let set = this.modListeners.get(modId)
      if (!set) { set = new Set(); this.modListeners.set(modId, set) }
      set.add(callback)
      return () => { set.delete(callback) }
    }
  }

  readonly system: SystemApi = {
    setMetricsEnabled: (enabled) => this.record('system.setMetricsEnabled', enabled),
    onMetrics: (cb) => subscribe(this.systemMetrics, cb),
    getLaunchPrefs: () => this.reply('system.getLaunchPrefs', this.responses.launchPrefs),
    setLaunchPrefs: (patch) => {
      this.responses.launchPrefs = { ...this.responses.launchPrefs, ...patch }
      return this.reply('system.setLaunchPrefs', this.responses.launchPrefs, patch)
    },
    getActiveLaunchPrefs: () => this.reply('system.getActiveLaunchPrefs', this.responses.activeLaunchPrefs),
    getAgentMemory: () => this.reply('system.getAgentMemory', this.responses.agentMemoryBytes)
  }

  log = (message: string): void => this.record('log', message)
  /** Outcome the next chord press resolves with. Tests override per case. */
  summaryChatToggleResult: SummaryChatToggleResult = { outcome: 'started' }
  toggleSummaryChat = async (
    nodeId: NodeId | undefined, mode: SummaryChatMode,
  ): Promise<SummaryChatToggleResult> => {
    this.record('toggleSummaryChat', nodeId, mode)
    return this.summaryChatToggleResult
  }
  summaryChatFollowUp = (text: string): void => this.record('summaryChatFollowUp', text)
  endSummaryChat = (): void => this.record('endSummaryChat')
  restartSpaceterm = (): Promise<void> => this.reply('restartSpaceterm', undefined)
  installMobileApp = (): Promise<{ ok: boolean; message?: string }> => this.reply('installMobileApp', { ok: true })
  writeDebugLog = (content: string): Promise<string> =>
    this.reply('writeDebugLog', '/tmp/fake-debug.log', content)
  openExternal = (url: string): Promise<void> => this.reply('openExternal', undefined, url)
}

/**
 * Install a fake bridge on `window` and return it.
 *
 * Call before importing anything that touches the bridge at module scope —
 * today that is only `useWindowVisible`, which optional-chains, but relying on
 * that is how the next module-scope read becomes a mystery blank page.
 */
export function installFakeBridge(target: { api?: Api } = globalThis as never): FakeBridge {
  const bridge = new FakeBridge()
  target.api = bridge
  return bridge
}
