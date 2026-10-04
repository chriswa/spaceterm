import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

/**
 * The names Claude Code sessions message each other by, such as `spaceterm-43`:
 * what SendMessage takes and ListAgents shows.
 *
 * Claude Code writes one `~/.claude/sessions/<pid>.json` per running session,
 * holding its current `sessionId` and its `name`. The name belongs to the
 * process and survives `/clear`, while the session id follows `/clear`, which
 * Spaceterm records in `claudeSessionHistory` too — so the surface's latest
 * Claude session id finds its name. Derived names are the directory plus two
 * hex digits, so two sessions in one directory can share one.
 */

export const CLAUDE_SESSIONS_DIR = path.join(os.homedir(), '.claude', 'sessions')

/** Claude session id → messaging name, from the session files' contents. */
export function parsePeerNames(files: Iterable<string>): Map<string, string> {
  const newest = new Map<string, { name: string; updatedAt: number }>()
  for (const text of files) {
    let entry: unknown
    try { entry = JSON.parse(text) } catch { continue }
    if (typeof entry !== 'object' || entry === null) continue
    const { sessionId, name, updatedAt } = entry as Record<string, unknown>
    if (typeof sessionId !== 'string' || typeof name !== 'string' || !name) continue
    // A process that died without cleaning up leaves its file behind; a session
    // resumed since then is the newer file.
    const at = typeof updatedAt === 'number' ? updatedAt : 0
    const seen = newest.get(sessionId)
    if (!seen || at > seen.updatedAt) newest.set(sessionId, { name, updatedAt: at })
  }
  return new Map([...newest].map(([sessionId, { name }]) => [sessionId, name]))
}

/** Reads the session files now. Missing directory or unreadable files give fewer names, never an error. */
export function readPeerNames(dir = CLAUDE_SESSIONS_DIR): Map<string, string> {
  let entries: string[]
  try { entries = fs.readdirSync(dir) } catch { return new Map() }
  const files: string[] = []
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue
    try { files.push(fs.readFileSync(path.join(dir, entry), 'utf8')) } catch { /* exited mid-read */ }
  }
  return parsePeerNames(files)
}
