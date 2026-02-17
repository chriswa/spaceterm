import { useCallback, useEffect, useMemo, useRef } from 'react'
import { useState } from 'react'
import { useNodeStore } from '../stores/nodeStore'
import { nodeDisplayTitle } from '../lib/node-title'
import { buildSearchableEntries, searchEntries, relativeTime, typeLabel } from '../lib/search'
import type { SearchEntry, SearchResult } from '../lib/search'
import { createWheelAccumulator, classifyWheelEvent } from '../lib/wheel-gesture'

interface SearchModalProps {
  visible: boolean
  onDismiss: () => void
  onNavigateToNode: (nodeId: string) => void
  onReviveNode: (archiveParentId: string, archivedNodeId: string) => void
}

function countNestedArchives(data: SearchEntry['data']): number {
  let total = data.archivedChildren.length
  for (const child of data.archivedChildren) {
    total += countNestedArchives(child.data)
  }
  return total
}

function tooltipJson(data: SearchEntry['data']): string {
  const { archivedChildren: _, ...rest } = data
  return JSON.stringify(rest, null, 2)
}

const searchWheelAcc = createWheelAccumulator()

export function SearchModal({ visible, onDismiss, onNavigateToNode, onReviveNode }: SearchModalProps) {
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const resultsRef = useRef<HTMLDivElement>(null)

  const nodes = useNodeStore(s => s.nodes)
  const rootArchivedChildren = useNodeStore(s => s.rootArchivedChildren)

  const entries = useMemo(
    () => buildSearchableEntries(nodes, rootArchivedChildren),
    [nodes, rootArchivedChildren]
  )

  const { results, totalMatches } = useMemo(
    () => searchEntries(entries, query),
    [entries, query]
  )

  // Auto-focus input when modal becomes visible
  useEffect(() => {
    if (visible) {
      // Use rAF to ensure the DOM is ready
      requestAnimationFrame(() => {
        inputRef.current?.focus()
        inputRef.current?.select()
      })
    }
  }, [visible])

  // Wheel gesture on results area
  useEffect(() => {
    if (!visible) return
    const el = resultsRef.current
    if (!el) return

    const handleWheel = (e: WheelEvent) => {
      const gesture = classifyWheelEvent(searchWheelAcc, e)
      if (gesture === 'vertical') return // let native scroll handle it
      // horizontal or pinch → dismiss
      e.preventDefault()
      onDismiss()
    }

    el.addEventListener('wheel', handleWheel, { passive: false })
    return () => el.removeEventListener('wheel', handleWheel)
  }, [visible, onDismiss])

  const handleCardClick = useCallback((r: SearchResult) => {
    // Session-label results are dimmed and non-actionable
    if (r.sessionLabel) return

    if (r.entry.isActive) {
      onNavigateToNode(r.entry.data.id)
    } else if (r.entry.archiveParentId) {
      onReviveNode(r.entry.archiveParentId, r.entry.data.id)
    }
  }, [onNavigateToNode, onReviveNode])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onDismiss()
    }
  }, [onDismiss])

  if (!visible) return null

  const omitted = totalMatches - results.length

  return (
    <div className="search-modal" onKeyDown={handleKeyDown} onMouseDown={(e) => e.stopPropagation()}>
      <div className="search-modal__header">
        <input
          ref={inputRef}
          className="search-modal__input"
          type="text"
          placeholder="Search nodes..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="search-modal__filters">
          <button className="search-modal__filter-btn" disabled>Terminals</button>
          <button className="search-modal__filter-btn" disabled>Markdown</button>
          <button className="search-modal__filter-btn" disabled>Directories</button>
        </div>
      </div>

      {results.length > 0 ? (
        <div className="search-modal__results" ref={resultsRef}>
          {results.map((r) => {
            const nestedCount = countNestedArchives(r.entry.data)
            const cardClass = r.sessionLabel
              ? 'search-modal__card search-modal__card--session'
              : r.entry.isActive
                ? 'search-modal__card search-modal__card--active'
                : 'search-modal__card search-modal__card--archived'
            return (
              <div
                key={`${r.entry.data.id}-${r.entry.isActive ? 'live' : 'arch'}${r.sessionLabel ? `-s${r.sessionLabel}` : ''}`}
                className={cardClass}
                title={tooltipJson(r.entry.data)}
                onClick={() => handleCardClick(r)}
              >
                <div className="search-modal__card-header">
                  <span className="search-modal__card-type">{typeLabel(r.entry.data)}</span>
                  {r.sessionLabel && (
                    <span className="search-modal__card-session">{r.sessionLabel}</span>
                  )}
                  <span className="search-modal__card-status">
                    {r.entry.isActive ? 'Active' : r.entry.archivedAt ? relativeTime(r.entry.archivedAt) : 'Archived'}
                  </span>
                </div>
                <div className="search-modal__card-title">{nodeDisplayTitle(r.entry.data)}</div>
                {nestedCount > 0 && (
                  <div className="search-modal__card-meta">
                    {nestedCount} archived
                  </div>
                )}
              </div>
            )
          })}
          {omitted > 0 && (
            <div className="search-modal__overflow">
              {results.length} shown, {omitted} omitted
            </div>
          )}
        </div>
      ) : query.trim() ? (
        <div className="search-modal__empty">No results found</div>
      ) : (
        <div className="search-modal__empty">No nodes</div>
      )}
    </div>
  )
}
