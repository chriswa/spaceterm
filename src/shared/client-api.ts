import type { Api, PlatformApi } from './api'
import type { ServerClient, ServerEvent, ServerEventType } from './server-client'
import type { NodeId, PtySessionId } from './ids'
import type { NodeData } from './state'

/**
 * Assemble `window.api` from a server connection and a host platform.
 *
 * This is the whole of what used to be a hundred `ipcMain` handlers, a
 * hundred preload relays and twenty-five event forwards in Electron's main
 * process — translation, not logic. Doing it here, once, in code both the
 * Electron renderer and the mobile web app run, is what lets the two clients
 * share every server interaction rather than each keeping a copy.
 */
export function createApi(client: ServerClient, platform: PlatformApi): Api {
  /**
   * Per-session listeners, keyed so a canvas of fifty cards does not run
   * fifty filters on every output chunk and snapshot.
   */
  function bySession<T extends 'data' | 'exit' | 'snapshot'>(type: T) {
    const listeners = new Map<PtySessionId, Set<(msg: ServerEvent<T>) => void>>()
    client.on(type, (msg) => {
      const set = listeners.get((msg as { sessionId: PtySessionId }).sessionId)
      set?.forEach((fn) => fn(msg))
    })
    return (sessionId: PtySessionId, fn: (msg: ServerEvent<T>) => void): (() => void) => {
      let set = listeners.get(sessionId)
      if (!set) {
        set = new Set()
        listeners.set(sessionId, set)
      }
      set.add(fn)
      return () => {
        set.delete(fn)
        if (set.size === 0) listeners.delete(sessionId)
      }
    }
  }
  const onSessionData = bySession('data')
  const onSessionExit = bySession('exit')
  const onSessionSnapshot = bySession('snapshot')

  const on = <T extends ServerEventType>(type: T, fn: (msg: ServerEvent<T>) => void) => client.on(type, fn)

  return {
    pty: {
      create: (options) => client.create(options),
      list: () => client.list(),
      attach: (sessionId) => client.attach(sessionId),
      write: (sessionId, data) => client.write(sessionId, data),
      destroy: (sessionId) => client.destroy(sessionId),
      onData: (sessionId, cb) => onSessionData(sessionId, (m) => cb(m.data)),
      onExit: (sessionId, cb) => onSessionExit(sessionId, (m) => cb(m.exitCode))
    },
    node: {
      syncRequest: () => client.syncRequest(),
      move: (nodeId, x, y) => client.nodeMove(nodeId, x, y),
      batchMove: (moves) => client.nodeBatchMove(moves),
      rename: (nodeId, name) => client.nodeRename(nodeId, name),
      setColor: (nodeId, colorPresetId) => client.nodeSetColor(nodeId, colorPresetId),
      setStamp: (nodeId, stamp) => client.nodeSetStamp(nodeId, stamp),
      regenerateAutoStamp: (nodeId) => client.nodeRegenerateAutoStamp(nodeId),
      archive: (nodeId) => client.nodeArchive(nodeId),
      unarchive: (parentNodeId, path) => client.nodeUnarchive(parentNodeId, path),
      archiveDelete: (parentNodeId, path) => client.nodeArchiveDelete(parentNodeId, path),
      undoPush: (entry) => client.undoPush(entry),
      undoSetCursor: (cursor) => client.undoSetCursor(cursor),
      bringToFront: (nodeId) => client.nodeBringToFront(nodeId),
      recordInteraction: (nodeId) => client.recordInteraction(nodeId),
      reparent: (nodeId, newParentId) => client.nodeReparent(nodeId, newParentId),
      swapParentChild: (nodeId, childId) => client.nodeSwapParentChild(nodeId, childId),
      terminalCreate: (parentId, options, initialTitleHistory, initialName, x, y, initialInput) =>
        client.terminalCreate(parentId, options, initialTitleHistory, initialName, x, y, initialInput),
      terminalResize: (nodeId, cols, rows) => client.terminalResize(nodeId, cols, rows),
      terminalBorrowSize: (nodeId, cols, rows) => client.terminalBorrowSize(nodeId, cols, rows),
      terminalReturnSize: (nodeId) => client.terminalReturnSize(nodeId),
      terminalReincarnate: (nodeId, options) => client.terminalReincarnate(nodeId, options),
      terminalRestart: (nodeId, extraCliArgs) => client.terminalRestart(nodeId, extraCliArgs),
      forkSession: (nodeId) => client.forkSession(nodeId),
      shipIt: (nodeId, text) => client.shipIt(nodeId, text),
      setTerminalMode: (sessionId, mode) => client.setTerminalMode(sessionId, mode),
      crabReorder: (order) => client.crabReorder(order),
      directoryAdd: (parentId, cwd, x, y) => client.directoryAdd(parentId, cwd, x, y),
      directoryCwd: (nodeId, cwd) => client.directoryCwd(nodeId, cwd),
      setRootCwd: (cwd) => client.setRootCwd(cwd),
      setAutoStampsEnabled: (enabled) => client.setAutoStampsEnabled(enabled),
      directoryGitFetch: (nodeId) => client.directoryGitFetch(nodeId),
      directoryGitRun: (nodeId, command) => client.directoryGitRun(nodeId, command),
      directoryOpenGitHubDesktop: (nodeId) => client.directoryOpenGitHubDesktop(nodeId),
      validateDirectory: (path) => client.validateDirectory(path),
      fileAdd: (parentId, filePath, x, y) => client.fileAdd(parentId, filePath, x, y),
      filePath: (nodeId, filePath) => client.filePath(nodeId, filePath),
      validateFile: (path, cwd) => client.validateFile(path, cwd),
      markdownAdd: (parentId, x, y) => client.markdownAdd(parentId, x, y),
      markdownResize: (nodeId, width, height) => client.markdownResize(nodeId, width, height),
      markdownContent: (nodeId, content) => client.markdownContent(nodeId, content),
      markdownSetMaxWidth: (nodeId, maxWidth) => client.markdownSetMaxWidth(nodeId, maxWidth),
      agentMetaToggle: (nodeId) => client.agentMetaToggle(nodeId),
      agentMetaRescan: (nodeId) => client.agentMetaRescan(nodeId),
      metaDocResize: (nodeId, width, height) => client.metaDocResize(nodeId, width, height),
      metaDocContent: (nodeId, content) => client.metaDocContent(nodeId, content),
      titleAdd: (parentId, x, y) => client.titleAdd(parentId, x, y),
      titleText: (nodeId, text) => client.titleText(nodeId, text),
      cacheTimerMute: (nodeId, muted) => client.cacheTimerMute(nodeId, muted),
      setClaudeStatusUnread: (sessionId, unread) => client.setClaudeStatusUnread(sessionId, unread),
      setClaudeStatusAsleep: (sessionId, asleep) => client.setClaudeStatusAsleep(sessionId, asleep),
      setClaudeStatusBackground: (sessionId, background) => client.setClaudeStatusBackground(sessionId, background),
      setAlertsReadTimestamp: (nodeId, timestamp) => client.setAlertsReadTimestamp(nodeId, timestamp),
      sendCameraBounds: (bounds) => client.sendCameraBounds(bounds),
      saveViewport: (slot, bounds) => client.saveViewport(slot, bounds),
      onSnapshot: (sessionId, cb) => onSessionSnapshot(sessionId, cb),
      onUpdated: (cb) => on('node-updated', (m) => cb(m.nodeId, m.fields as Partial<NodeData>)),
      onAdded: (cb) => on('node-added', (m) => cb(m.node)),
      onRemoved: (cb) => on('node-removed', (m) => cb(m.nodeId)),
      onFileContent: (cb) => on('file-content', (m) => cb(m.nodeId, m.content)),
      onServerError: (cb) => on('server-error', (m) => cb(m.message)),
      onPlaySound: (cb) => on('play-sound', (m) => cb(m.sound)),
      onSpeakingChanged: (cb) => on('speaking-changed', (m) => cb(m.nodeId, m.speaking, m.voice)),
      onSummaryChatStatus: (cb) => on('summary-chat-status', (m) => cb(m.nodeId, m.state, m.message)),
      onPeerConnected: (cb) => on('peer-connected', (m) => cb(m.clientId)),
      onPeerDisconnected: (cb) => on('peer-disconnected', (m) => cb(m.clientId)),
      onPeerCameraBounds: (cb) => on('peer-camera-bounds', (m) => cb(m.clientId, m.bounds)),
      onSavedViewports: (cb) => on('saved-viewports', (m) => cb(m.viewports)),
      onRootCwd: (cb) => on('root-cwd', (m) => cb(m.cwd)),
      onAutoStampsEnabled: (cb) => on('auto-stamps-enabled', (m) => cb(m.enabled)),
      onRestartRequired: (cb) => on('restart-required', (m) => cb(m.required, m.reason)),
      onAgentMetaAvailability: (cb) => on('agent-meta-availability', (m) => cb(m.nodeId, m.available)),
      agentMetaAvailabilityStatus: () => client.agentMetaAvailabilityStatus(),
      agentSearch: (query, mode) => client.agentSearch(query, mode),
      restartFlagStatus: () => client.restartFlagQuery(),
      onUsageReport: (cb) => on('usage-report', (m) => cb(m.snapshot)),
      usageReportStatus: () => client.usageReportQuery()
    },
    log: (message) => platform.log(message),
    toggleSummaryChat: (nodeId, mode) => client.toggleSummaryChat(nodeId, mode),
    async restartSpaceterm() {
      platform.log('[restart] Restart Spaceterm requested')
      await client.restartServer()
      platform.log('[restart] Server accepted restart; restarting this client')
      platform.restartClient()
    },
    writeDebugLog: (content) => platform.writeDebugLog(content),
    openExternal: (url) => platform.openExternal(url),
    tts: {
      toggle: (text) => client.toggleSpeak(text),
      stop: () => client.stopSpeak(),
      onActiveChanged: (cb) => on('speech-active', (m) => cb(m.active))
    },
    dictation: {
      start: (sampleRate) => client.dictationStart(sampleRate),
      audio: (id, pcm) => client.dictationAudio(id, pcm),
      finish: (id) => client.dictationFinish(id),
      cancel: (id) => client.dictationCancel(id)
    },
    perf: platform.perf,
    window: {
      ...platform.window,
      // The server picks which client should answer a focus request and sends
      // it `focus-surface`; this client raising itself is the host's half.
      onFocusNode: (cb) => on('focus-surface', (m) => {
        platform.raiseWindow()
        cb(m.nodeId as NodeId | null)
      })
    },
    system: { ...platform.system, getAgentMemory: () => client.agentMemory() },
    mods: {
      send: (modId, event, payload) => client.sendMod(modId, event, payload),
      // Filtered here so a mod never sees another's traffic by accident.
      onMessage: (modId, cb) => on('mod', (m) => { if (m.modId === modId) cb(m.event, m.payload) })
    }
  }
}
