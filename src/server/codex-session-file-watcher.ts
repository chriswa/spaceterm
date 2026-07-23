import * as fs from 'fs'
import * as path from 'path'
import { homedir } from 'os'
import { SessionFileWatcher, type SessionFileEntry } from './session-file-watcher'

const CODEX_SESSIONS_DIR = path.join(homedir(), '.codex', 'sessions')
const RETRY_MS = 500
const MAX_RETRIES = 60

type EntriesCallback = (surfaceId: string, newEntries: SessionFileEntry[], totalLineCount: number, isBackfill: boolean) => void

/**
 * Tails Codex's UUID-named rollout JSONL for a surface.  Codex hooks provide a
 * session id but not a transcript path; resolving the filename once lets the
 * shared file watcher follow the file without depending on its dated layout.
 */
export class CodexSessionFileWatcher {
  private readonly watcher: SessionFileWatcher
  private readonly retries = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(onEntries: EntriesCallback) {
    this.watcher = new SessionFileWatcher(onEntries)
  }

  watch(surfaceId: string, sessionId: string): void {
    this.unwatch(surfaceId)
    this.resolveAndWatch(surfaceId, sessionId, 0)
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

  private resolveAndWatch(surfaceId: string, sessionId: string, attempt: number): void {
    const filePath = findCodexSessionFile(sessionId)
    if (filePath) {
      this.retries.delete(surfaceId)
      this.watcher.watchPath(surfaceId, filePath)
      return
    }
    if (attempt >= MAX_RETRIES) return
    this.retries.set(surfaceId, setTimeout(() => {
      this.retries.delete(surfaceId)
      this.resolveAndWatch(surfaceId, sessionId, attempt + 1)
    }, RETRY_MS))
  }
}

/** Locate one Codex rollout by its globally unique session UUID. */
export function findCodexSessionFile(sessionId: string): string | undefined {
  if (!/^[0-9a-f-]{16,}$/i.test(sessionId)) return undefined
  const suffix = `-${sessionId}.jsonl`
  let newest: { path: string; mtimeMs: number } | undefined
  const visit = (dir: string): void => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        visit(entryPath)
      } else if (entry.isFile() && entry.name.endsWith(suffix)) {
        try {
          const mtimeMs = fs.statSync(entryPath).mtimeMs
          if (!newest || mtimeMs > newest.mtimeMs) newest = { path: entryPath, mtimeMs }
        } catch {
          // Ignore a rollout removed while resolving it.
        }
      }
    }
  }
  visit(CODEX_SESSIONS_DIR)
  return newest?.path
}
