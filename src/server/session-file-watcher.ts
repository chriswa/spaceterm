import * as fs from 'fs'
import * as path from 'path'
import { homedir } from 'os'

export interface SessionFileEntry {
  type: string
  [key: string]: unknown
}

type EntriesCallback = (surfaceId: string, newEntries: SessionFileEntry[], totalLineCount: number) => void

interface WatchedFile {
  surfaceId: string
  filePath: string
  lineCount: number
  byteOffset: number
  watcher: fs.FSWatcher | null
  debounceTimer: ReturnType<typeof setTimeout> | null
}

const DEBOUNCE_MS = 50
const CLAUDE_PROJECTS_DIR = path.join(homedir(), '.claude', 'projects')

function cwdToSlug(cwd: string): string {
  return cwd.replaceAll('/', '-')
}

function sessionFilePath(cwd: string, claudeSessionId: string): string {
  return path.join(CLAUDE_PROJECTS_DIR, cwdToSlug(cwd), `${claudeSessionId}.jsonl`)
}

function parseJsonlLines(text: string): SessionFileEntry[] {
  const entries: SessionFileEntry[] = []
  for (const line of text.split('\n')) {
    if (line.length === 0) continue
    try {
      const obj = JSON.parse(line)
      if (obj && typeof obj === 'object' && typeof obj.type === 'string') {
        entries.push(obj as SessionFileEntry)
      }
    } catch {
      // Skip malformed lines
    }
  }
  return entries
}

export class SessionFileWatcher {
  private watched = new Map<string, WatchedFile>()
  private onEntries: EntriesCallback

  constructor(onEntries: EntriesCallback) {
    this.onEntries = onEntries
  }

  watch(surfaceId: string, claudeSessionId: string, cwd: string): void {
    this.unwatch(surfaceId)

    const filePath = sessionFilePath(cwd, claudeSessionId)
    const entry: WatchedFile = {
      surfaceId,
      filePath,
      lineCount: 0,
      byteOffset: 0,
      watcher: null,
      debounceTimer: null
    }
    this.watched.set(surfaceId, entry)

    if (fs.existsSync(filePath)) {
      this.initialRead(entry)
      this.watchFile(entry)
    } else {
      this.watchParentForCreation(entry)
    }
  }

  unwatch(surfaceId: string): void {
    const entry = this.watched.get(surfaceId)
    if (!entry) return
    if (entry.watcher) {
      entry.watcher.close()
      entry.watcher = null
    }
    if (entry.debounceTimer) {
      clearTimeout(entry.debounceTimer)
      entry.debounceTimer = null
    }
    this.watched.delete(surfaceId)
  }

  dispose(): void {
    for (const surfaceId of Array.from(this.watched.keys())) {
      this.unwatch(surfaceId)
    }
  }

  getLineCount(surfaceId: string): number | null {
    const entry = this.watched.get(surfaceId)
    return entry ? entry.lineCount : null
  }

  private initialRead(entry: WatchedFile): void {
    try {
      const content = fs.readFileSync(entry.filePath, 'utf-8')
      const entries = parseJsonlLines(content)
      entry.lineCount = entries.length
      entry.byteOffset = Buffer.byteLength(content, 'utf-8')
      if (entries.length > 0) {
        this.onEntries(entry.surfaceId, entries, entry.lineCount)
      }
    } catch {
      // File may have been removed between check and read
    }
  }

  private watchFile(entry: WatchedFile): void {
    try {
      entry.watcher = fs.watch(entry.filePath, () => {
        this.debouncedRead(entry)
      })
      entry.watcher.on('error', () => {
        // File may have been deleted
      })
    } catch {
      // File may not exist
    }
  }

  private watchParentForCreation(entry: WatchedFile): void {
    const parentDir = path.dirname(entry.filePath)
    const fileName = path.basename(entry.filePath)

    // Ensure parent directory exists before watching
    try {
      fs.mkdirSync(parentDir, { recursive: true })
    } catch {
      // May already exist
    }

    try {
      entry.watcher = fs.watch(parentDir, (_eventType, changedFile) => {
        if (changedFile === fileName && fs.existsSync(entry.filePath)) {
          // File created — switch to file watching
          if (entry.watcher) {
            entry.watcher.close()
            entry.watcher = null
          }
          this.initialRead(entry)
          this.watchFile(entry)
        }
      })
      entry.watcher.on('error', () => {
        // Directory may have been removed
      })
    } catch {
      // Parent dir may not exist
    }
  }

  private debouncedRead(entry: WatchedFile): void {
    if (entry.debounceTimer) return
    entry.debounceTimer = setTimeout(() => {
      entry.debounceTimer = null
      this.readDelta(entry)
    }, DEBOUNCE_MS)
  }

  private readDelta(entry: WatchedFile): void {
    try {
      const stat = fs.statSync(entry.filePath)
      if (stat.size <= entry.byteOffset) return

      const fd = fs.openSync(entry.filePath, 'r')
      try {
        const deltaSize = stat.size - entry.byteOffset
        const buffer = Buffer.alloc(deltaSize)
        fs.readSync(fd, buffer, 0, deltaSize, entry.byteOffset)
        entry.byteOffset = stat.size

        const text = buffer.toString('utf-8')
        const newEntries = parseJsonlLines(text)
        if (newEntries.length > 0) {
          entry.lineCount += newEntries.length
          this.onEntries(entry.surfaceId, newEntries, entry.lineCount)
        }
      } finally {
        fs.closeSync(fd)
      }
    } catch {
      // File may have been removed or truncated
    }
  }
}
