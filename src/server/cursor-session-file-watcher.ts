import * as fs from 'fs'
import * as path from 'path'
import { homedir } from 'os'
import { SessionFileWatcher, type SessionFileEntry } from './session-file-watcher'

const CURSOR_PROJECTS_DIR = path.join(homedir(), '.cursor', 'projects')
const RETRY_MS = 500
const MAX_RETRIES = 60

type EntriesCallback = (surfaceId: string, newEntries: SessionFileEntry[], totalLineCount: number, isBackfill: boolean) => void

/** Tails Cursor's per-conversation JSONL, whose project directory is not derivable from a chat id. */
export class CursorSessionFileWatcher {
  private readonly watcher: SessionFileWatcher
  private readonly retries = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(onEntries: EntriesCallback) {
    this.watcher = new SessionFileWatcher(onEntries)
  }

  watch(surfaceId: string, conversationId: string): void {
    this.unwatch(surfaceId)
    this.resolveAndWatch(surfaceId, conversationId, 0)
  }

  unwatch(surfaceId: string): void {
    const retry = this.retries.get(surfaceId)
    if (retry) clearTimeout(retry)
    this.retries.delete(surfaceId)
    this.watcher.unwatch(surfaceId)
  }

  dispose(): void {
    for (const surfaceId of Array.from(this.retries.keys())) this.unwatch(surfaceId)
    this.watcher.dispose()
  }

  getFilePath(surfaceId: string): string | undefined {
    return this.watcher.getFilePath(surfaceId)
  }

  private resolveAndWatch(surfaceId: string, conversationId: string, attempt: number): void {
    const filePath = findCursorTranscript(conversationId)
    if (filePath) {
      this.retries.delete(surfaceId)
      this.watcher.watchPath(surfaceId, filePath)
      return
    }
    if (attempt >= MAX_RETRIES) return
    this.retries.set(surfaceId, setTimeout(() => {
      this.retries.delete(surfaceId)
      this.resolveAndWatch(surfaceId, conversationId, attempt + 1)
    }, RETRY_MS))
  }
}

export function findCursorTranscript(conversationId: string): string | undefined {
  if (!/^[0-9a-f-]{16,}$/i.test(conversationId)) return undefined
  let found: { path: string, mtimeMs: number } | undefined
  const visit = (dir: string): void => {
    let entries: fs.Dirent[]
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name)
      if (entry.isDirectory()) visit(entryPath)
      else if (entry.isFile() && entry.name === `${conversationId}.jsonl` && path.basename(path.dirname(entryPath)) === conversationId) {
        try {
          const mtimeMs = fs.statSync(entryPath).mtimeMs
          if (!found || mtimeMs > found.mtimeMs) found = { path: entryPath, mtimeMs }
        } catch { /* File disappeared while searching. */ }
      }
    }
  }
  visit(CURSOR_PROJECTS_DIR)
  return found?.path
}
