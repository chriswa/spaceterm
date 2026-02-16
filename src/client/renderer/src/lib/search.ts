import type { NodeData, ArchivedNode } from '../../../../shared/state'

// --- Types ---

export interface SearchEntry {
  data: NodeData
  isActive: boolean
  archivedAt?: string
  archiveParentId?: string
  depth: number
}

export type MatchField = 'name' | 'cwd' | 'shellTitle' | 'markdown'

export interface SearchResult {
  entry: SearchEntry
  score: number
  matchField: MatchField
  sessionLabel?: string
}

// --- Helpers extracted from ArchiveBody ---

export function relativeTime(isoDate: string): string {
  const diff = Date.now() - new Date(isoDate).getTime()
  const seconds = Math.floor(diff / 1000)
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

export function typeLabel(data: NodeData): string {
  if (data.type === 'terminal' && data.terminalSessions[0]?.claudeSessionId) {
    return 'Claude Code'
  }
  if (data.type === 'terminal') return 'Terminal'
  if (data.type === 'markdown') return 'Markdown'
  if (data.type === 'directory') return 'Directory'
  return data.type
}

// --- Search index building ---

export function buildSearchableEntries(
  nodes: Record<string, NodeData>,
  rootArchivedChildren: ArchivedNode[]
): SearchEntry[] {
  const entries: SearchEntry[] = []

  // Live nodes
  for (const data of Object.values(nodes)) {
    entries.push({ data, isActive: true, depth: 0 })
  }

  // Archived children of live nodes
  for (const data of Object.values(nodes)) {
    collectArchived(entries, data.archivedChildren, data.id, 0)
  }

  // Root-level archived children
  collectArchived(entries, rootArchivedChildren, 'root', 0)

  return entries
}

function collectArchived(
  entries: SearchEntry[],
  archives: ArchivedNode[],
  archiveParentId: string,
  depth: number
): void {
  for (const archived of archives) {
    entries.push({
      data: archived.data,
      isActive: false,
      archivedAt: archived.archivedAt,
      archiveParentId,
      depth,
    })
    // Recurse into nested archives
    collectArchived(entries, archived.data.archivedChildren, archiveParentId, depth + 1)
  }
}

// --- Scoring & searching ---

const TYPE_SORT_ORDER: Record<string, number> = { directory: 0, terminal: 1, markdown: 2 }

export function searchEntries(
  entries: SearchEntry[],
  query: string,
  limit = 50
): { results: SearchResult[]; totalMatches: number } {
  if (!query.trim()) {
    // Empty query: match everything, sort active-first then by type
    const all: SearchResult[] = entries.map(entry => ({
      entry,
      score: 0,
      matchField: 'name' as MatchField,
    }))
    all.sort((a, b) => {
      // Active before archived
      if (a.entry.isActive !== b.entry.isActive) return a.entry.isActive ? -1 : 1
      // By type order
      const aType = TYPE_SORT_ORDER[a.entry.data.type] ?? 9
      const bType = TYPE_SORT_ORDER[b.entry.data.type] ?? 9
      return aType - bType
    })
    return { results: all.slice(0, limit), totalMatches: all.length }
  }

  const q = query.toLowerCase()
  const results: SearchResult[] = []

  for (const entry of entries) {
    const result = scoreEntry(entry, q)
    if (result) results.push(result)
  }

  results.sort((a, b) => b.score - a.score)
  return { results: results.slice(0, limit), totalMatches: results.length }
}

function scoreEntry(entry: SearchEntry, q: string): SearchResult | null {
  const { data } = entry
  let bestScore = 0
  let bestField: MatchField = 'name'
  let sessionLabel: string | undefined

  // Name match: score 1000
  if (data.name && data.name.toLowerCase().includes(q)) {
    bestScore = 1000
    bestField = 'name'
  }

  // CWD match: score 750
  if (data.type === 'directory' || data.type === 'terminal') {
    const cwd = data.cwd
    if (cwd && cwd.toLowerCase().includes(q) && 750 > bestScore) {
      bestScore = 750
      bestField = 'cwd'
    }
  }

  // Shell title history match: score 500 (+ 50 if latest session)
  if (data.type === 'terminal') {
    const sessions = data.terminalSessions
    const totalSessions = sessions.length
    for (let si = 0; si < totalSessions; si++) {
      const session = sessions[si]
      for (const title of session.shellTitleHistory) {
        if (title.toLowerCase().includes(q)) {
          const isLatest = si === totalSessions - 1
          const score = 500 + (isLatest ? 50 : 0)
          if (score > bestScore) {
            bestScore = score
            bestField = 'shellTitle'
            sessionLabel = !isLatest ? `Session ${si + 1} of ${totalSessions}` : undefined
          }
        }
      }
    }

    // Also check the flat shellTitleHistory (which includes the current/latest)
    for (const title of data.shellTitleHistory) {
      if (title.toLowerCase().includes(q)) {
        const score = 550 // latest session equivalent
        if (score > bestScore) {
          bestScore = score
          bestField = 'shellTitle'
          sessionLabel = undefined
        }
      }
    }
  }

  // Markdown content match: score 250
  if (data.type === 'markdown' && data.content.toLowerCase().includes(q) && 250 > bestScore) {
    bestScore = 250
    bestField = 'markdown'
  }

  if (bestScore === 0) return null

  // Tie-breakers
  if (entry.isActive) bestScore += 100

  return { entry, score: bestScore, matchField: bestField, sessionLabel }
}
