import * as fs from 'fs'
import * as path from 'path'
import { SOCKET_DIR } from '../shared/protocol'

const CACHE_DIR = path.join(SOCKET_DIR, 'cached-plans')

export class PlanCacheManager {
  /** surfaceId → most recently seen plan file path (from Write/Edit to ~/.claude/plans/) */
  private trackedPlanPaths = new Map<string, string>()
  /** claudeSessionId → array of cached file paths */
  private cache = new Map<string, string[]>()

  trackPlanFile(surfaceId: string, filePath: string): void {
    this.trackedPlanPaths.set(surfaceId, filePath)
  }

  /**
   * Read the tracked plan file from disk and copy it to the cache directory.
   * Returns the updated list of cached files for this Claude session.
   */
  snapshot(surfaceId: string, claudeSessionId: string): string[] {
    const planPath = this.trackedPlanPaths.get(surfaceId)
    if (!planPath) return this.cache.get(claudeSessionId) ?? []

    let content: string
    try {
      content = fs.readFileSync(planPath, 'utf-8')
    } catch {
      return this.cache.get(claudeSessionId) ?? []
    }

    // Deduplicate: skip if content matches the last cached version
    let files = this.cache.get(claudeSessionId)
    if (files && files.length > 0) {
      try {
        const lastContent = fs.readFileSync(files[files.length - 1], 'utf-8')
        if (lastContent === content) return files
      } catch {
        // Last file unreadable — proceed with new snapshot
      }
    }

    fs.mkdirSync(CACHE_DIR, { recursive: true })
    const dest = path.join(CACHE_DIR, `${claudeSessionId}-${Date.now()}.plan`)
    fs.writeFileSync(dest, content)

    if (!files) {
      files = []
      this.cache.set(claudeSessionId, files)
    }
    files.push(dest)
    return files
  }

  getVersions(claudeSessionId: string): string[] {
    return this.cache.get(claudeSessionId) ?? []
  }
}
