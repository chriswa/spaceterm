import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactNode, RefObject } from 'react'
import type { ColorPreset } from '../lib/color-presets'
import type { ArchivedNode, TerminalSessionEntry } from '../../../../shared/state'
import { ArchiveBody } from './ArchiveBody'
import { AddNodeBody } from './AddNodeBody'
import type { AddNodeType } from './AddNodeBody'
import { ARCHIVE_BODY_MIN_WIDTH } from '../lib/constants'
import { NodeActionBar } from './NodeActionBar'
import type { NodeActionBarProps } from './NodeActionBar'
import { NodeAlertsProvider } from '../lib/node-alerts'
import { nodeActionRegistry } from '../lib/action-registry'

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
  archivedChildren, onClose, onColorChange, onUnarchive, onArchiveDelete, onArchiveToggled,
  pastSessions, currentSessionIndex, onSessionsToggled, onSessionRevive,
  onMouseDown, onStartReparent, onShipIt, onFork, onDiffPlans, isReparenting,
  onPostSync, onWtSpawn, onAddNode, onExtraCliArgs, extraCliArgs,
  className, style, cardRef, onMouseEnter, onMouseLeave, behindContent, children
}: CardShellProps) {

  // Build NodeActionBar props and register in the action registry
  const actionBarProps: NodeActionBarProps = {
    nodeId, preset, focused, width,
    onShipIt, onFork, onExtraCliArgs, extraCliArgs,
    onDiffPlans, showColorPicker, onColorChange,
    pastSessions, currentSessionIndex, onSessionsToggled, onSessionRevive,
    archivedChildren, onArchiveToggled, onUnarchive, onArchiveDelete,
    onPostSync, onWtSpawn,
    onStartReparent, isReparenting,
    onAddNode, showClose, onClose,
  }

  // Register action props so FloatingToolbar can read them
  nodeActionRegistry.set(nodeId, actionBarProps)
  useEffect(() => () => { nodeActionRegistry.delete(nodeId) }, [nodeId])

  // --- Hidden-head variant: minimal archive + add-node with own state ---
  const [hiddenArchiveOpen, setHiddenArchiveOpen] = useState(false)
  const [hiddenAddNodeOpen, setHiddenAddNodeOpen] = useState(false)
  const hiddenArchiveBtnRef = useRef<HTMLButtonElement>(null)
  const hiddenArchiveBodyRef = useRef<HTMLDivElement>(null)
  const hiddenAddNodeBtnRef = useRef<HTMLButtonElement>(null)
  const hiddenAddNodeBodyRef = useRef<HTMLDivElement>(null)

  // Close hidden-head archive when archives become empty
  useEffect(() => {
    if (archivedChildren.length === 0 && hiddenArchiveOpen) {
      setHiddenArchiveOpen(false)
      onArchiveToggled(nodeId, false)
    }
  }, [archivedChildren.length, hiddenArchiveOpen, nodeId, onArchiveToggled])

  // Close hidden-head popups when node loses focus
  useEffect(() => {
    if (!focused) {
      if (hiddenArchiveOpen) setHiddenArchiveOpen(false)
      if (hiddenAddNodeOpen) setHiddenAddNodeOpen(false)
    }
  }, [focused, hiddenArchiveOpen, hiddenAddNodeOpen])

  // Dismiss hidden archive on outside click
  useEffect(() => {
    if (!hiddenArchiveOpen) return
    const handler = (e: MouseEvent) => {
      const target = e.target as Node
      if (hiddenArchiveBodyRef.current?.contains(target)) return
      if (hiddenArchiveBtnRef.current?.contains(target)) return
      setHiddenArchiveOpen(false)
      onArchiveToggled(nodeId, false)
    }
    document.addEventListener('mousedown', handler, { capture: true })
    return () => document.removeEventListener('mousedown', handler, { capture: true })
  }, [hiddenArchiveOpen, nodeId, onArchiveToggled])

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

  const toggleHiddenArchive = useCallback(() => {
    setHiddenAddNodeOpen(false)
    setHiddenArchiveOpen(prev => {
      const next = !prev
      onArchiveToggled(nodeId, next)
      return next
    })
  }, [nodeId, onArchiveToggled])

  const toggleHiddenAddNode = useCallback(() => {
    setHiddenArchiveOpen(false)
    setHiddenAddNodeOpen(prev => !prev)
  }, [])

  const handleHiddenAddNodeSelect = useCallback((type: AddNodeType) => {
    setHiddenAddNodeOpen(false)
    onAddNode?.(nodeId, type)
  }, [nodeId, onAddNode])

  const hiddenHeadActions = headVariant === 'hidden' ? (
    <div className="card-shell__hidden-head-actions">
      <button
        ref={hiddenArchiveBtnRef}
        className="node-titlebar__archive-btn card-shell__archive-btn"
        data-tooltip="Archived children"
        disabled={archivedChildren.length === 0}
        onClick={(e) => { e.stopPropagation(); toggleHiddenArchive() }}
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
      <div
        ref={cardRef}
        className={className}
        style={{ ...style, position: 'relative', width, height, overflow: 'visible' }}
        onMouseDown={onMouseDown}
      >
        <NodeAlertsProvider>
        {headVariant === 'visible' && (
          <div className="card-shell__head" style={headStyle}>
            {titleContent}
            <NodeActionBar {...actionBarProps} />
          </div>
        )}
        {headVariant === 'overlay' && <NodeActionBar {...actionBarProps} />}
        {hiddenHeadActions}
        <div className="card-shell__body-wrapper">
          {headVariant === 'hidden' && hiddenArchiveOpen && archivedChildren.length > 0 && (
            <div className={`card-shell__archive-body${width < ARCHIVE_BODY_MIN_WIDTH ? ' card-shell__popup--centered' : ''}`} ref={hiddenArchiveBodyRef}>
              <ArchiveBody
                parentId={nodeId}
                archives={archivedChildren}
                onUnarchive={onUnarchive}
                onArchiveDelete={onArchiveDelete}
              />
            </div>
          )}
          {headVariant === 'hidden' && hiddenAddNodeOpen && onAddNode && (
            <div className={`card-shell__add-node-body${width < ARCHIVE_BODY_MIN_WIDTH ? ' card-shell__popup--centered' : ''}`} ref={hiddenAddNodeBodyRef}>
              <AddNodeBody onSelect={handleHiddenAddNodeSelect} />
            </div>
          )}
          {children}
        </div>
        </NodeAlertsProvider>
      </div>
    </div>
  )
}
