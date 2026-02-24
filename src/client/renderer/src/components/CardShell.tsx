import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactNode, RefObject } from 'react'
import type { ColorPreset } from '../lib/color-presets'
import type { ArchivedNode, TerminalSessionEntry } from '../../../../shared/state'
import { AddNodeBody } from './AddNodeBody'
import type { AddNodeType } from './AddNodeBody'
import { ARCHIVE_BODY_MIN_WIDTH } from '../lib/constants'
import { NodeActionBar } from './NodeActionBar'
import type { NodeActionBarProps } from './NodeActionBar'
import { nodeActionRegistry } from '../lib/action-registry'
import { useNodeStore } from '../stores/nodeStore'
import type { NodeAlert } from '../../../../shared/state'

const EMPTY_ALERTS: NodeAlert[] = []

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
  onOpenArchiveSearch?: (nodeId: string) => void
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
  onPostSync?: (id: string) => void
  onWtSpawn?: (id: string, branchName: string) => void
  onAddNode?: (parentNodeId: string, type: AddNodeType) => void
  onExtraCliArgs?: (nodeId: string, extraCliArgs: string) => void
  extraCliArgs?: string
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
  archivedChildren, onClose, onColorChange, onUnarchive, onArchiveDelete, onOpenArchiveSearch,
  pastSessions, currentSessionIndex, onSessionsToggled, onSessionRevive,
  onMouseDown, onStartReparent, onShipIt, onFork, onDiffPlans, isReparenting,
  onPostSync, onWtSpawn, onAddNode, onExtraCliArgs, extraCliArgs,
  className, style, cardRef, onMouseEnter, onMouseLeave, behindContent, children
}: CardShellProps) {

  // Alert badge (visible when unfocused)
  const alerts = useNodeStore(s => s.nodes[nodeId]?.alerts ?? EMPTY_ALERTS)
  const alertsReadTimestamp = useNodeStore(s => s.nodes[nodeId]?.alertsReadTimestamp)
  const hasAlerts = alerts.length > 0
  const hasUnread = hasAlerts && alerts.some(a => a.timestamp > (alertsReadTimestamp ?? 0))

  // Build NodeActionBar props and register in the action registry
  const actionBarProps: NodeActionBarProps = {
    nodeId, preset, focused, width,
    onShipIt, onFork, onExtraCliArgs, extraCliArgs,
    onDiffPlans, showColorPicker, onColorChange,
    pastSessions, currentSessionIndex, onSessionsToggled, onSessionRevive,
    archivedChildren, onOpenArchiveSearch, onUnarchive, onArchiveDelete,
    onPostSync, onWtSpawn,
    onStartReparent, isReparenting,
    onAddNode, showClose, onClose,
  }

  // Register action props so FloatingToolbar can read them
  nodeActionRegistry.set(nodeId, actionBarProps)
  useEffect(() => () => { nodeActionRegistry.delete(nodeId) }, [nodeId])

  // --- Hidden-head variant: minimal archive + add-node with own state ---
  const [hiddenAddNodeOpen, setHiddenAddNodeOpen] = useState(false)
  const hiddenAddNodeBtnRef = useRef<HTMLButtonElement>(null)
  const hiddenAddNodeBodyRef = useRef<HTMLDivElement>(null)

  // Close hidden-head popups when node loses focus
  useEffect(() => {
    if (!focused) {
      if (hiddenAddNodeOpen) setHiddenAddNodeOpen(false)
    }
  }, [focused, hiddenAddNodeOpen])

  // Dismiss hidden add-node on outside click
  useEffect(() => {
    if (!hiddenAddNodeOpen) return
    const handler = (e: MouseEvent) => {
      const target = e.target as Node
      if (hiddenAddNodeBodyRef.current?.contains(target)) return
      if (hiddenAddNodeBtnRef.current?.contains(target)) return
      setHiddenAddNodeOpen(false)
    }
    document.addEventListener('mousedown', handler, { capture: true })
    return () => document.removeEventListener('mousedown', handler, { capture: true })
  }, [hiddenAddNodeOpen])

  const handleHiddenArchiveClick = useCallback(() => {
    onOpenArchiveSearch?.(nodeId)
  }, [nodeId, onOpenArchiveSearch])

  const toggleHiddenAddNode = useCallback(() => {
    setHiddenAddNodeOpen(prev => !prev)
  }, [])

  const handleHiddenAddNodeSelect = useCallback((type: AddNodeType) => {
    setHiddenAddNodeOpen(false)
    onAddNode?.(nodeId, type)
  }, [nodeId, onAddNode])

  const hiddenHeadActions = headVariant === 'hidden' ? (
    <div className="card-shell__hidden-head-actions">
      <button
        className="node-titlebar__archive-btn card-shell__archive-btn"
        data-tooltip="Archived children"
        disabled={archivedChildren.length === 0}
        onClick={(e) => { e.stopPropagation(); handleHiddenArchiveClick() }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <svg width="18" height="18" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" style={{ position: 'absolute' }}>
          <path d="M2 1 L3 12 Q3 13 5 13 L9 13 Q11 13 11 12 L12 1" />
        </svg>
        <span className="node-titlebar__archive-count" style={archivedChildren.length >= 100 ? { fontSize: 7 } : archivedChildren.length >= 10 ? { fontSize: 8 } : undefined}>{archivedChildren.length}</span>
      </button>
      {onAddNode && (
        <button
          ref={hiddenAddNodeBtnRef}
          className="node-titlebar__add-btn card-shell__add-btn"
          data-tooltip="Add child node"
          onClick={(e) => { e.stopPropagation(); toggleHiddenAddNode() }}
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
      {hasAlerts && !focused && (
        <div className={`card-shell__alert-badge${hasUnread ? ' card-shell__alert-badge--unread' : ''}`}>
          <svg width="60" height="60" viewBox="0 0 16 16" fill="none" strokeLinecap="round" strokeLinejoin="round">
            {/* Black outline layer (thick) */}
            <path d="M8 1.5 L14.5 13 L1.5 13 Z" stroke="black" strokeWidth="2.5" />
            <line x1="8" y1="6" x2="8" y2="9.5" stroke="black" strokeWidth="2.5" />
            <circle cx="8" cy="11.5" r="0.5" stroke="black" strokeWidth="2.5" />
            {/* Animated color layer */}
            <path d="M8 1.5 L14.5 13 L1.5 13 Z" stroke="currentColor" strokeWidth="1.3" />
            <line x1="8" y1="6" x2="8" y2="9.5" stroke="currentColor" strokeWidth="1.3" />
            <circle cx="8" cy="11.5" r="0.5" stroke="currentColor" strokeWidth="1.3" />
          </svg>
        </div>
      )}
      <div
        ref={cardRef}
        className={className}
        style={{ ...style, position: 'relative', width, height, overflow: 'visible' }}
        onMouseDown={onMouseDown}
      >
        {headVariant === 'visible' && (
          <div className="card-shell__head" style={headStyle}>
            {titleContent}
            <NodeActionBar {...actionBarProps} />
          </div>
        )}
        {headVariant === 'overlay' && <NodeActionBar {...actionBarProps} />}
        {hiddenHeadActions}
        <div className="card-shell__body-wrapper">
          {headVariant === 'hidden' && hiddenAddNodeOpen && onAddNode && (
            <div className={`card-shell__add-node-body${width < ARCHIVE_BODY_MIN_WIDTH ? ' card-shell__popup--centered' : ''}`} ref={hiddenAddNodeBodyRef}>
              <AddNodeBody onSelect={handleHiddenAddNodeSelect} />
            </div>
          )}
          {children}
        </div>
      </div>
    </div>
  )
}
