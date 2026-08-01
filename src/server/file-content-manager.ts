import * as fs from 'fs'
import * as path from 'path'
import type { NodeId } from '../shared/ids'

const WATCH_DEBOUNCE_MS = 100

/** Cancels a scheduled callback. Calling it after the callback ran is a no-op. */
export type CancelScheduled = () => void

/** A live file watch. Closing it stops further change callbacks. */
export interface FileWatchHandle {
  close(): void
}

/**
 * The filesystem, narrowed to what file-backed markdown sync needs. Injecting
 * it makes the interesting part testable — echo suppression, debounce, and what
 * happens when a file is swapped or deleted underneath a watch — without
 * depending on `fs.watch`'s platform-specific event timing.
 */
export interface FileContentIO {
  /** Read a file, or undefined when it does not exist / cannot be read. */
  readFile(filePath: string): string | undefined
  /** Write a file, creating parent directories as needed. May throw. */
  writeFile(filePath: string, content: string): void
  /**
   * Watch a file. `onChange` fires on every filesystem event; `onError` fires
   * when the watch itself dies (the usual cause is the file being deleted).
   * Returns null when the path cannot be watched at all.
   */
  watch(filePath: string, onChange: () => void, onError: () => void): FileWatchHandle | null
  scheduleTimeout(fn: () => void, ms: number): CancelScheduled
}

export const REAL_FILE_CONTENT_IO: FileContentIO = {
  readFile(filePath) {
    try {
      return fs.readFileSync(filePath, 'utf-8')
    } catch {
      return undefined
    }
  },
  writeFile(filePath, content) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, content, 'utf-8')
  },
  watch(filePath, onChange, onError) {
    try {
      const watcher = fs.watch(filePath, () => onChange())
      watcher.on('error', () => onError())
      return { close: () => watcher.close() }
    } catch {
      return null
    }
  },
  scheduleTimeout(fn, ms) {
    const timer = setTimeout(fn, ms)
    return () => clearTimeout(timer)
  }
}

interface WatchedEntry {
  markdownNodeId: NodeId
  fileNodeId: NodeId
  resolvedPath: string
  lastWrittenContent: string | null
  watcher: FileWatchHandle | null
  /**
   * Cancels the pending debounced read.
   *
   * This used to be declared on the entry, cleared by stopWatching, and never
   * actually assigned — the real timer was a local inside startFsWatcher, out
   * of reach. So a debounce already in flight survived stopWatching and fired
   * against a removed entry. The visible symptom was in updatePath, which is
   * stop-then-start: repointing a file card while its old file was being edited
   * broadcast the *old* file's content moments after the switch.
   */
  cancelDebounce: CancelScheduled | null
}

/**
 * Manages bidirectional file sync for file-backed markdown nodes.
 * Handles watching, reading, writing, and echo suppression.
 */
export class FileContentManager {
  private entries = new Map<NodeId, WatchedEntry>()
  private onContent: (nodeId: NodeId, content: string) => void
  private io: FileContentIO

  constructor(
    onContent: (nodeId: NodeId, content: string) => void,
    io: FileContentIO = REAL_FILE_CONTENT_IO
  ) {
    this.onContent = onContent
    this.io = io
  }

  /**
   * Start watching a file for a markdown node.
   * Reads the file (creating it if missing), broadcasts content, and starts the watch.
   */
  startWatching(markdownNodeId: NodeId, fileNodeId: NodeId, resolvedPath: string): void {
    // Stop any existing watcher for this node
    this.stopWatching(markdownNodeId)

    let content = this.io.readFile(resolvedPath)
    if (content === undefined) {
      // File doesn't exist — create it empty
      try {
        this.io.writeFile(resolvedPath, '')
      } catch (err) {
        console.error(`[file-content] Failed to create ${resolvedPath}: ${(err as Error).message}`)
        return
      }
      content = ''
    }

    const entry: WatchedEntry = {
      markdownNodeId,
      fileNodeId,
      resolvedPath,
      lastWrittenContent: null,
      watcher: null,
      cancelDebounce: null
    }

    this.entries.set(markdownNodeId, entry)

    // Broadcast initial content
    this.onContent(markdownNodeId, content)

    // Start file watcher with debounce
    this.startFsWatcher(entry)
  }

  private startFsWatcher(entry: WatchedEntry): void {
    entry.watcher = this.io.watch(
      entry.resolvedPath,
      () => {
        // Editors often produce several events per save. Coalesce them, and
        // keep the cancel on the entry so stopWatching can reach it.
        entry.cancelDebounce?.()
        entry.cancelDebounce = this.io.scheduleTimeout(() => {
          entry.cancelDebounce = null
          this.handleFileChange(entry)
        }, WATCH_DEBOUNCE_MS)
      },
      () => {
        // File may have been deleted — stop watching
        entry.watcher?.close()
        entry.watcher = null
      }
    )
  }

  private handleFileChange(entry: WatchedEntry): void {
    const content = this.io.readFile(entry.resolvedPath)
    if (content === undefined) {
      // File was deleted or unreadable
      return
    }

    // Echo suppression: if content matches what we last wrote, skip broadcast
    if (entry.lastWrittenContent !== null && content === entry.lastWrittenContent) {
      entry.lastWrittenContent = null
      return
    }

    entry.lastWrittenContent = null
    this.onContent(entry.markdownNodeId, content)
  }

  /**
   * Stop watching a markdown node's file.
   */
  stopWatching(markdownNodeId: NodeId): void {
    const entry = this.entries.get(markdownNodeId)
    if (!entry) return
    if (entry.watcher) {
      entry.watcher.close()
      entry.watcher = null
    }
    entry.cancelDebounce?.()
    entry.cancelDebounce = null
    this.entries.delete(markdownNodeId)
  }

  /**
   * Write content to a file-backed markdown's file.
   */
  writeContent(markdownNodeId: NodeId, content: string): void {
    const entry = this.entries.get(markdownNodeId)
    if (!entry) return
    entry.lastWrittenContent = content
    try {
      this.io.writeFile(entry.resolvedPath, content)
    } catch (err) {
      console.error(`[file-content] Failed to write ${entry.resolvedPath}: ${(err as Error).message}`)
      entry.lastWrittenContent = null
      return
    }
    this.onContent(markdownNodeId, content)
  }

  /**
   * Get the current file content for a watched node (for initial sync).
   */
  getContent(markdownNodeId: NodeId): string | null {
    const entry = this.entries.get(markdownNodeId)
    if (!entry) return null
    return this.io.readFile(entry.resolvedPath) ?? null
  }

  /**
   * Check if a markdown node is being watched.
   */
  isWatched(markdownNodeId: NodeId): boolean {
    return this.entries.has(markdownNodeId)
  }

  /**
   * Update the file path for a watched node (stop old watcher, start new one).
   */
  updatePath(markdownNodeId: NodeId, fileNodeId: NodeId, newResolvedPath: string): void {
    if (!this.entries.has(markdownNodeId)) return
    this.stopWatching(markdownNodeId)
    this.startWatching(markdownNodeId, fileNodeId, newResolvedPath)
  }

  /**
   * Get all watched markdown node IDs (for initial sync enumeration).
   */
  getWatchedNodeIds(): NodeId[] {
    return Array.from(this.entries.keys())
  }

  /**
   * Cleanup all watchers.
   */
  dispose(): void {
    // Snapshot the ids: stopWatching deletes from the map we would be iterating.
    for (const id of this.getWatchedNodeIds()) {
      this.stopWatching(id)
    }
  }
}
