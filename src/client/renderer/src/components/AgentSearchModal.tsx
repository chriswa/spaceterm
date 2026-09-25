import { useEffect, useMemo, useRef } from 'react'
import { useNodeStore } from '../stores/nodeStore'
import { useAgentSearchStore, type AgentSearchSuccess } from '../stores/agentSearchStore'
import { nodeDisplayTitle } from '../lib/node-title'
import { buildSearchableEntries, relativeTime, type SearchEntry } from '../lib/search'
import type { ColorPreset } from '../lib/color-presets'
import type { NodeId } from '../../../../shared/ids'

/** Hits below this probability are not worth a row. */
const MIN_SHOWN_PROBABILITY = 0.01

interface AgentSearchModalProps {
  visible: boolean
  resolvedPresets: Record<string, ColorPreset>
  onDismiss: () => void
  onNavigateToNode: (nodeId: NodeId) => void
  onReviveNode: (archiveParentId: NodeId, path: NodeId[], focusNodeId: NodeId) => void
}

export function formatCost(costUsd: number | null): string {
  return costUsd === null ? 'cost unknown' : `$${costUsd.toFixed(6)}`
}

function passSummary(result: AgentSearchSuccess): string {
  return result.pass === 'titles'
    ? 'Titles only · 1 Jev request'
    : 'Titles, then transcripts · 2 Jev requests'
}

/**
 * Cmd+F with no terminal focused: ask Jev which agent surface a query is about.
 *
 * A search only fires on Enter or the Search button, since each one costs
 * money. When it stopped at titles, a button re-asks with transcripts. The last search and its results persist (see agentSearchStore), and
 * each hit is looked up in the current canvas when drawn, so a surface
 * archived or restored since the search shows as it is now.
 */
export function AgentSearchModal({ visible, resolvedPresets, onDismiss, onNavigateToNode, onReviveNode }: AgentSearchModalProps) {
  const query = useAgentSearchStore(s => s.query)
  const setQuery = useAgentSearchStore(s => s.setQuery)
  const status = useAgentSearchStore(s => s.status)
  const search = useAgentSearchStore(s => s.search)
  const searchTranscripts = useAgentSearchStore(s => s.searchTranscripts)
  const inputRef = useRef<HTMLInputElement>(null)

  const nodes = useNodeStore(s => s.nodes)
  const rootArchivedChildren = useNodeStore(s => s.rootArchivedChildren)
  const entriesById = useMemo(() => {
    if (!visible) return new Map<NodeId, SearchEntry>()
    const map = new Map<NodeId, SearchEntry>()
    for (const entry of buildSearchableEntries(nodes, rootArchivedChildren, resolvedPresets, { kind: 'global' }, Infinity)) {
      // A live card wins over a stale archived copy of the same id.
      if (!map.has(entry.data.id) || entry.isActive) map.set(entry.data.id, entry)
    }
    return map
  }, [visible, nodes, rootArchivedChildren, resolvedPresets])

  useEffect(() => {
    if (visible) requestAnimationFrame(() => { inputRef.current?.focus(); inputRef.current?.select() })
  }, [visible])

  if (!visible) return null

  const open = (entry: SearchEntry) => {
    if (entry.isActive) onNavigateToNode(entry.data.id)
    else if (entry.archiveParentId && entry.restorePath) onReviveNode(entry.archiveParentId, entry.restorePath, entry.data.id)
  }

  const result = status.kind === 'done' ? status.result : null
  const hits = result?.hits.filter(h => h.probability >= MIN_SHOWN_PROBABILITY) ?? []

  return (
    <div
      className="search-modal agent-search"
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onDismiss() }
      }}
    >
      <div className="search-modal__header">
        <input
          ref={inputRef}
          className="search-modal__input"
          type="text"
          placeholder="Which agent session are you looking for?"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void search() } }}
        />
        <button
          className="search-modal__filter-btn search-modal__filter-btn--active"
          disabled={status.kind === 'searching' || !query.trim()}
          onClick={() => void search()}
        >
          Search
        </button>
      </div>

      <div className="agent-search__summary" data-testid="agent-search-summary">
        {status.kind === 'searching' && (
          <span>{status.mode === 'auto' ? `Asking Jev… · ${formatCost(0)}` : 'Asking Jev again with transcripts…'}</span>
        )}
        {status.kind === 'error' && <span className="agent-search__error">Search failed: {status.error}</span>}
        {result && (
          <>
            <span className={`agent-search__pass agent-search__pass--${result.pass}`}>{passSummary(result)}</span>
            <span>{formatCost(result.costUsd)}</span>
            <span>No match: {Math.round(result.noneProbability * 100)}%</span>
            {result.pass === 'titles' && (
              <button className="agent-search__rerun" onClick={() => void searchTranscripts()}>
                Search transcripts too
              </button>
            )}
          </>
        )}
      </div>

      {result && hits.length > 0 ? (
        <div className="search-modal__results">
          {hits.map(hit => {
            const entry = entriesById.get(hit.nodeId)
            const percent = `${Math.round(hit.probability * 100)}%`
            if (!entry) {
              return (
                <div key={hit.nodeId} className="search-modal__card search-modal__card--archived agent-search__card">
                  <div className="agent-search__percent">{percent}</div>
                  <div className="search-modal__card-content">
                    <div className="search-modal__card-title">No longer on the canvas</div>
                    <div className="search-modal__card-status">{hit.nodeId.slice(0, 8)}</div>
                  </div>
                </div>
              )
            }
            const archived = !entry.isActive
            const cwd = entry.data.type === 'terminal' ? entry.data.cwd : undefined
            return (
              <div
                key={hit.nodeId}
                className={`search-modal__card search-modal__card--clickable agent-search__card${archived ? ' search-modal__card--archived' : ''}`}
                onClick={() => open(entry)}
              >
                <div className="agent-search__percent">{percent}</div>
                <div className="search-modal__card-content">
                  <div className="search-modal__card-title-row">
                    {archived && <span className="agent-search__archived-badge">Archived</span>}
                    <div className="search-modal__card-title">{nodeDisplayTitle(entry.data)}</div>
                    <span className="search-modal__card-status">
                      {archived
                        ? entry.archivedAt ? `Archived ${relativeTime(entry.archivedAt)}` : 'Archived'
                        : entry.data.lastFocusedAt ? relativeTime(entry.data.lastFocusedAt) : ''}
                    </span>
                  </div>
                  <div className="search-modal__card-meta">
                    {cwd && <span>{cwd}</span>}
                    {archived && <span>Click to restore{(entry.restoreCount ?? 1) > 1 ? ` (${entry.restoreCount} cards)` : ''}</span>}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      ) : (
        <div className="search-modal__empty">
          {status.kind === 'searching' ? 'Searching…'
            : result ? 'No agent session matched'
            : 'Type what you remember about the session, then press Enter'}
        </div>
      )}
    </div>
  )
}
