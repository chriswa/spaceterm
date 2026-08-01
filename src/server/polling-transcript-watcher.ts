import * as fs from 'fs'
import * as path from 'path'
import { SessionFileWatcher, type SessionFileEntry } from './session-file-watcher'
import type { PtySessionId, ClaudeSessionId } from '../shared/ids'

export type EntriesCallback = (
  surfaceId: PtySessionId,
  newEntries: SessionFileEntry[],
  totalLineCount: number,
  isBackfill: boolean,
) => void

/**
 * Where an agent keeps its transcripts and how to recognise one.
 *
 * Claude needs none of this: its transcript path is computable from
 * (cwd, sessionId), so SessionFileWatcher can be pointed straight at it. Cursor
 * and Codex only hand us a session id, and the file appears somewhere under a
 * layout we do not control (a per-project directory for Cursor, a dated one for
 * Codex) some time after the session starts — hence a search plus a poll.
 */
export interface TranscriptLocator {
  /** Root of the tree to search. */
  readonly rootDir: string
  /** True when `filePath`'s basename identifies the transcript for `id`. */
  matches(filePath: string, id: string): boolean
}

/**
 * Session ids are UUID-ish. Rejecting anything else keeps a stray value (an
 * empty string, a path fragment) from triggering a full-tree walk that could
 * match an unrelated file.
 */
const ID_RE = /^[0-9a-f-]{16,}$/i

/**
 * Newest file under `rootDir` that the locator accepts for `id`, or undefined.
 *
 * Newest-wins because an id can legitimately appear more than once — Cursor
 * re-opens a conversation under a new project directory when the workspace
 * moves — and the most recently modified copy is the live one.
 *
 * `rootDir` is overridable so tests can search a temporary tree.
 */
export function findNewestTranscript(
  locator: TranscriptLocator,
  id: string,
  rootDir: string = locator.rootDir,
): string | undefined {
  if (!ID_RE.test(id)) return undefined

  let newest: { path: string; mtimeMs: number } | undefined

  const visit = (dir: string): void => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return // Unreadable or missing directory — nothing to find here.
    }
    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        visit(entryPath)
      } else if (entry.isFile() && locator.matches(entryPath, id)) {
        try {
          const mtimeMs = fs.statSync(entryPath).mtimeMs
          if (!newest || mtimeMs > newest.mtimeMs) newest = { path: entryPath, mtimeMs }
        } catch {
          // Removed while we were resolving it.
        }
      }
    }
  }

  visit(rootDir)
  return newest?.path
}

export interface PollingTranscriptWatcherOptions {
  retryMs?: number
  maxRetries?: number
}

/**
 * Tails an agent transcript whose path is not known up front: searches for it,
 * and if it is not there yet, retries on a timer until it appears or the budget
 * runs out. Once found, the shared SessionFileWatcher does the actual tailing.
 *
 * This was previously two copies — CursorSessionFileWatcher and
 * CodexSessionFileWatcher — identical except for the directory searched and the
 * filename rule, both of which are now the TranscriptLocator.
 */
export class PollingTranscriptWatcher {
  private readonly watcher: SessionFileWatcher
  private readonly retries = new Map<PtySessionId, ReturnType<typeof setTimeout>>()
  private readonly locator: TranscriptLocator
  private readonly retryMs: number
  private readonly maxRetries: number

  constructor(locator: TranscriptLocator, onEntries: EntriesCallback, options: PollingTranscriptWatcherOptions = {}) {
    this.locator = locator
    this.watcher = new SessionFileWatcher(onEntries)
    this.retryMs = options.retryMs ?? 500
    this.maxRetries = options.maxRetries ?? 60
  }

  watch(surfaceId: PtySessionId, sessionId: ClaudeSessionId): void {
    this.unwatch(surfaceId)
    this.resolveAndWatch(surfaceId, sessionId, 0)
  }

  unwatch(surfaceId: PtySessionId): void {
    const retry = this.retries.get(surfaceId)
    if (retry) clearTimeout(retry)
    this.retries.delete(surfaceId)
    this.watcher.unwatch(surfaceId)
  }

  dispose(): void {
    for (const surfaceId of Array.from(this.retries.keys())) this.unwatch(surfaceId)
    this.watcher.dispose()
  }

  getFilePath(surfaceId: PtySessionId): string | undefined {
    return this.watcher.getFilePath(surfaceId)
  }

  private resolveAndWatch(surfaceId: PtySessionId, sessionId: ClaudeSessionId, attempt: number): void {
    const filePath = findNewestTranscript(this.locator, sessionId)
    if (filePath) {
      this.retries.delete(surfaceId)
      this.watcher.watchPath(surfaceId, filePath)
      return
    }
    if (attempt >= this.maxRetries) return
    this.retries.set(surfaceId, setTimeout(() => {
      this.retries.delete(surfaceId)
      this.resolveAndWatch(surfaceId, sessionId, attempt + 1)
    }, this.retryMs))
  }
}
