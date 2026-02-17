import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactNode, RefObject } from 'react'
import { COLOR_PRESETS } from '../lib/color-presets'
import type { ColorPreset } from '../lib/color-presets'
import type { ArchivedNode, TerminalSessionEntry } from '../../../../shared/state'
import foodIcon from '../assets/food.svg'
import { ArchiveBody } from './ArchiveBody'
import { SessionsBody } from './SessionsBody'
import { ARCHIVE_BODY_MIN_WIDTH } from '../lib/constants'

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
  onSessionsToggled?: (nodeId: string, open: boolean) => void
  onSessionRevive?: (session: TerminalSessionEntry) => void
  onMouseDown?: (e: React.MouseEvent) => void
  onStartReparent?: (id: string) => void
  isReparenting?: boolean
  onMarkUnread?: (id: string) => void
  isUnviewed?: boolean
  food?: boolean
  onFoodToggle?: (id: string, food: boolean) => void
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
  pastSessions, onSessionsToggled, onSessionRevive,
  onMouseDown, onStartReparent, isReparenting, onMarkUnread, isUnviewed,
  food, onFoodToggle,
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
    setArchiveOpen(prev => {
      const next = !prev
      onArchiveToggled(nodeId, next)
      return next
    })
  }, [nodeId, onArchiveToggled])

  const toggleSessions = useCallback(() => {
    setArchiveOpen(false)
    setSessionsOpen(prev => {
      const next = !prev
      onSessionsToggled?.(nodeId, next)
      return next
    })
  }, [nodeId, onSessionsToggled])

  // Action buttons shared across head variants
  const actionButtons = (
    <div className="node-titlebar__actions">
      {onFoodToggle && (
        <button
          className={`node-titlebar__food-btn${food ? ' node-titlebar__food-btn--active' : ''}`}
          title={food ? 'Food: ON' : 'Food: OFF'}
          style={preset ? { color: preset.titleBarFg } : undefined}
          onClick={(e) => { e.stopPropagation(); onFoodToggle(nodeId, !food) }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <span style={{ position: 'relative', display: 'inline-block', width: 14, height: 14 }}>
            <span
              style={{
                display: 'block', width: 14, height: 14,
                backgroundColor: 'currentColor',
                WebkitMaskImage: `url(${foodIcon})`, maskImage: `url(${foodIcon})`,
                WebkitMaskSize: 'contain', maskSize: 'contain',
                WebkitMaskRepeat: 'no-repeat', maskRepeat: 'no-repeat',
                WebkitMaskPosition: 'center', maskPosition: 'center',
              }}
            />
            {!food && (
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeLinecap="round" style={{ position: 'absolute', top: 0, left: 0 }}>
                <line x1="1" y1="1" x2="13" y2="13" strokeWidth="1.5" />
              </svg>
            )}
          </span>
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
      {onMarkUnread && (
        <button
          className="node-titlebar__unread-btn"
          title="Mark as unread"
          disabled={isUnviewed}
          style={preset ? { color: preset.titleBarFg } : undefined}
          onClick={(e) => { e.stopPropagation(); onMarkUnread(nodeId) }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
            <rect x="1" y="3" width="12" height="9" rx="1" />
            <path d="M1 3 L7 8 L13 3" />
          </svg>
        </button>
      )}
      {pastSessions !== undefined && (
        <button
          ref={sessionsBtnRef}
          className="node-titlebar__sessions-btn"
          title="Past terminal sessions"
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

  const hiddenHeadArchiveBtn = headVariant === 'hidden' ? (
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
        {hiddenHeadArchiveBtn}
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
              <SessionsBody sessions={pastSessions} onRevive={onSessionRevive!} />
            </div>
          )}
          {children}
        </div>
      </div>
    </div>
  )
}
