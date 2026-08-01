import * as fs from 'fs'
import * as path from 'path'
import { SOCKET_DIR } from '../shared/protocol'
import type { ClaudeSessionId, PtySessionId } from '../shared/ids'

const CACHE_DIR = path.join(SOCKET_DIR, 'cached-plans')

/**
 * The filesystem, narrowed to what the plan cache needs. Injecting it keeps the
 * dedup and versioning rules testable without writing into `~/.spaceterm`.
 */
export interface PlanCacheStore {
  /** Read a file, or undefined when it does not exist / cannot be read. */
  read(filePath: string): string | undefined
  /** Write a file, creating parent directories as needed. */
  write(filePath: string, content: string): void
  /** Directory cached plan versions are written to. */
  readonly cacheDir: string
}

export const REAL_PLAN_CACHE_STORE: PlanCacheStore = {
  read(filePath) {
    try {
      return fs.readFileSync(filePath, 'utf-8')
    } catch {
      return undefined
    }
  },
  write(filePath, content) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, content)
  },
  cacheDir: CACHE_DIR
}

export class PlanCacheManager {
  /** surfaceId → most recently seen plan file path (from Write/Edit to ~/.claude/plans/) */
  private trackedPlanPaths = new Map<PtySessionId, string>()
  /** claudeSessionId → array of cached file paths */
  private cache = new Map<ClaudeSessionId, string[]>()
  /**
   * Disambiguates versions captured within the same millisecond. Without it two
   * snapshots that far apart produced the same filename, so the newer one
   * overwrote the older and the version list gained a duplicate path.
   */
  private sequence = 0

  constructor(private readonly store: PlanCacheStore = REAL_PLAN_CACHE_STORE) {}

  trackPlanFile(surfaceId: PtySessionId, filePath: string): void {
    this.trackedPlanPaths.set(surfaceId, filePath)
  }

  /**
   * Read the tracked plan file from disk and copy it to the cache directory.
   * Returns the updated list of cached files for this Claude session.
   *
   * `now` is a parameter rather than a call to Date.now() so a test can pin the
   * generated filenames.
   */
  snapshot(surfaceId: PtySessionId, claudeSessionId: ClaudeSessionId, now: number = Date.now()): string[] {
    const planPath = this.trackedPlanPaths.get(surfaceId)
    if (!planPath) return this.cache.get(claudeSessionId) ?? []

    const content = this.store.read(planPath)
    if (content === undefined) return this.cache.get(claudeSessionId) ?? []

    // Deduplicate: skip if content matches the last cached version. An
    // unreadable last version is treated as a miss, so the snapshot proceeds.
    let files = this.cache.get(claudeSessionId)
    if (files && files.length > 0 && this.store.read(files[files.length - 1]) === content) {
      return files
    }

    const dest = path.join(this.store.cacheDir, `${claudeSessionId}-${now}-${++this.sequence}.plan`)
    this.store.write(dest, content)

    if (!files) {
      files = []
      this.cache.set(claudeSessionId, files)
    }
    files.push(dest)
    return files
  }

  getVersions(claudeSessionId: ClaudeSessionId): string[] {
    return this.cache.get(claudeSessionId) ?? []
  }
}
