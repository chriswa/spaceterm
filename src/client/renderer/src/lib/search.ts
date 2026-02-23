import type { NodeData, ArchivedNode } from '../../../../shared/state'
import type { ColorPreset } from './color-presets'
import { COLOR_PRESET_MAP, DEFAULT_PRESET } from './color-presets'

// --- Types ---

export type NodeTypeFilter = 'terminal' | 'markdown' | 'directory'

export type SearchMode =
  | { kind: 'global' }
  | { kind: 'archived-children'; parentId: string }

export interface AncestorEntry {
  data: NodeData
  isLive: boolean
}

export interface SearchEntry {
  data: NodeData
  isActive: boolean
  archivedAt?: string
  archiveParentId?: string
  depth: number
  resolvedPreset: ColorPreset
  ancestors: AncestorEntry[]
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
  if (seconds < 60) return `${seconds < 30 ? 0 : 1}m ago`
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
  rootArchivedChildren: ArchivedNode[],
  resolvedPresets: Record<string, ColorPreset>,
  mode: SearchMode,
  archiveMaxDepth: number = Infinity
): SearchEntry[] {
  const entries: SearchEntry[] = []

  // Build a unified lookup of ALL nodes (live + archived) for ancestor chain walking.
  // Archived nodes' parentId is preserved from when they were alive, so walking
  // parentId chains through this map reconstructs the full ancestor tree.
  const allNodeLookup = new Map<string, { data: NodeData; isLive: boolean }>()
  for (const data of Object.values(nodes)) {
    allNodeLookup.set(data.id, { data, isLive: true })
  }
  function indexArchived(archives: ArchivedNode[]): void {
    for (const a of archives) {
      if (!allNodeLookup.has(a.data.id)) {
        allNodeLookup.set(a.data.id, { data: a.data, isLive: false })
      }
      indexArchived(a.data.archivedChildren)
    }
  }
  for (const data of Object.values(nodes)) indexArchived(data.archivedChildren)
  indexArchived(rootArchivedChildren)

  if (mode.kind === 'archived-children') {
    const parentPreset = resolvedPresets[mode.parentId] ?? DEFAULT_PRESET
    if (mode.parentId === 'root') {
      collectArchived(entries, rootArchivedChildren, 'root', 0, parentPreset, archiveMaxDepth)
    } else {
      const node = nodes[mode.parentId]
      if (node) {
        collectArchived(entries, node.archivedChildren, node.id, 0, parentPreset, archiveMaxDepth)
      }
    }
  } else {
    // Global mode: live nodes + all archives
    for (const data of Object.values(nodes)) {
      entries.push({ data, isActive: true, depth: 0, resolvedPreset: resolvedPresets[data.id] ?? DEFAULT_PRESET, ancestors: [] })
    }
    for (const data of Object.values(nodes)) {
      const parentPreset = resolvedPresets[data.id] ?? DEFAULT_PRESET
      collectArchived(entries, data.archivedChildren, data.id, 0, parentPreset, Infinity)
    }
    collectArchived(entries, rootArchivedChildren, 'root', 0, resolvedPresets['root'] ?? DEFAULT_PRESET, Infinity)
  }

  // Compute ancestor chains for all entries
  for (const entry of entries) {
    entry.ancestors = buildAncestorChain(entry.data.parentId, allNodeLookup)
  }

  return entries
}

function collectArchived(
  entries: SearchEntry[],
  archives: ArchivedNode[],
  archiveParentId: string,
  depth: number,
  inheritedPreset: ColorPreset,
  maxDepth: number
): void {
  for (const archived of archives) {
    const ownId = archived.data.colorPresetId
    const resolvedPreset = (ownId && ownId !== 'inherit' && COLOR_PRESET_MAP[ownId])
      ? COLOR_PRESET_MAP[ownId]!
      : inheritedPreset

    entries.push({
      data: archived.data,
      isActive: false,
      archivedAt: archived.archivedAt,
      archiveParentId,
      depth,
      resolvedPreset,
      ancestors: [], // filled in by buildSearchableEntries post-loop
    })
    if (depth < maxDepth) {
      collectArchived(entries, archived.data.archivedChildren, archiveParentId, depth + 1, resolvedPreset, maxDepth)
    }
  }
}

function buildAncestorChain(
  startParentId: string,
  lookup: Map<string, { data: NodeData; isLive: boolean }>
): AncestorEntry[] {
  const chain: AncestorEntry[] = []
  let currentId = startParentId
  const visited = new Set<string>()
  while (currentId && currentId !== 'root' && !visited.has(currentId)) {
    visited.add(currentId)
    const entry = lookup.get(currentId)
    if (!entry) break
    chain.push({ data: entry.data, isLive: entry.isLive })
    currentId = entry.data.parentId
  }
  chain.reverse() // root-to-parent order
  return chain
}

// --- Scoring & searching ---

const TYPE_SORT_ORDER: Record<string, number> = { directory: 0, terminal: 1, markdown: 2 }

export function searchEntries(
  entries: SearchEntry[],
  query: string,
  typeFilters?: Set<NodeTypeFilter>
): SearchResult[] {
  // Pre-filter by type if filters are active
  const filtered = typeFilters && typeFilters.size > 0
    ? entries.filter(e => typeFilters.has(e.data.type as NodeTypeFilter))
    : entries

  if (!query.trim()) {
    // Empty query: match everything, sort active-first then by type
    const all: SearchResult[] = filtered.map(entry => ({
      entry,
      score: 0,
      matchField: 'name' as MatchField,
    }))
    all.sort((a, b) => {
      // Active before archived
      if (a.entry.isActive !== b.entry.isActive) return a.entry.isActive ? -1 : 1
      // Within each group: most recently focused first
      const aTime = a.entry.data.lastFocusedAt ?? ''
      const bTime = b.entry.data.lastFocusedAt ?? ''
      if (aTime !== bTime) return aTime > bTime ? -1 : 1
      // Fallback: type order
      const aType = TYPE_SORT_ORDER[a.entry.data.type] ?? 9
      const bType = TYPE_SORT_ORDER[b.entry.data.type] ?? 9
      return aType - bType
    })
    return all
  }

  const q = query.toLowerCase()
  const results: SearchResult[] = []

  for (const entry of filtered) {
    const result = scoreEntry(entry, q)
    if (result) results.push(result)
  }

  results.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    // Tie-break: most recently focused first
    const aTime = a.entry.data.lastFocusedAt ?? ''
    const bTime = b.entry.data.lastFocusedAt ?? ''
    if (aTime !== bTime) return aTime > bTime ? -1 : 1
    return 0
  })
  return results
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
