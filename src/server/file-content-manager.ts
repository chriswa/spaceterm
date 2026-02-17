import * as fs from 'fs'
import * as path from 'path'

interface WatchedEntry {
  markdownNodeId: string
  fileNodeId: string
  resolvedPath: string
  lastWrittenContent: string | null
  watcher: fs.FSWatcher | null
  debounceTimer: ReturnType<typeof setTimeout> | null
}

/**
 * Manages bidirectional file sync for file-backed markdown nodes.
 * Handles watching, reading, writing, and echo suppression.
 */
export class FileContentManager {
  private entries = new Map<string, WatchedEntry>()
  private onContent: (nodeId: string, content: string) => void

  constructor(onContent: (nodeId: string, content: string) => void) {
    this.onContent = onContent
  }

  /**
   * Start watching a file for a markdown node.
   * Reads the file (creating it if missing), broadcasts content, and starts fs.watch.
   */
  startWatching(markdownNodeId: string, fileNodeId: string, resolvedPath: string): void {
    // Stop any existing watcher for this node
    this.stopWatching(markdownNodeId)

    // Ensure parent directory exists
    const dir = path.dirname(resolvedPath)
    fs.mkdirSync(dir, { recursive: true })

    // Read or create file
    let content: string
    try {
      content = fs.readFileSync(resolvedPath, 'utf-8')
    } catch {
      // File doesn't exist — create it empty
      fs.writeFileSync(resolvedPath, '', 'utf-8')
      content = ''
    }

    const entry: WatchedEntry = {
      markdownNodeId,
      fileNodeId,
      resolvedPath,
      lastWrittenContent: null,
      watcher: null,
      debounceTimer: null
    }

    this.entries.set(markdownNodeId, entry)

    // Broadcast initial content
    this.onContent(markdownNodeId, content)

    // Start file watcher with debounce
    this.startFsWatcher(entry)
  }

  private startFsWatcher(entry: WatchedEntry): void {
    try {
      let watchDebounce: ReturnType<typeof setTimeout> | null = null
      entry.watcher = fs.watch(entry.resolvedPath, () => {
        if (watchDebounce) clearTimeout(watchDebounce)
        watchDebounce = setTimeout(() => {
          watchDebounce = null
          this.handleFileChange(entry)
        }, 100)
      })
      entry.watcher.on('error', () => {
        // File may have been deleted — stop watching
        entry.watcher?.close()
        entry.watcher = null
      })
    } catch {
      // File doesn't exist or can't be watched
      entry.watcher = null
    }
  }

  private handleFileChange(entry: WatchedEntry): void {
    let content: string
    try {
      content = fs.readFileSync(entry.resolvedPath, 'utf-8')
    } catch {
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
  stopWatching(markdownNodeId: string): void {
    const entry = this.entries.get(markdownNodeId)
    if (!entry) return
    if (entry.watcher) {
      entry.watcher.close()
      entry.watcher = null
    }
    if (entry.debounceTimer) {
      clearTimeout(entry.debounceTimer)
      entry.debounceTimer = null
    }
    this.entries.delete(markdownNodeId)
  }

  /**
   * Write content to a file-backed markdown's file.
   */
  writeContent(markdownNodeId: string, content: string): void {
    const entry = this.entries.get(markdownNodeId)
    if (!entry) return
    entry.lastWrittenContent = content
    try {
      fs.writeFileSync(entry.resolvedPath, content, 'utf-8')
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
  getContent(markdownNodeId: string): string | null {
    const entry = this.entries.get(markdownNodeId)
    if (!entry) return null
    try {
      return fs.readFileSync(entry.resolvedPath, 'utf-8')
    } catch {
      return null
    }
  }

  /**
   * Check if a markdown node is being watched.
   */
  isWatched(markdownNodeId: string): boolean {
    return this.entries.has(markdownNodeId)
  }

  /**
   * Update the file path for a watched node (stop old watcher, start new one).
   */
  updatePath(markdownNodeId: string, fileNodeId: string, newResolvedPath: string): void {
    const entry = this.entries.get(markdownNodeId)
    if (!entry) return
    this.stopWatching(markdownNodeId)
    this.startWatching(markdownNodeId, fileNodeId, newResolvedPath)
  }

  /**
   * Get all watched markdown node IDs (for initial sync enumeration).
   */
  getWatchedNodeIds(): string[] {
    return Array.from(this.entries.keys())
  }

  /**
   * Cleanup all watchers.
   */
  dispose(): void {
    for (const [id] of this.entries) {
      this.stopWatching(id)
    }
  }
}
