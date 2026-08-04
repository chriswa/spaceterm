import type {
  Api, AttachResult, CameraBounds, CreateOptions, ModsApi, NodeApi, PerfApi, PtyApi,
  SessionInfo, SummaryChatUiState, SystemApi, TtsApi, WindowApi
} from '../../../../shared/api'
import type { SystemMetricsSample } from '../../../../shared/system-metrics'
import { DEFAULT_LAUNCH_PREFS, type LaunchPrefs } from '../../../../shared/launch-prefs'
import type { SnapshotMessage } from '../../../../shared/protocol'
import type { NodeData, ServerState } from '../../../../shared/state'
import type { UndoEntry } from '../../../../shared/undo-types'
import type { NodeId, PtySessionId } from '../../../../shared/ids'

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
  newNodeId: NodeId
  isFullScreen: boolean
  ttsAvailable: boolean
  /** What the next launch would use. `setLaunchPrefs` mutates this. */
  launchPrefs: LaunchPrefs
  /** What the running process launched with; differs once a change is unapplied. */
  activeLaunchPrefs: LaunchPrefs
}

const EMPTY_STATE: ServerState = {
  version: 0,
  nextZIndex: 1,
  nodes: {},
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
    newNodeId: 'node-fake' as NodeId,
    isFullScreen: false,
    ttsAvailable: true,
    launchPrefs: { ...DEFAULT_LAUNCH_PREFS },
    activeLaunchPrefs: { ...DEFAULT_LAUNCH_PREFS }
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
  private readonly speak = new Set<(text: string) => void>()
  private readonly speakingChanged = new Set<(nodeId: NodeId, speaking: boolean, voice?: string) => void>()
  private readonly summaryChatStatus = new Set<(nodeId: NodeId, s: SummaryChatUiState, m?: string) => void>()
  private readonly peerConnected = new Set<(clientId: string) => void>()
  private readonly peerDisconnected = new Set<(clientId: string) => void>()
  private readonly peerCameraBounds = new Set<(clientId: string, bounds: CameraBounds) => void>()
  private readonly savedViewports = new Set<(v: Record<string, CameraBounds>) => void>()
  private readonly visibilityChanged = new Set<(visible: boolean) => void>()
  private readonly focusNode = new Set<(nodeId: NodeId) => void>()
  private readonly systemMetrics = new Set<(sample: SystemMetricsSample) => void>()
  /** Mod envelope listeners, keyed by the modId they asked for. */
  private readonly modListeners = new Map<string, Set<(event: string, payload: unknown) => void>>()

  // --- per-session channels ---
  private readonly ptyData: SessionListeners<(data: string) => void> = new Map()
  private readonly ptyExit: SessionListeners<(exitCode: number) => void> = new Map()
  private readonly ptyContext: SessionListeners<(percent: number) => void> = new Map()
  private readonly ptyLineCount: SessionListeners<(lineCount: number) => void> = new Map()
  private readonly ptyPlanCache: SessionListeners<(count: number, files: string[]) => void> = new Map()
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
  listenerCount(channel: 'updated' | 'added' | 'removed' | 'serverError' | 'focusNode'): number {
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
    speak: (text: string): void => { for (const fn of this.speak) fn(text) },
    speakingChanged: (nodeId: NodeId, speaking: boolean, voice?: string): void => {
      for (const fn of this.speakingChanged) fn(nodeId, speaking, voice)
    },
    summaryChatStatus: (nodeId: NodeId, state: SummaryChatUiState, message?: string): void => {
      for (const fn of this.summaryChatStatus) fn(nodeId, state, message)
    },
    peerConnected: (clientId: string): void => { for (const fn of this.peerConnected) fn(clientId) },
    peerDisconnected: (clientId: string): void => { for (const fn of this.peerDisconnected) fn(clientId) },
    peerCameraBounds: (clientId: string, bounds: CameraBounds): void => {
      for (const fn of this.peerCameraBounds) fn(clientId, bounds)
    },
    savedViewports: (viewports: Record<string, CameraBounds>): void => {
      for (const fn of this.savedViewports) fn(viewports)
    },
    visibilityChanged: (visible: boolean): void => {
      for (const fn of this.visibilityChanged) fn(visible)
    },
    focusNode: (nodeId: NodeId): void => { for (const fn of this.focusNode) fn(nodeId) },
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
    claudeContext: (sessionId: PtySessionId, percent: number): void =>
      fireForSession(this.ptyContext, sessionId, (fn) => fn(percent)),
    claudeSessionLineCount: (sessionId: PtySessionId, lineCount: number): void =>
      fireForSession(this.ptyLineCount, sessionId, (fn) => fn(lineCount)),
    planCacheUpdate: (sessionId: PtySessionId, count: number, files: string[]): void =>
      fireForSession(this.ptyPlanCache, sessionId, (fn) => fn(count, files)),
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
    onExit: (sessionId, cb) => subscribeToSession(this.ptyExit, sessionId, cb),
    onClaudeContext: (sessionId, cb) => subscribeToSession(this.ptyContext, sessionId, cb),
    onClaudeSessionLineCount: (sessionId, cb) => subscribeToSession(this.ptyLineCount, sessionId, cb),
    onPlanCacheUpdate: (sessionId, cb) => subscribeToSession(this.ptyPlanCache, sessionId, cb)
  }

  readonly node: NodeApi = {
    syncRequest: () => this.reply('node.syncRequest', this.responses.syncRequest),
    move: (nodeId, x, y) => this.reply('node.move', undefined, nodeId, x, y),
    batchMove: (moves) => this.reply('node.batchMove', undefined, moves),
    rename: (nodeId, name) => this.reply('node.rename', undefined, nodeId, name),
    setColor: (nodeId, colorPresetId) => this.reply('node.setColor', undefined, nodeId, colorPresetId),
    archive: (nodeId) => this.reply('node.archive', undefined, nodeId),
    unarchive: (parentNodeId, archivedNodeId) =>
      this.reply('node.unarchive', undefined, parentNodeId, archivedNodeId),
    archiveDelete: (parentNodeId, archivedNodeId) =>
      this.reply('node.archiveDelete', undefined, parentNodeId, archivedNodeId),
    undoPush: (entry: UndoEntry) => this.reply('node.undoPush', undefined, entry),
    undoSetCursor: (cursor) => this.reply('node.undoSetCursor', undefined, cursor),
    bringToFront: (nodeId) => this.reply('node.bringToFront', undefined, nodeId),
    reparent: (nodeId, newParentId) => this.reply('node.reparent', undefined, nodeId, newParentId),
    swapParentChild: (nodeId, childId) => this.reply('node.swapParentChild', undefined, nodeId, childId),

    terminalCreate: (parentId, options, initialTitleHistory, initialName, x, y, initialInput) =>
      this.reply('node.terminalCreate', this.responses.sessionInfo,
        parentId, options, initialTitleHistory, initialName, x, y, initialInput),
    terminalResize: (nodeId, cols, rows) => this.reply('node.terminalResize', undefined, nodeId, cols, rows),
    terminalReincarnate: (nodeId, options) =>
      this.reply('node.terminalReincarnate', this.responses.sessionInfo, nodeId, options),
    terminalRestart: (nodeId, extraCliArgs) =>
      this.reply('node.terminalRestart', this.responses.sessionInfo, nodeId, extraCliArgs),
    forkSession: (nodeId) => this.reply('node.forkSession', this.responses.sessionInfo, nodeId),
    setTerminalMode: (sessionId, mode) => this.record('node.setTerminalMode', sessionId, mode),
    crabReorder: (order) => this.reply('node.crabReorder', undefined, order),

    directoryAdd: (parentId, cwd, x, y) =>
      this.reply('node.directoryAdd', { nodeId: this.responses.newNodeId }, parentId, cwd, x, y),
    directoryCwd: (nodeId, cwd) => this.reply('node.directoryCwd', undefined, nodeId, cwd),
    directoryGitFetch: (nodeId) => this.reply('node.directoryGitFetch', undefined, nodeId),
    directoryWtSpawn: (nodeId, branchName) =>
      this.reply('node.directoryWtSpawn', { nodeId: this.responses.newNodeId }, nodeId, branchName),
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
    markdownSetMaxWidth: (nodeId, maxWidth) =>
      this.reply('node.markdownSetMaxWidth', undefined, nodeId, maxWidth),

    titleAdd: (parentId, x, y) =>
      this.reply('node.titleAdd', { nodeId: this.responses.newNodeId }, parentId, x, y),
    titleText: (nodeId, text) => this.reply('node.titleText', undefined, nodeId, text),

    setClaudeStatusUnread: (sessionId, unread) =>
      this.record('node.setClaudeStatusUnread', sessionId, unread),
    setClaudeStatusAsleep: (sessionId, asleep) =>
      this.record('node.setClaudeStatusAsleep', sessionId, asleep),
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
    onSpeak: (cb) => subscribe(this.speak, cb),
    onSpeakingChanged: (cb) => subscribe(this.speakingChanged, cb),
    onSummaryChatStatus: (cb) => subscribe(this.summaryChatStatus, cb),
    onPeerConnected: (cb) => subscribe(this.peerConnected, cb),
    onPeerDisconnected: (cb) => subscribe(this.peerDisconnected, cb),
    onPeerCameraBounds: (cb) => subscribe(this.peerCameraBounds, cb),
    onSavedViewports: (cb) => subscribe(this.savedViewports, cb)
  }

  readonly tts: TtsApi = {
    speak: (text) => this.reply('tts.speak', { available: this.responses.ttsAvailable }, text),
    stop: () => this.record('tts.stop')
  }

  readonly perf: PerfApi = {
    startTrace: () => this.reply('perf.startTrace', undefined),
    stopTrace: () => this.reply('perf.stopTrace', '/tmp/fake-trace.json')
  }

  readonly window: WindowApi = {
    isFullScreen: () => this.reply('window.isFullScreen', this.responses.isFullScreen),
    setFullScreen: (enabled) => this.reply('window.setFullScreen', undefined, enabled),
    onVisibilityChanged: (cb) => subscribe(this.visibilityChanged, cb),
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
    getActiveLaunchPrefs: () => this.reply('system.getActiveLaunchPrefs', this.responses.activeLaunchPrefs)
  }

  log = (message: string): void => this.record('log', message)
  startSummaryChat = (nodeId: NodeId): void => this.record('startSummaryChat', nodeId)
  restartSpaceterm = (): Promise<void> => this.reply('restartSpaceterm', undefined)
  writeDebugLog = (content: string): Promise<string> =>
    this.reply('writeDebugLog', '/tmp/fake-debug.log', content)
  openExternal = (url: string): Promise<void> => this.reply('openExternal', undefined, url)
  diffFiles = (fileA: string, fileB: string): Promise<void> =>
    this.reply('diffFiles', undefined, fileA, fileB)
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
