import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'
import { homedir } from 'os'

const CLAUDE_PROJECTS_DIR = path.join(homedir(), '.claude', 'projects')

/**
 * Compute the display name for a forked session.
 * Falls back to "Untitled (fork)" when the source has no name,
 * and avoids double-suffixing when forking a fork.
 */
export function computeForkName(sourceName: string | undefined | null): string {
  if (!sourceName) return 'Untitled (fork)'
  if (sourceName.endsWith('(fork)') || sourceName.endsWith('(Fork)')) return sourceName
  return `${sourceName} (fork)`
}

function cwdToSlug(cwd: string): string {
  return cwd.replaceAll('/', '-')
}

export function sessionFilePath(cwd: string, claudeSessionId: string): string {
  return path.join(CLAUDE_PROJECTS_DIR, cwdToSlug(cwd), `${claudeSessionId}.jsonl`)
}

/** Types of entries to keep in the forked transcript. */
const KEEP_TYPES = new Set(['user', 'assistant', 'attachment', 'system', 'progress'])

/**
 * Clone a Claude Code JSONL session transcript, rewriting it with a new session
 * ID and forkedFrom metadata. Returns the new session UUID.
 */
export function forkSession(cwd: string, sourceClaudeSessionId: string): string {
  const sourcePath = sessionFilePath(cwd, sourceClaudeSessionId)

  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Session file not found: ${sourcePath}`)
  }

  const raw = fs.readFileSync(sourcePath, 'utf-8')
  const lines = raw.split('\n')

  // Parse and filter entries
  const entries: Array<Record<string, unknown>> = []
  for (const line of lines) {
    if (line.length === 0) continue
    try {
      const obj = JSON.parse(line)
      if (!obj || typeof obj !== 'object' || typeof obj.type !== 'string') continue
      if (!KEEP_TYPES.has(obj.type as string)) continue
      if (obj.isSidechain) continue
      entries.push(obj as Record<string, unknown>)
    } catch {
      // Skip truncated/malformed lines
    }
  }

  if (entries.length === 0) {
    throw new Error('No valid entries in source session')
  }

  const newSessionId = crypto.randomUUID()

  // Detect plan file slug (last entry wins — a session may use multiple plans)
  let oldSlug: string | undefined
  for (let i = entries.length - 1; i >= 0; i--) {
    if (typeof entries[i].slug === 'string') {
      oldSlug = entries[i].slug as string
      break
    }
  }
  const newSlug = oldSlug ? `${oldSlug}-fork-${crypto.randomBytes(2).toString('hex')}` : undefined

  // Copy the plan file on disk so the fork gets its own independent copy
  if (oldSlug && newSlug) {
    const plansDir = path.join(homedir(), '.claude', 'plans')
    const oldPlanPath = path.join(plansDir, `${oldSlug}.md`)
    const newPlanPath = path.join(plansDir, `${newSlug}.md`)
    if (fs.existsSync(oldPlanPath)) {
      fs.copyFileSync(oldPlanPath, newPlanPath)
    }
  }

  // Build UUID remapping: old uuid → new uuid, so parentUuid chains stay valid
  const uuidMap = new Map<string, string>()
  for (const entry of entries) {
    if (typeof entry.uuid === 'string') {
      uuidMap.set(entry.uuid, crypto.randomUUID())
    }
  }

  // Rewrite each entry
  const rewritten: string[] = []
  for (const entry of entries) {
    const oldUuid = entry.uuid as string | undefined
    const newEntry: Record<string, unknown> = {
      ...entry,
      sessionId: newSessionId,
      isSidechain: false,
    }

    // Remap UUIDs
    if (oldUuid && uuidMap.has(oldUuid)) {
      newEntry.uuid = uuidMap.get(oldUuid)
    }
    const oldParent = entry.parentUuid as string | undefined
    if (oldParent && uuidMap.has(oldParent)) {
      newEntry.parentUuid = uuidMap.get(oldParent)
    }

    // Add forkedFrom metadata
    if (oldUuid) {
      newEntry.forkedFrom = {
        sessionId: sourceClaudeSessionId,
        messageUuid: oldUuid,
      }
    }

    // Rewrite plan slug field
    if (newSlug && typeof newEntry.slug === 'string') {
      newEntry.slug = newSlug
    }

    let json = JSON.stringify(newEntry)

    // Rewrite plan file path references in message content (covers both
    // absolute paths like /Users/.../.claude/plans/slug.md and tilde
    // paths like ~/.claude/plans/slug.md)
    if (oldSlug && newSlug) {
      json = json.split(`.claude/plans/${oldSlug}.md`).join(`.claude/plans/${newSlug}.md`)
    }

    rewritten.push(json)
  }

  // Write to new file
  const targetDir = path.join(CLAUDE_PROJECTS_DIR, cwdToSlug(cwd))
  fs.mkdirSync(targetDir, { recursive: true })
  const targetPath = path.join(targetDir, `${newSessionId}.jsonl`)
  fs.writeFileSync(targetPath, rewritten.join('\n') + '\n', 'utf-8')

  return newSessionId
}
