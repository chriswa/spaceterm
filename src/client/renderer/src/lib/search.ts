import type { NodeData, ArchivedNode, ArchivedDescendant } from '../../../../shared/state'
import type { ColorPreset } from './color-presets'
import { COLOR_PRESET_MAP, DEFAULT_PRESET } from './color-presets'
import { groupNodes, groupSize, archivesOwnedBy } from '../../../../shared/archive-tree'
import { ROOT_NODE_ID, type NodeId } from '../../../../shared/ids'

// --- Types ---

export type NodeTypeFilter = 'terminal' | 'markdown' | 'directory'

export type SearchMode =
  | { kind: 'global' }
  | { kind: 'archived-children'; parentId: string }

export interface AncestorEntry {
  data: NodeData
  isLive: boolean
  /**
   * The archive entry whose group this ancestor belongs to, when it is a card
   * that was swept up in a subtree archive. Breadcrumbs use it to box a run of
   * ancestors that came down together.
   */
  groupRootId?: NodeId
}

export interface SearchEntry {
  data: NodeData
  isActive: boolean
  archivedAt?: string
  archiveParentId?: NodeId
  depth: number
  resolvedPreset: ColorPreset
  ancestors: AncestorEntry[]
  /**
   * How to restore this result, for archived entries.
   *
   * A subtree is archived and restored as a unit, so a result that is a member
   * of one restores through the entry that holds it: `restorePath` names that
   * entry and `restoreCount` says how many cards come back with it. For a card
   * archived on its own the path is its own and the count is 1.
   */
  restorePath?: NodeId[]
  restoreCount?: number
  /** True when this result is a group member rather than an entry in its own right. */
  isGroupMember?: boolean
}

export type MatchField = 'name' | 'cwd' | 'shellTitle' | 'markdown' | 'claudeSessionId'

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
  const allNodeLookup = new Map<string, LookupEntry>()
  for (const data of Object.values(nodes)) {
    allNodeLookup.set(data.id, { data, isLive: true })
  }
  function indexArchived(archives: ArchivedNode[]): void {
    for (const a of archives) {
      // A subtree archived as a unit contributes every card it holds, so a
      // surface buried in one is still findable and still has an ancestor
      // chain. Members are tagged with the entry that would restore them.
      const groupRootId = groupSize(a) > 1 ? a.data.id : undefined
      for (const data of groupNodes(a)) {
        if (!allNodeLookup.has(data.id)) {
          allNodeLookup.set(data.id, { data, isLive: false, groupRootId })
        }
      }
      indexArchived(archivesOwnedBy(a))
    }
  }
  for (const data of Object.values(nodes)) indexArchived(data.archivedChildren)
  indexArchived(rootArchivedChildren)

  if (mode.kind === 'archived-children') {
    const parentPreset = resolvedPresets[mode.parentId] ?? DEFAULT_PRESET
    if (mode.parentId === 'root') {
      collectArchived(entries, rootArchivedChildren, ROOT_NODE_ID, 0, parentPreset, archiveMaxDepth, [])
    } else {
      const node = nodes[mode.parentId]
      if (node) {
        collectArchived(entries, node.archivedChildren, node.id, 0, parentPreset, archiveMaxDepth, [])
      }
    }
  } else {
    // Global mode: live nodes + all archives
    for (const data of Object.values(nodes)) {
      entries.push({ data, isActive: true, depth: 0, resolvedPreset: resolvedPresets[data.id] ?? DEFAULT_PRESET, ancestors: [] })
    }
    for (const data of Object.values(nodes)) {
      const parentPreset = resolvedPresets[data.id] ?? DEFAULT_PRESET
      collectArchived(entries, data.archivedChildren, data.id, 0, parentPreset, Infinity, [])
    }
    collectArchived(entries, rootArchivedChildren, ROOT_NODE_ID, 0, resolvedPresets['root'] ?? DEFAULT_PRESET, Infinity, [])
  }

  // Compute ancestor chains for all entries
  for (const entry of entries) {
    entry.ancestors = buildAncestorChain(entry.data.parentId, allNodeLookup)
  }

  return entries
}

function presetFor(data: NodeData, inherited: ColorPreset): ColorPreset {
  const ownId = data.colorPresetId
  return (ownId && ownId !== 'inherit' && COLOR_PRESET_MAP[ownId]) ? COLOR_PRESET_MAP[ownId]! : inherited
}

/**
 * What one archive entry contributes to search: the entry itself, the cards
 * that would come back with it, and — one hop deeper — the entries its group
 * owns, which restore separately.
 *
 * `pathPrefix` is what makes a nested result actionable. An entry buried inside
 * an archived subtree is named by the chain of entries above it, not by its own
 * id alone, and a result carrying only the id was silently unrestorable.
 */
function collectArchived(
  entries: SearchEntry[],
  archives: ArchivedNode[],
  archiveParentId: NodeId,
  depth: number,
  inheritedPreset: ColorPreset,
  maxDepth: number,
  pathPrefix: NodeId[]
): void {
  for (const archived of archives) {
    const resolvedPreset = presetFor(archived.data, inheritedPreset)
    const path = [...pathPrefix, archived.data.id]
    const restoreCount = groupSize(archived)

    entries.push({
      data: archived.data,
      isActive: false,
      archivedAt: archived.archivedAt,
      archiveParentId,
      depth,
      resolvedPreset,
      ancestors: [], // filled in by buildSearchableEntries post-loop
      restorePath: path,
      restoreCount,
    })
    if (depth >= maxDepth) continue

    collectGroupMembers(
      entries, archived.descendants ?? [], depth + 1, resolvedPreset,
      { archiveParentId, archivedAt: archived.archivedAt, path, restoreCount, maxDepth }
    )
    collectArchived(entries, archived.data.archivedChildren, archiveParentId, depth + 1, resolvedPreset, maxDepth, path)
  }
}

/** What a restore of `ctx.path` would do, shared by every member of that group. */
interface GroupContext {
  archiveParentId: NodeId
  archivedAt: string
  path: NodeId[]
  restoreCount: number
  maxDepth: number
}

/**
 * The cards inside an archived subtree. Each is findable in its own right but
 * restores through the entry that holds it, so they all carry that entry's
 * path and count.
 */
function collectGroupMembers(
  entries: SearchEntry[],
  members: ArchivedDescendant[],
  depth: number,
  inheritedPreset: ColorPreset,
  ctx: GroupContext
): void {
  for (const member of members) {
    const resolvedPreset = presetFor(member.data, inheritedPreset)
    entries.push({
      data: member.data,
      isActive: false,
      archivedAt: ctx.archivedAt,
      archiveParentId: ctx.archiveParentId,
      depth,
      resolvedPreset,
      ancestors: [],
      restorePath: ctx.path,
      restoreCount: ctx.restoreCount,
      isGroupMember: true,
    })
    if (depth >= ctx.maxDepth) continue
    collectGroupMembers(entries, member.descendants, depth + 1, resolvedPreset, ctx)
    // A member can hold archives of its own, and those restore on their own.
    collectArchived(entries, member.data.archivedChildren, ctx.archiveParentId, depth + 1, resolvedPreset, ctx.maxDepth, ctx.path)
  }
}

/** A node the ancestor walk can reach: live, archived, or a member of an archived subtree. */
interface LookupEntry {
  data: NodeData
  isLive: boolean
  groupRootId?: NodeId
}

function buildAncestorChain(
  startParentId: string,
  lookup: Map<string, LookupEntry>
): AncestorEntry[] {
  const chain: AncestorEntry[] = []
  let currentId = startParentId
  const visited = new Set<string>()
  while (currentId && currentId !== 'root' && !visited.has(currentId)) {
    visited.add(currentId)
    const entry = lookup.get(currentId)
    if (!entry) break
    chain.push({ data: entry.data, isLive: entry.isLive, groupRootId: entry.groupRootId })
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

  // Claude session ID match: score 1100
  if (data.type === 'terminal') {
    for (const entry of data.claudeSessionHistory) {
      if (entry.claudeSessionId.toLowerCase().includes(q)) {
        if (1100 > bestScore) {
          bestScore = 1100
          bestField = 'claudeSessionId'
        }
        break
      }
    }
    if (bestScore < 1100) {
      for (const session of data.terminalSessions) {
        if (session.claudeSessionId && session.claudeSessionId.toLowerCase().includes(q)) {
          bestScore = 1100
          bestField = 'claudeSessionId'
          break
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
