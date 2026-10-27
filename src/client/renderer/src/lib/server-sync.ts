import { useNodeStore } from '../stores/nodeStore'
import { bellRingsNow } from '../stores/notificationSoundStore'
import { useRootCwdStore } from '../stores/rootCwdStore'
import { useAutoStampsEnabledStore } from '../stores/autoStampsEnabledStore'
import { useScriptsSocketPathStore } from '../stores/scriptsSocketPathStore'
import { useSavedViewportStore } from '../stores/savedViewportStore'
import { useRestartRequiredStore } from '../stores/restartRequiredStore'
import { useUpdateActionsStore } from '../stores/updateActionsStore'
import { useReceptionistStore, isThinkingWithinEarshot } from '../stores/receptionistStore'
import { useAgentNamesStore } from '../stores/agentNamesStore'
import { receptionistHolderOf, type NodeData, type NodeStamp } from '../../../../shared/state'
import type { AutomationPatch } from '../../../../shared/automation'
import type { UndoEntry } from '../../../../shared/undo-types'
import { syncUndoBuffer } from './undo-buffer'
import { playSound } from './sounds'
import { playSpeechCue } from './speech-cues'
import { setControlThinking, thinkingCueScope } from './thinking-cue'
import { showToast } from './toast'
import { pokeFrames } from './frame-policy'
import type { CreateOptions, SoundName } from '../../../../shared/protocol'
import type { NodeId, PtySessionId } from '../../../../shared/ids'

/** Play the notification sound if the bell is on and Control is held here. */
function playUnreadSound(): void {
  if (bellRingsNow()) {
    playSound('done')
  }
}

/** Called before a node-updated patch is applied to the store. */
export type NodeUpdateInterceptor = (
  nodeId: NodeId,
  fields: Partial<NodeData>,
  prevNode: NodeData | undefined
) => void

let cleanupFns: Array<() => void> = []
const interceptors = new Set<NodeUpdateInterceptor>()

/**
 * Fire `fn` before each node-updated patch is applied, with the node as it
 * was, so a caller can detect field-level changes (App's fork detection on
 * claudeSessionHistory growth). Separate from installing the sync, because
 * the sync can outlive the caller: on the phone it runs for the page's whole
 * life, and the canvas comes and goes (`retainServerSync`).
 */
export function addNodeUpdateInterceptor(fn: NodeUpdateInterceptor): () => void {
  interceptors.add(fn)
  return () => { interceptors.delete(fn) }
}

let retainers = 0

/**
 * Keep the server sync installed while anything holds it: installed by the
 * first holder, removed when the last lets go. The desktop's App is its only
 * holder; the phone holds it for the page's life from main.tsx, so its
 * stores — Control's among them — are current with no canvas mounted, and the
 * canvas mounting or unmounting does not resync.
 */
export function retainServerSync(): () => void {
  if (retainers++ === 0) void initServerSync()
  let released = false
  return () => {
    if (released) return
    released = true
    if (--retainers === 0) destroyServerSync()
  }
}

/**
 * Initialize the server sync layer.
 * Subscribes to IPC events and bridges them to the Zustand store.
 * Call once on app startup — or hold it with `retainServerSync`.
 */
export async function initServerSync(): Promise<void> {
  const store = useNodeStore.getState()

  // Anything that changes the picture changes this store, so one subscription
  // is the whole of "a viewer would want to see this now" — the alternative
  // being a `pokeFrames()` next to every one of the dozen `on*` handlers below,
  // which is a list that would be incomplete within a month. An unfocused
  // window runs at `REDUCED_HZ` until this fires and at full rate for a second
  // after, which is what keeps a second display live without keeping it hot.
  cleanupFns.push(useNodeStore.subscribe(() => pokeFrames()))

  // Subscribe to server node state events
  cleanupFns.push(
    window.api.node.onUpdated((nodeId: NodeId, fields: Partial<NodeData>) => {
      const prev = useNodeStore.getState().nodes[nodeId]
      interceptors.forEach((intercept) => intercept(nodeId, fields, prev))

      // Notification sound: node became unread
      if (
        'claudeStatusUnread' in fields &&
        (fields as { claudeStatusUnread: boolean }).claudeStatusUnread === true &&
        !(prev?.type === 'terminal' && prev.claudeStatusUnread)
      ) {
        playUnreadSound()
      }

      useNodeStore.getState().applyServerNodeUpdate(nodeId, fields)
    })
  )

  cleanupFns.push(
    window.api.node.onAdded((node: NodeData) => {
      // Notification sound: new node arriving already unread
      if (node.type === 'terminal' && node.claudeStatusUnread) {
        playUnreadSound()
      }
      useNodeStore.getState().applyServerNodeAdd(node)
    })
  )

  cleanupFns.push(
    window.api.node.onRemoved((nodeId: NodeId) => {
      useNodeStore.getState().applyServerNodeRemove(nodeId)
    })
  )

  cleanupFns.push(
    window.api.node.onFileContent((nodeId: NodeId, content: string) => {
      useNodeStore.getState().applyFileContent(nodeId, content)
    })
  )

  cleanupFns.push(
    window.api.node.onAgentMetaAvailability((nodeId: NodeId, available: boolean) => {
      useNodeStore.getState().setAgentMetaAvailable(nodeId, available)
    })
  )

  // The PULL that makes the PUSH above safe to miss. The broadcast fires when
  // the main process's socket connects and then only on change, so a renderer
  // that finished loading afterwards — the ordinary case — would otherwise show
  // every agent-meta button greyed out forever.
  window.api.node
    .agentMetaAvailabilityStatus()
    .then((entries) => {
      const store = useNodeStore.getState()
      for (const { nodeId, available } of entries) store.setAgentMetaAvailable(nodeId, available)
    })
    .catch(() => {})

  cleanupFns.push(
    window.api.node.onPlaySound((sound: string) => {
      playSound(sound as SoundName)
    })
  )

  cleanupFns.push(
    window.api.tts.onActiveChanged((active: boolean) => {
      playSpeechCue(active)
    })
  )

  cleanupFns.push(
    window.api.node.onSavedViewports((viewports) => {
      useSavedViewportStore.getState().setAll(viewports)
    })
  )

  cleanupFns.push(
    window.api.node.onRootCwd((cwd) => {
      useRootCwdStore.getState().set(cwd)
    })
  )

  cleanupFns.push(
    window.api.node.onAutoStampsEnabled((enabled) => {
      useAutoStampsEnabledStore.getState().set(enabled)
    })
  )

  cleanupFns.push(
    window.api.node.onRestartRequired((required, reason) => {
      useRestartRequiredStore.getState().set(required, reason)
    })
  )

  // Control's refresh_clients: the same reload as the toolbar's, blocked page and all.
  cleanupFns.push(
    window.api.node.onReloadRequested(() => {
      window.api.log('[update] reload: asked by the server')
      useUpdateActionsStore.getState().reload()
    })
  )

  // A restart asked for anywhere shows on this client's restart button too.
  cleanupFns.push(
    window.api.node.onServerRestarting(() => useUpdateActionsStore.getState().serverRestartBegun())
  )

  // An echo while Control waits on the model (see thinking-cue.ts), but only
  // where Control is heard. Derived from the store rather than from the status
  // event, because a hand-off or a mute mid-thought arrives as a holder change.
  setControlThinking(isThinkingWithinEarshot(useReceptionistStore.getState(), thinkingCueScope.alsoSynthesizing))
  cleanupFns.push(useReceptionistStore.subscribe((s) => setControlThinking(isThinkingWithinEarshot(s, thinkingCueScope.alsoSynthesizing))))
  cleanupFns.push(() => setControlThinking(false))

  // The bridge replays each of these on subscribe — they are not in
  // `ServerState`, and their on-connect push came before this ran.
  cleanupFns.push(
    window.api.receptionist.onStatus((status) => {
      // Every change is broadcast whole, so toast only an error that is new.
      const before = useReceptionistStore.getState().error
      useReceptionistStore.getState().setStatus(status)
      if (status.message && status.message !== before) showToast(`Control: ${status.message}`)
    })
  )

  cleanupFns.push(
    window.api.receptionist.onHolder((holder, muted) => {
      useReceptionistStore.getState().setHolder(holder, window.api.receptionist.deviceId, muted)
    })
  )

  cleanupFns.push(window.api.receptionist.onNotice((text) => showToast(text)))
  cleanupFns.push(window.api.receptionist.onUnread((unread) => useReceptionistStore.getState().setUnread(unread)))
  cleanupFns.push(window.api.receptionist.onBacklog((backlog) => useReceptionistStore.getState().setBacklog(backlog)))

  cleanupFns.push(
    window.api.receptionist.onAgentNames((names) => {
      useAgentNamesStore.getState().setAll(names)
    })
  )

  // Request full state from server. This PULL is the source of truth on every
  // renderer (re)load — the onSavedViewports PUSH above only fires on a fresh
  // main-process socket connect, which does NOT repeat across a renderer refresh
  // while the socket stays open, so saved viewports must be hydrated from here.
  try {
    const serverState = await window.api.node.syncRequest()
    store.applyServerState(serverState)
    syncUndoBuffer(serverState.undoBuffer ?? [], serverState.undoCursor)
    useSavedViewportStore.getState().setAll(serverState.savedViewports ?? {})
    useRootCwdStore.getState().set(serverState.rootCwd)
    useAutoStampsEnabledStore.getState().set(serverState.autoStampsEnabled !== false)
    useScriptsSocketPathStore.getState().set(serverState.scriptsSocketPath)
    useReceptionistStore.getState().setHolder(receptionistHolderOf(serverState), window.api.receptionist.deviceId, serverState.receptionistMuted ?? [])

    // Authoritative on reload: the PUSH above only fires when the flag changes
    // while the socket stays open, which a renderer refresh does not repeat.
    const restart = await window.api.node.restartFlagStatus()
    useRestartRequiredStore.getState().set(restart.required, restart.reason)
  } catch {
    // Server not connected yet — will sync on reconnect
  }

}

/**
 * Cleanup all server sync subscriptions.
 */
export function destroyServerSync(): void {
  for (const fn of cleanupFns) fn()
  cleanupFns = []
}

// --- Mutation helpers that send to server + clear overrides on ack ---

export async function sendMove(nodeId: NodeId, x: number, y: number): Promise<void> {
  await window.api.node.move(nodeId, x, y)
}

export async function sendBatchMove(moves: Array<{ nodeId: NodeId; x: number; y: number }>): Promise<void> {
  await window.api.node.batchMove(moves)
}

export async function sendRename(nodeId: NodeId, name: string): Promise<void> {
  await window.api.node.rename(nodeId, name)
}

export async function sendSetColor(nodeId: NodeId, colorPresetId: string): Promise<void> {
  await window.api.node.setColor(nodeId, colorPresetId)
}

export async function sendSetStamp(nodeId: NodeId, stamp: NodeStamp): Promise<void> {
  await window.api.node.setStamp(nodeId, stamp)
}

export async function sendRegenerateAutoStamp(nodeId: NodeId): Promise<void> {
  await window.api.node.regenerateAutoStamp(nodeId)
}

export async function sendBringToFront(nodeId: NodeId): Promise<void> {
  await window.api.node.bringToFront(nodeId)
}

export async function sendArchive(nodeId: NodeId): Promise<void> {
  await window.api.node.archive(nodeId)
}

export async function sendUnarchive(parentNodeId: NodeId, path: NodeId[]): Promise<void> {
  await window.api.node.unarchive(parentNodeId, path)
}

export async function sendArchiveDelete(parentNodeId: NodeId, path: NodeId[]): Promise<void> {
  await window.api.node.archiveDelete(parentNodeId, path)
}

export async function sendTerminalCreate(
  parentId: NodeId,
  options?: CreateOptions,
  initialTitleHistory?: string[],
  initialName?: string,
  x?: number,
  y?: number,
  initialInput?: string
): Promise<{ sessionId: PtySessionId; cols: number; rows: number }> {
  return window.api.node.terminalCreate(parentId, options, initialTitleHistory, initialName, x, y, initialInput)
}

export async function sendDirectoryAdd(parentId: NodeId, cwd: string, x?: number, y?: number): Promise<{ nodeId: NodeId }> {
  return window.api.node.directoryAdd(parentId, cwd, x, y)
}

export async function sendDirectoryCwd(nodeId: NodeId, cwd: string): Promise<void> {
  await window.api.node.directoryCwd(nodeId, cwd)
}

/** Set the root node's working directory; an empty string clears it. */
export async function sendAutoStampsEnabled(enabled: boolean): Promise<void> {
  await window.api.node.setAutoStampsEnabled(enabled)
}

export async function sendRootCwd(cwd: string): Promise<void> {
  await window.api.node.setRootCwd(cwd)
}

export async function sendFileAdd(parentId: NodeId, filePath: string, x?: number, y?: number): Promise<{ nodeId: NodeId }> {
  return window.api.node.fileAdd(parentId, filePath, x, y)
}

export async function sendFilePath(nodeId: NodeId, filePath: string): Promise<void> {
  await window.api.node.filePath(nodeId, filePath)
}

export async function sendMarkdownAdd(parentId: NodeId, x?: number, y?: number): Promise<{ nodeId: NodeId }> {
  return window.api.node.markdownAdd(parentId, x, y)
}

export async function sendMarkdownResize(nodeId: NodeId, width: number, height: number): Promise<void> {
  await window.api.node.markdownResize(nodeId, width, height)
}

export async function sendMarkdownContent(nodeId: NodeId, content: string): Promise<void> {
  await window.api.node.markdownContent(nodeId, content)
}

export async function sendAgentMetaToggle(nodeId: NodeId): Promise<boolean> {
  return window.api.node.agentMetaToggle(nodeId)
}

export async function sendAgentMetaRescan(nodeId: NodeId): Promise<void> {
  await window.api.node.agentMetaRescan(nodeId)
}

export async function sendMetaDocResize(nodeId: NodeId, width: number, height: number): Promise<void> {
  await window.api.node.metaDocResize(nodeId, width, height)
}

export async function sendMetaDocContent(nodeId: NodeId, content: string): Promise<void> {
  await window.api.node.metaDocContent(nodeId, content)
}

export async function sendMarkdownSetMaxWidth(nodeId: NodeId, maxWidth: number): Promise<void> {
  await window.api.node.markdownSetMaxWidth(nodeId, maxWidth)
}

export async function sendTerminalResize(nodeId: NodeId, cols: number, rows: number): Promise<void> {
  await window.api.node.terminalResize(nodeId, cols, rows)
}

export async function sendReparent(nodeId: NodeId, newParentId: NodeId): Promise<void> {
  await window.api.node.reparent(nodeId, newParentId)
}

export async function sendSwapParentChild(nodeId: NodeId, childId: NodeId): Promise<void> {
  await window.api.node.swapParentChild(nodeId, childId)
}

export async function sendTitleAdd(parentId: NodeId, x?: number, y?: number): Promise<{ nodeId: NodeId }> {
  return window.api.node.titleAdd(parentId, x, y)
}

export async function sendTitleText(nodeId: NodeId, text: string): Promise<void> {
  await window.api.node.titleText(nodeId, text)
}

export async function sendAutomationAdd(parentId: NodeId, x?: number, y?: number): Promise<{ nodeId: NodeId }> {
  return window.api.node.automationAdd(parentId, x, y)
}

export async function sendAutomationUpdate(nodeId: NodeId, patch: AutomationPatch): Promise<void> {
  await window.api.node.automationUpdate(nodeId, patch)
}

export async function sendAutomationClearQueue(nodeId: NodeId): Promise<void> {
  await window.api.node.automationClearQueue(nodeId)
}

export async function sendCacheTimerMute(nodeId: NodeId, muted: boolean): Promise<void> {
  await window.api.node.cacheTimerMute(nodeId, muted)
}

export async function sendTerminalReincarnate(
  nodeId: NodeId,
  options?: CreateOptions
): Promise<{ sessionId: PtySessionId; cols: number; rows: number }> {
  return window.api.node.terminalReincarnate(nodeId, options)
}

export async function sendForkSession(
  nodeId: NodeId
): Promise<{ sessionId: PtySessionId; cols: number; rows: number }> {
  return window.api.node.forkSession(nodeId)
}

export async function sendTerminalRestart(
  nodeId: NodeId,
  extraCliArgs: string
): Promise<{ sessionId: PtySessionId; cols: number; rows: number }> {
  return window.api.node.terminalRestart(nodeId, extraCliArgs)
}

export async function sendCrabReorder(order: string[]): Promise<void> {
  await window.api.node.crabReorder(order)
}

export function sendSetAlertsReadTimestamp(nodeId: NodeId, timestamp: number): void {
  window.api.node.setAlertsReadTimestamp(nodeId, timestamp)
}

export async function sendUndoPush(entry: UndoEntry): Promise<void> {
  await window.api.node.undoPush(entry)
}

export async function sendUndoSetCursor(cursor: number): Promise<void> {
  await window.api.node.undoSetCursor(cursor)
}

export function sendCameraBounds(bounds: { x: number; y: number; width: number; height: number }): void {
  window.api.node.sendCameraBounds(bounds)
}

export function sendSaveViewport(slot: string, bounds: { x: number; y: number; width: number; height: number }): void {
  window.api.node.saveViewport(slot, bounds)
}
