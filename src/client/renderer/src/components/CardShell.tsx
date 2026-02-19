import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactNode, RefObject } from 'react'
import { COLOR_PRESETS } from '../lib/color-presets'
import type { ColorPreset } from '../lib/color-presets'
import type { ArchivedNode, TerminalSessionEntry } from '../../../../shared/state'
import { ArchiveBody } from './ArchiveBody'
import { SessionsBody } from './SessionsBody'
import { AddNodeBody } from './AddNodeBody'
import type { AddNodeType } from './AddNodeBody'
import { ARCHIVE_BODY_MIN_WIDTH } from '../lib/constants'
import foodIcon from '../assets/food.svg'

interface CardShellProps {
  nodeId: string
  x: number
  y: number
  width: number
  height: number
  zIndex: number
  focused: boolean
  headVariant: 'visible' | 'overlay' | 'hidden'
  titleContent?: ReactNode
  headStyle?: CSSProperties
  preset?: ColorPreset
  showClose?: boolean
  showColorPicker?: boolean
  archivedChildren: ArchivedNode[]
  onClose: (id: string) => void
  onColorChange: (id: string, color: string) => void
  onUnarchive: (parentNodeId: string, archivedNodeId: string) => void
  onArchiveDelete: (parentNodeId: string, archivedNodeId: string) => void
  onArchiveToggled: (nodeId: string, open: boolean) => void
  pastSessions?: TerminalSessionEntry[]
  currentSessionIndex?: number
  onSessionsToggled?: (nodeId: string, open: boolean) => void
  onSessionRevive?: (nodeId: string, session: TerminalSessionEntry) => void
  onMouseDown?: (e: React.MouseEvent) => void
  onStartReparent?: (id: string) => void
  onShipIt?: (id: string) => void
  onFork?: (id: string) => void
  onDiffPlans?: () => void
  isReparenting?: boolean
  onAddNode?: (parentNodeId: string, type: AddNodeType) => void
  className?: string
  style?: CSSProperties
  cardRef?: RefObject<HTMLDivElement | null>
  onMouseEnter?: (e: React.MouseEvent) => void
  onMouseLeave?: (e: React.MouseEvent) => void
  behindContent?: ReactNode
  children: ReactNode
}

export function CardShell({
  nodeId, x, y, width, height, zIndex, focused,
  headVariant, titleContent, headStyle, preset,
  showClose = true, showColorPicker = true,
  archivedChildren, onClose, onColorChange, onUnarchive, onArchiveDelete, onArchiveToggled,
  pastSessions, currentSessionIndex, onSessionsToggled, onSessionRevive,
  onMouseDown, onStartReparent, onShipIt, onFork, onDiffPlans, isReparenting,
  onAddNode,
  className, style, cardRef, onMouseEnter, onMouseLeave, behindContent, children
}: CardShellProps) {
  const [archiveOpen, setArchiveOpen] = useState(false)
  const [sessionsOpen, setSessionsOpen] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const pickerRef = useRef<HTMLDivElement>(null)
  const archiveBtnRef = useRef<HTMLButtonElement>(null)
  const archiveBodyRef = useRef<HTMLDivElement>(null)
  const sessionsBtnRef = useRef<HTMLButtonElement>(null)
  const sessionsBodyRef = useRef<HTMLDivElement>(null)
  const [addNodeOpen, setAddNodeOpen] = useState(false)
  const addNodeBtnRef = useRef<HTMLButtonElement>(null)
  const addNodeBodyRef = useRef<HTMLDivElement>(null)

  // Close archive when archives become empty
  useEffect(() => {
    if (archivedChildren.length === 0 && archiveOpen) {
      setArchiveOpen(false)
      onArchiveToggled(nodeId, false)
    }
  }, [archivedChildren.length, archiveOpen, nodeId, onArchiveToggled])

  // Close sessions panel when past sessions become empty
  useEffect(() => {
    if (pastSessions && pastSessions.length === 0 && sessionsOpen) {
      setSessionsOpen(false)
      onSessionsToggled?.(nodeId, false)
    }
  }, [pastSessions, sessionsOpen, nodeId, onSessionsToggled])

  // Close archive when node loses focus
  useEffect(() => {
    if (!focused && archiveOpen) {
      setArchiveOpen(false)
    }
  }, [focused, archiveOpen])

  // Close sessions panel when node loses focus
  useEffect(() => {
    if (!focused && sessionsOpen) {
      setSessionsOpen(false)
    }
  }, [focused, sessionsOpen])

  // Dismiss archive on outside click
  useEffect(() => {
    if (!archiveOpen) return
    const handler = (e: MouseEvent) => {
      const target = e.target as Node
      if (archiveBodyRef.current?.contains(target)) return
      if (archiveBtnRef.current?.contains(target)) return
      setArchiveOpen(false)
      onArchiveToggled(nodeId, false)
    }
    document.addEventListener('mousedown', handler, { capture: true })
    return () => document.removeEventListener('mousedown', handler, { capture: true })
  }, [archiveOpen, nodeId, onArchiveToggled])

  // Dismiss sessions panel on outside click
  useEffect(() => {
    if (!sessionsOpen) return
    const handler = (e: MouseEvent) => {
      const target = e.target as Node
      if (sessionsBodyRef.current?.contains(target)) return
      if (sessionsBtnRef.current?.contains(target)) return
      setSessionsOpen(false)
      onSessionsToggled?.(nodeId, false)
    }
    document.addEventListener('mousedown', handler, { capture: true })
    return () => document.removeEventListener('mousedown', handler, { capture: true })
  }, [sessionsOpen, nodeId, onSessionsToggled])

  // Close add-node dropdown when node loses focus
  useEffect(() => {
    if (!focused && addNodeOpen) {
      setAddNodeOpen(false)
    }
  }, [focused, addNodeOpen])

  // Dismiss add-node dropdown on outside click
  useEffect(() => {
    if (!addNodeOpen) return
    const handler = (e: MouseEvent) => {
      const target = e.target as Node
      if (addNodeBodyRef.current?.contains(target)) return
      if (addNodeBtnRef.current?.contains(target)) return
      setAddNodeOpen(false)
    }
    document.addEventListener('mousedown', handler, { capture: true })
    return () => document.removeEventListener('mousedown', handler, { capture: true })
  }, [addNodeOpen])

  // Close color picker on outside click
  useEffect(() => {
    if (!pickerOpen) return
    const handler = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setPickerOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [pickerOpen])

  const toggleArchive = useCallback(() => {
    setSessionsOpen(false)
    setAddNodeOpen(false)
    setArchiveOpen(prev => {
      const next = !prev
      onArchiveToggled(nodeId, next)
      return next
    })
  }, [nodeId, onArchiveToggled])

  const toggleSessions = useCallback(() => {
    setArchiveOpen(false)
    setAddNodeOpen(false)
    setSessionsOpen(prev => {
      const next = !prev
      onSessionsToggled?.(nodeId, next)
      return next
    })
  }, [nodeId, onSessionsToggled])

  const toggleAddNode = useCallback(() => {
    setArchiveOpen(false)
    setSessionsOpen(false)
    setAddNodeOpen(prev => !prev)
  }, [])

  const handleAddNodeSelect = useCallback((type: AddNodeType) => {
    setAddNodeOpen(false)
    onAddNode?.(nodeId, type)
  }, [nodeId, onAddNode])

  // Action buttons shared across head variants
  const actionButtons = (
    <div className="node-titlebar__actions">
      {onShipIt && (
        <button
          className="node-titlebar__shipit-btn"
          title="Ship it — paste into parent terminal"
          style={preset ? { color: preset.titleBarFg } : undefined}
          onClick={(e) => { e.stopPropagation(); onShipIt(nodeId) }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <img src={foodIcon} alt="Ship it" width={14} height={14} style={{ filter: 'invert(1)' }} />
        </button>
      )}
      {onFork && (
        <button
          className="node-titlebar__fork-btn"
          title="Fork session"
          style={preset ? { color: preset.titleBarFg } : undefined}
          onClick={(e) => { e.stopPropagation(); onFork(nodeId) }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
            <path d="M7 13 L7 6" />
            <path d="M3 1 L3 5 Q3 6 7 6 Q11 6 11 5 L11 1" />
            <path d="M7 1 L7 6" />
          </svg>
        </button>
      )}
      {onDiffPlans && (
        <button
          className="node-titlebar__diff-plans-btn"
          title="Diff plan versions"
          style={preset ? { color: preset.titleBarFg } : undefined}
          onClick={(e) => { e.stopPropagation(); onDiffPlans() }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="4" y1="2" x2="4" y2="12" />
            <line x1="10" y1="2" x2="10" y2="12" />
            <line x1="2" y1="5" x2="6" y2="5" />
            <line x1="8" y1="9" x2="12" y2="9" />
          </svg>
        </button>
      )}
      {showColorPicker && (
        <div style={{ position: 'relative' }} ref={pickerRef}>
          <button
            className="node-titlebar__color-btn"
            title="Node color"
            style={preset ? { color: preset.titleBarFg } : undefined}
            onClick={(e) => { e.stopPropagation(); setPickerOpen(prev => !prev) }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <svg width="16" height="16" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
              <g transform="rotate(-45 7 7)">
                <ellipse cx="7" cy="2.5" rx="3.2" ry="1.5" />
                <path d="M3.8 2.5 L3.8 10" />
                <path d="M10.2 2.5 L10.2 10" />
                <path d="M3.8 10 Q7 12.5 10.2 10" />
              </g>
              <path d="M1.3 5.4 L1.3 10.5" strokeWidth="1" />
            </svg>
          </button>
          {pickerOpen && (
            <div className="node-titlebar__color-picker" onMouseDown={(e) => e.stopPropagation()}>
              <button
                className="node-titlebar__color-swatch node-titlebar__color-swatch--inherit"
                title="Inherit from parent"
                onClick={(e) => { e.stopPropagation(); onColorChange(nodeId, 'inherit'); setPickerOpen(false) }}
              />
              {COLOR_PRESETS.map((p) => (
                <button
                  key={p.id}
                  className="node-titlebar__color-swatch"
                  style={{ backgroundColor: p.titleBarBg }}
                  onClick={(e) => { e.stopPropagation(); onColorChange(nodeId, p.id); setPickerOpen(false) }}
                />
              ))}
            </div>
          )}
        </div>
      )}
      {pastSessions !== undefined && (
        <button
          ref={sessionsBtnRef}
          className="node-titlebar__sessions-btn"
          title="Terminal sessions"
          disabled={pastSessions.length === 0}
          style={preset ? { color: preset.titleBarFg } : undefined}
          onClick={(e) => { e.stopPropagation(); toggleSessions() }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <svg width="18" height="18" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" style={{ position: 'absolute' }}>
            <path d="M2 1 L3 12 Q3 13 5 13 L9 13 Q11 13 11 12 L12 1" transform="rotate(-90 7 7)" />
          </svg>
          <span className="node-titlebar__archive-count" style={pastSessions.length >= 100 ? { fontSize: 7 } : pastSessions.length >= 10 ? { fontSize: 8 } : undefined}>{pastSessions.length}</span>
        </button>
      )}
      <button
        ref={archiveBtnRef}
        className="node-titlebar__archive-btn"
        title="Archived children"
        disabled={archivedChildren.length === 0}
        style={preset ? { color: preset.titleBarFg } : undefined}
        onClick={(e) => { e.stopPropagation(); toggleArchive() }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <svg width="18" height="18" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" style={{ position: 'absolute' }}>
          <path d="M2 1 L3 12 Q3 13 5 13 L9 13 Q11 13 11 12 L12 1" />
        </svg>
        <span className="node-titlebar__archive-count" style={archivedChildren.length >= 100 ? { fontSize: 7 } : archivedChildren.length >= 10 ? { fontSize: 8 } : undefined}>{archivedChildren.length}</span>
      </button>
      {onStartReparent && (
        <button
          className={`node-titlebar__reparent-btn${isReparenting ? ' node-titlebar__reparent-btn--active' : ''}`}
          title="Reparent node"
          style={preset ? { color: preset.titleBarFg } : undefined}
          onClick={(e) => { e.stopPropagation(); onStartReparent(nodeId) }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="7" y1="11" x2="7" y2="4" />
            <path d="M4 7 L7 4 L10 7" />
            <line x1="3" y1="2" x2="11" y2="2" />
          </svg>
        </button>
      )}
      {onAddNode && (
        <button
          ref={addNodeBtnRef}
          className="node-titlebar__add-btn"
          title="Add child node"
          style={preset ? { color: preset.titleBarFg } : undefined}
          onClick={(e) => { e.stopPropagation(); toggleAddNode() }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            <line x1="7" y1="2" x2="7" y2="12" />
            <line x1="2" y1="7" x2="12" y2="7" />
          </svg>
        </button>
      )}
      {showClose && (
        <button
          className="node-titlebar__close"
          style={preset ? { color: preset.titleBarFg } : undefined}
          onClick={(e) => { e.stopPropagation(); onClose(nodeId) }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            <line x1="3" y1="3" x2="11" y2="11" />
            <line x1="11" y1="3" x2="3" y2="11" />
          </svg>
        </button>
      )}
    </div>
  )

  const hiddenHeadActions = headVariant === 'hidden' ? (
    <div className="card-shell__hidden-head-actions">
      <button
        ref={archiveBtnRef}
        className="node-titlebar__archive-btn card-shell__archive-btn"
        title="Archived children"
        disabled={archivedChildren.length === 0}
        onClick={(e) => { e.stopPropagation(); toggleArchive() }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <svg width="18" height="18" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" style={{ position: 'absolute' }}>
          <path d="M2 1 L3 12 Q3 13 5 13 L9 13 Q11 13 11 12 L12 1" />
        </svg>
        <span className="node-titlebar__archive-count" style={archivedChildren.length >= 100 ? { fontSize: 7 } : archivedChildren.length >= 10 ? { fontSize: 8 } : undefined}>{archivedChildren.length}</span>
      </button>
      {onAddNode && (
        <button
          ref={addNodeBtnRef}
          className="node-titlebar__add-btn card-shell__add-btn"
          title="Add child node"
          onClick={(e) => { e.stopPropagation(); toggleAddNode() }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            <line x1="7" y1="2" x2="7" y2="12" />
            <line x1="2" y1="7" x2="12" y2="7" />
          </svg>
        </button>
      )}
    </div>
  ) : null

  return (
    <div
      className="card-shell canvas-node"
      data-node-id={nodeId}
      style={{
        position: 'absolute',
        left: x,
        top: y,
        width,
        zIndex,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
      }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      {behindContent}
      <div
        ref={cardRef}
        className={className}
        style={{ ...style, position: 'relative', width, height, overflow: 'visible' }}
        onMouseDown={onMouseDown}
      >
        {headVariant === 'visible' && (
          <div className="card-shell__head" style={headStyle}>
            {titleContent}
            {actionButtons}
          </div>
        )}
        {headVariant === 'overlay' && actionButtons}
        {hiddenHeadActions}
        <div className="card-shell__body-wrapper">
          {archiveOpen && archivedChildren.length > 0 && (
            <div className={`card-shell__archive-body${width < ARCHIVE_BODY_MIN_WIDTH ? ' card-shell__popup--centered' : ''}${headVariant === 'overlay' ? ' card-shell__popup--below-actions' : ''}`} ref={archiveBodyRef}>
              <ArchiveBody
                parentId={nodeId}
                archives={archivedChildren}
                onUnarchive={onUnarchive}
                onArchiveDelete={onArchiveDelete}
              />
            </div>
          )}
          {sessionsOpen && pastSessions && pastSessions.length > 0 && (
            <div className={`card-shell__sessions-body${width < ARCHIVE_BODY_MIN_WIDTH ? ' card-shell__popup--centered' : ''}${headVariant === 'overlay' ? ' card-shell__popup--below-actions' : ''}`} ref={sessionsBodyRef}>
              <SessionsBody nodeId={nodeId} sessions={pastSessions} currentSessionIndex={currentSessionIndex} onRevive={onSessionRevive!} />
            </div>
          )}
          {addNodeOpen && onAddNode && (
            <div className={`card-shell__add-node-body${width < ARCHIVE_BODY_MIN_WIDTH ? ' card-shell__popup--centered' : ''}${headVariant === 'overlay' ? ' card-shell__popup--below-actions' : ''}`} ref={addNodeBodyRef}>
              <AddNodeBody onSelect={handleAddNodeSelect} />
            </div>
          )}
          {children}
        </div>
      </div>
    </div>
  )
}
