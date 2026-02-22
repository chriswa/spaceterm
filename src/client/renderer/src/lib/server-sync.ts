import { useNodeStore } from '../stores/nodeStore'
import { useUsageStore } from '../stores/usageStore'
import type { NodeData } from '../../../../shared/state'

/** Called before a node-updated patch is applied to the store. */
export type NodeUpdateInterceptor = (
  nodeId: string,
  fields: Partial<NodeData>,
  prevNode: NodeData | undefined
) => void

let cleanupFns: Array<() => void> = []

/**
 * Initialize the server sync layer.
 * Subscribes to IPC events and bridges them to the Zustand store.
 * Call once on app startup.
 *
 * @param onBeforeNodeUpdate — optional interceptor fired before each node-updated
 *   patch is applied. Receives the previous node state so callers can detect
 *   field-level changes (e.g. fork detection on claudeSessionHistory growth).
 */
export async function initServerSync(onBeforeNodeUpdate?: NodeUpdateInterceptor): Promise<void> {
  const store = useNodeStore.getState()

  // Subscribe to server node state events
  cleanupFns.push(
    window.api.node.onUpdated((nodeId: string, fields: Partial<NodeData>) => {
      const prev = useNodeStore.getState().nodes[nodeId]
      onBeforeNodeUpdate?.(nodeId, fields, prev)
      useNodeStore.getState().applyServerNodeUpdate(nodeId, fields)
    })
  )

  cleanupFns.push(
    window.api.node.onAdded((node: NodeData) => {
      useNodeStore.getState().applyServerNodeAdd(node)
    })
  )

  cleanupFns.push(
    window.api.node.onRemoved((nodeId: string) => {
      useNodeStore.getState().applyServerNodeRemove(nodeId)
    })
  )

  cleanupFns.push(
    window.api.node.onFileContent((nodeId: string, content: string) => {
      useNodeStore.getState().applyFileContent(nodeId, content)
    })
  )

  cleanupFns.push(
    window.api.node.onClaudeUsage((usage, subscriptionType, rateLimitTier) => {
      useUsageStore.getState().update(usage, subscriptionType, rateLimitTier)
    })
  )

  // Request full state from server
  try {
    const serverState = await window.api.node.syncRequest()
    store.applyServerState(serverState)
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

export async function sendMove(nodeId: string, x: number, y: number): Promise<void> {
  await window.api.node.move(nodeId, x, y)
}

export async function sendBatchMove(moves: Array<{ nodeId: string; x: number; y: number }>): Promise<void> {
  await window.api.node.batchMove(moves)
}

export async function sendRename(nodeId: string, name: string): Promise<void> {
  await window.api.node.rename(nodeId, name)
}

export async function sendSetColor(nodeId: string, colorPresetId: string): Promise<void> {
  await window.api.node.setColor(nodeId, colorPresetId)
}

export async function sendBringToFront(nodeId: string): Promise<void> {
  await window.api.node.bringToFront(nodeId)
}

export async function sendArchive(nodeId: string): Promise<void> {
  await window.api.node.archive(nodeId)
}

export async function sendUnarchive(parentNodeId: string, archivedNodeId: string): Promise<void> {
  await window.api.node.unarchive(parentNodeId, archivedNodeId)
}

export async function sendArchiveDelete(parentNodeId: string, archivedNodeId: string): Promise<void> {
  await window.api.node.archiveDelete(parentNodeId, archivedNodeId)
}

export async function sendTerminalCreate(
  parentId: string,
  options?: CreateOptions,
  initialTitleHistory?: string[],
  initialName?: string,
  x?: number,
  y?: number,
  initialInput?: string
): Promise<{ sessionId: string; cols: number; rows: number }> {
  return window.api.node.terminalCreate(parentId, options, initialTitleHistory, initialName, x, y, initialInput)
}

export async function sendDirectoryAdd(parentId: string, cwd: string, x?: number, y?: number): Promise<{ nodeId: string }> {
  return window.api.node.directoryAdd(parentId, cwd, x, y)
}

export async function sendDirectoryCwd(nodeId: string, cwd: string): Promise<void> {
  await window.api.node.directoryCwd(nodeId, cwd)
}

export async function sendDirectoryWtSpawn(nodeId: string, branchName: string): Promise<{ nodeId: string }> {
  return window.api.node.directoryWtSpawn(nodeId, branchName)
}

export async function sendFileAdd(parentId: string, filePath: string, x?: number, y?: number): Promise<{ nodeId: string }> {
  return window.api.node.fileAdd(parentId, filePath, x, y)
}

export async function sendFilePath(nodeId: string, filePath: string): Promise<void> {
  await window.api.node.filePath(nodeId, filePath)
}

export async function sendMarkdownAdd(parentId: string, x?: number, y?: number): Promise<{ nodeId: string }> {
  return window.api.node.markdownAdd(parentId, x, y)
}

export async function sendMarkdownResize(nodeId: string, width: number, height: number): Promise<void> {
  await window.api.node.markdownResize(nodeId, width, height)
}

export async function sendMarkdownContent(nodeId: string, content: string): Promise<void> {
  await window.api.node.markdownContent(nodeId, content)
}

export async function sendMarkdownSetMaxWidth(nodeId: string, maxWidth: number): Promise<void> {
  await window.api.node.markdownSetMaxWidth(nodeId, maxWidth)
}

export async function sendTerminalResize(nodeId: string, cols: number, rows: number): Promise<void> {
  await window.api.node.terminalResize(nodeId, cols, rows)
}

export async function sendReparent(nodeId: string, newParentId: string): Promise<void> {
  await window.api.node.reparent(nodeId, newParentId)
}

export async function sendTitleAdd(parentId: string, x?: number, y?: number): Promise<{ nodeId: string }> {
  return window.api.node.titleAdd(parentId, x, y)
}

export async function sendTitleText(nodeId: string, text: string): Promise<void> {
  await window.api.node.titleText(nodeId, text)
}

export async function sendTerminalReincarnate(
  nodeId: string,
  options?: CreateOptions
): Promise<{ sessionId: string; cols: number; rows: number }> {
  return window.api.node.terminalReincarnate(nodeId, options)
}

export async function sendForkSession(
  nodeId: string
): Promise<{ sessionId: string; cols: number; rows: number }> {
  return window.api.node.forkSession(nodeId)
}

export async function sendTerminalRestart(
  nodeId: string,
  extraCliArgs: string
): Promise<{ sessionId: string; cols: number; rows: number }> {
  return window.api.node.terminalRestart(nodeId, extraCliArgs)
}

export async function sendCrabReorder(order: string[]): Promise<void> {
  await window.api.node.crabReorder(order)
}
