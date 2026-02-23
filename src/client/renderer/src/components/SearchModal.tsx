import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNodeStore } from '../stores/nodeStore'
import { nodeDisplayTitle } from '../lib/node-title'
import { buildSearchableEntries, searchEntries, relativeTime } from '../lib/search'
import type { SearchEntry, SearchResult, SearchMode, NodeTypeFilter } from '../lib/search'
import type { ColorPreset } from '../lib/color-presets'
import type { NodeData } from '../../../../shared/state'
import { createWheelAccumulator, classifyWheelEvent } from '../lib/wheel-gesture'

function typeIcon(data: NodeData, size = 26): JSX.Element {
  const props = { width: size, height: size, viewBox: '0 0 14 14', fill: 'none', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }
  if (data.type === 'terminal' && data.terminalSessions[0]?.claudeSessionId) {
    return <svg {...props}><path d="M4 10 L7 4 L10 10" /><line x1="5" y1="8" x2="9" y2="8" /></svg>
  }
  if (data.type === 'terminal') {
    return <svg {...props}><path d="M3 4 L6 7 L3 10" /><line x1="7" y1="10" x2="11" y2="10" /></svg>
  }
  if (data.type === 'markdown') {
    return <svg {...props}><rect x="1" y="3" width="12" height="8" rx="1" /><path d="M3 9 L3 5 L5 7 L7 5 L7 9" /><path d="M9 7 L11 5 L11 9" /></svg>
  }
  if (data.type === 'directory') {
    return <svg {...props}><path d="M1 4 V11 Q1 12 2 12 H12 Q13 12 13 11 V5 Q13 4 12 4 H7 L5.5 2 H2 Q1 2 1 3 Z" /></svg>
  }
  if (data.type === 'file') {
    return <svg {...props}><path d="M3 1 H9 L11 3 V13 H3 Z" /><path d="M9 1 V3 H11" /></svg>
  }
  // title or unknown
  return <svg {...props}><line x1="3" y1="3" x2="11" y2="3" /><line x1="7" y1="3" x2="7" y2="11" /></svg>
}

const rootIcon = (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="7" cy="7" r="4" />
  </svg>
)

interface SearchModalProps {
  visible: boolean
  mode: SearchMode
  resolvedPresets: Record<string, ColorPreset>
  onDismiss: () => void
  onNavigateToNode: (nodeId: string) => void
  onReviveNode: (archiveParentId: string, archivedNodeId: string) => void
  onArchiveDelete?: (parentNodeId: string, archivedNodeId: string) => void
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

const FILTER_LABELS: { key: NodeTypeFilter; label: string }[] = [
  { key: 'terminal', label: 'Terminals' },
  { key: 'markdown', label: 'Markdown' },
  { key: 'directory', label: 'Directories' },
]

// Virtual scroll constants
const ROW_HEIGHT = 68 // estimated px per card (64px card + 4px margin)
const OVERSCAN = 10   // extra rows rendered above/below viewport

const searchWheelAcc = createWheelAccumulator()

export function SearchModal({ visible, mode, resolvedPresets, onDismiss, onNavigateToNode, onReviveNode, onArchiveDelete }: SearchModalProps) {
  const [query, setQuery] = useState('')
  const [activeFilters, setActiveFilters] = useState<Set<NodeTypeFilter>>(new Set())
  const [deepSearch, setDeepSearch] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const resultsRef = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(0)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const suppressMouseRef = useRef(false)

  const nodes = useNodeStore(s => s.nodes)
  const rootArchivedChildren = useNodeStore(s => s.rootArchivedChildren)

  // Reset query, filters, and scroll when modal opens or mode changes
  useEffect(() => {
    if (visible) {
      setQuery('')
      setActiveFilters(new Set())
      setDeepSearch(false)
      setScrollTop(0)
      setSelectedIndex(0)
      if (resultsRef.current) resultsRef.current.scrollTop = 0
    }
  }, [visible, mode])

  const entries = useMemo(
    () => buildSearchableEntries(
      nodes, rootArchivedChildren, resolvedPresets, mode,
      mode.kind === 'archived-children' ? (deepSearch ? Infinity : 0) : Infinity
    ),
    [nodes, rootArchivedChildren, resolvedPresets, mode, deepSearch]
  )

  const results = useMemo(
    () => searchEntries(entries, query, activeFilters.size > 0 ? activeFilters : undefined),
    [entries, query, activeFilters]
  )

  // Track viewport height via ResizeObserver
  useEffect(() => {
    if (!visible) return
    const el = resultsRef.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => {
      setViewportHeight(entry.contentRect.height)
    })
    ro.observe(el)
    // Capture initial height
    setViewportHeight(el.clientHeight)
    return () => ro.disconnect()
  }, [visible])

  // Auto-focus input when modal becomes visible
  useEffect(() => {
    if (visible) {
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
      if (gesture === 'vertical') return
      e.preventDefault()
      onDismiss()
    }

    el.addEventListener('wheel', handleWheel, { passive: false })
    return () => el.removeEventListener('wheel', handleWheel)
  }, [visible, onDismiss])

  const handleScroll = useCallback(() => {
    if (resultsRef.current) {
      setScrollTop(resultsRef.current.scrollTop)
    }
  }, [])

  const handleCardClick = useCallback((r: SearchResult) => {
    if (r.sessionLabel) return
    if (r.entry.isActive) {
      onNavigateToNode(r.entry.data.id)
    } else if (r.entry.archiveParentId) {
      onReviveNode(r.entry.archiveParentId, r.entry.data.id)
    }
  }, [onNavigateToNode, onReviveNode])

  const handleDeleteClick = useCallback((e: React.MouseEvent, r: SearchResult) => {
    e.stopPropagation()
    if (r.entry.archiveParentId && onArchiveDelete) {
      onArchiveDelete(r.entry.archiveParentId, r.entry.data.id)
    }
  }, [onArchiveDelete])

  const toggleFilter = useCallback((filter: NodeTypeFilter) => {
    setActiveFilters(prev => {
      const next = new Set(prev)
      if (next.has(filter)) {
        next.delete(filter)
      } else {
        next.add(filter)
      }
      return next
    })
    // Reset scroll and selection when filters change
    setSelectedIndex(0)
    setScrollTop(0)
    if (resultsRef.current) resultsRef.current.scrollTop = 0
  }, [])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onDismiss()
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      suppressMouseRef.current = true
      setSelectedIndex(i => Math.min(i + 1, results.length - 1))
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      suppressMouseRef.current = true
      setSelectedIndex(i => Math.max(i - 1, 0))
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      const r = results[selectedIndex]
      if (r) handleCardClick(r)
      return
    }
  }, [onDismiss, results, selectedIndex, handleCardClick])

  // Auto-scroll to keep selected item centered (keyboard only)
  useEffect(() => {
    if (!visible || !resultsRef.current || !suppressMouseRef.current) return
    const container = resultsRef.current
    const targetTop = selectedIndex * ROW_HEIGHT - container.clientHeight / 2 + ROW_HEIGHT / 2
    container.scrollTop = Math.max(0, Math.min(targetTop, container.scrollHeight - container.clientHeight))
  }, [selectedIndex, visible])

  if (!visible) return null

  const isArchivedMode = mode.kind === 'archived-children'
  const totalCount = results.length

  // Virtual scroll window calculation
  const totalHeight = totalCount * ROW_HEIGHT
  const startIdx = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN)
  const endIdx = Math.min(totalCount, Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + OVERSCAN)
  const visibleResults = results.slice(startIdx, endIdx)
  const offsetY = startIdx * ROW_HEIGHT

  return (
    <div className="search-modal" onKeyDown={handleKeyDown} onMouseDown={(e) => e.stopPropagation()}>
      <div className="search-modal__header">
        <input
          ref={inputRef}
          className="search-modal__input"
          type="text"
          placeholder={isArchivedMode ? 'Search archived children...' : 'Search nodes...'}
          value={query}
          onChange={(e) => { setQuery(e.target.value); setSelectedIndex(0); suppressMouseRef.current = true; setScrollTop(0); if (resultsRef.current) resultsRef.current.scrollTop = 0 }}
        />
        <div className="search-modal__filters">
          {FILTER_LABELS.map(({ key, label }) => (
            <button
              key={key}
              className={`search-modal__filter-btn${activeFilters.has(key) ? ' search-modal__filter-btn--active' : ''}`}
              onClick={() => toggleFilter(key)}
            >
              {label}
            </button>
          ))}
          {isArchivedMode && (
            <button
              className={`search-modal__filter-btn${deepSearch ? ' search-modal__filter-btn--active' : ''}`}
              onClick={() => { setDeepSearch(d => !d); setSelectedIndex(0); setScrollTop(0); if (resultsRef.current) resultsRef.current.scrollTop = 0 }}
            >
              Deep
            </button>
          )}
        </div>
      </div>

      {totalCount > 0 ? (
        <div className="search-modal__results" ref={resultsRef} onScroll={handleScroll} onMouseMove={() => { suppressMouseRef.current = false }}>
          <div style={{ height: totalHeight, position: 'relative' }}>
            <div style={{ position: 'absolute', top: offsetY, left: 0, right: 0 }}>
              {visibleResults.map((r, localIndex) => {
                const globalIndex = startIdx + localIndex
                const nestedCount = countNestedArchives(r.entry.data)
                const isActive = r.entry.isActive
                const isSession = !!r.sessionLabel
                const iconColor = isActive ? r.entry.resolvedPreset.titleBarBg : '#585b70'

                return (
                  <div
                    key={`${r.entry.data.id}-${isActive ? 'live' : 'arch'}${r.sessionLabel ? `-s${r.sessionLabel}` : ''}`}
                    className={`search-modal__card${isSession ? '' : ' search-modal__card--clickable'}${!isActive ? ' search-modal__card--archived' : ''}${globalIndex === selectedIndex ? ' search-modal__card--selected' : ''}`}
                    style={isSession ? { opacity: 0.4 } : undefined}
                    data-tooltip={tooltipJson(r.entry.data)}
                    onMouseEnter={() => { if (!suppressMouseRef.current) setSelectedIndex(globalIndex) }}
                    onClick={() => handleCardClick(r)}
                  >
                    <div className="search-modal__card-icon" style={{ color: iconColor }}>
                      {typeIcon(r.entry.data)}
                    </div>
                    <div className="search-modal__card-content">
                      <div className="search-modal__card-breadcrumbs">
                        {r.entry.ancestors.length > 0 && (
                          <>
                            <span className="search-modal__breadcrumb-icon search-modal__breadcrumb-icon--root" data-tooltip="Root">
                              {rootIcon}
                            </span>
                            <span className="search-modal__breadcrumb-chevron">&rsaquo;</span>
                            {r.entry.ancestors.map((ancestor) => (
                              <span key={ancestor.data.id} className="search-modal__breadcrumb-item">
                                <span
                                  className={`search-modal__breadcrumb-icon${!ancestor.isLive ? ' search-modal__breadcrumb-icon--archived' : ''}`}
                                  data-tooltip={nodeDisplayTitle(ancestor.data) + (!ancestor.isLive ? ' (Archived)' : '')}
                                  onClick={(e) => { e.stopPropagation(); if (ancestor.isLive) onNavigateToNode(ancestor.data.id) }}
                                >
                                  {typeIcon(ancestor.data, 14)}
                                </span>
                                <span className="search-modal__breadcrumb-chevron">&rsaquo;</span>
                              </span>
                            ))}
                          </>
                        )}
                      </div>
                      <div className="search-modal__card-title-row">
                        <div className="search-modal__card-title">{nodeDisplayTitle(r.entry.data)}</div>
                        {r.sessionLabel && (
                          <span className="search-modal__card-session">{r.sessionLabel}</span>
                        )}
                        <span className="search-modal__card-status">
                          {isActive
                            ? r.entry.data.lastFocusedAt ? relativeTime(r.entry.data.lastFocusedAt) : ''
                            : r.entry.archivedAt ? `Archived ${relativeTime(r.entry.archivedAt)}` : 'Archived'}
                        </span>
                        {isArchivedMode && !isActive && onArchiveDelete && (
                          <button
                            className="search-modal__card-delete"
                            data-tooltip="Delete permanently"
                            onClick={(e) => handleDeleteClick(e, r)}
                          >
                            &times;
                          </button>
                        )}
                      </div>
                      {nestedCount > 0 && (
                        <div className="search-modal__card-meta">
                          {nestedCount} archived
                        </div>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      ) : query.trim() ? (
        <div className="search-modal__empty">No results found</div>
      ) : (
        <div className="search-modal__empty">{isArchivedMode ? 'No archived children' : 'No nodes'}</div>
      )}
    </div>
  )
}
