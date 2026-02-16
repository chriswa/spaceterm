import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactNode, RefObject } from 'react'
import { COLOR_PRESETS } from '../lib/color-presets'
import type { ColorPreset } from '../lib/color-presets'
import type { ArchivedNode } from '../../../../shared/state'
import { ArchiveBody } from './ArchiveBody'

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
  onMouseDown?: (e: React.MouseEvent) => void
  onStartReparent?: (id: string) => void
  isReparenting?: boolean
  className?: string
  style?: CSSProperties
  cardRef?: RefObject<HTMLDivElement | null>
  onMouseEnter?: (e: React.MouseEvent) => void
  onMouseLeave?: (e: React.MouseEvent) => void
  children: ReactNode
}

export function CardShell({
  nodeId, x, y, width, height, zIndex, focused,
  headVariant, titleContent, headStyle, preset,
  showClose = true, showColorPicker = true,
  archivedChildren, onClose, onColorChange, onUnarchive, onArchiveDelete, onArchiveToggled,
  onMouseDown, onStartReparent, isReparenting,
  className, style, cardRef, onMouseEnter, onMouseLeave, children
}: CardShellProps) {
  const [archiveOpen, setArchiveOpen] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const pickerRef = useRef<HTMLDivElement>(null)
  const archiveBtnRef = useRef<HTMLButtonElement>(null)
  const archiveBodyRef = useRef<HTMLDivElement>(null)

  // Close archive when archives become empty
  useEffect(() => {
    if (archivedChildren.length === 0 && archiveOpen) {
      setArchiveOpen(false)
      onArchiveToggled(nodeId, false)
    }
  }, [archivedChildren.length, archiveOpen, nodeId, onArchiveToggled])

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
    setArchiveOpen(prev => {
      const next = !prev
      onArchiveToggled(nodeId, next)
      return next
    })
  }, [nodeId, onArchiveToggled])

  // Action buttons shared across head variants
  const actionButtons = (
    <div className="node-titlebar__actions">
      {showColorPicker && (
        <div style={{ position: 'relative' }} ref={pickerRef}>
          <button
            className="node-titlebar__color-btn"
            title="Header color"
            style={preset ? { color: preset.titleBarFg } : undefined}
            onClick={(e) => { e.stopPropagation(); setPickerOpen(prev => !prev) }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            &#9679;
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
      {archivedChildren.length > 0 && (
        <button
          ref={archiveBtnRef}
          className="node-titlebar__archive-btn"
          title="Archived children"
          style={preset ? { color: preset.titleBarFg } : undefined}
          onClick={(e) => { e.stopPropagation(); toggleArchive() }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {archivedChildren.length}
        </button>
      )}
      {onStartReparent && (
        <button
          className={`node-titlebar__reparent-btn${isReparenting ? ' node-titlebar__reparent-btn--active' : ''}`}
          title="Reparent node"
          style={preset ? { color: preset.titleBarFg } : undefined}
          onClick={(e) => { e.stopPropagation(); onStartReparent(nodeId) }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M2 8 L2 4 Q2 2 4 2 L8 2" />
            <path d="M6 0 L8 2 L6 4" />
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
          &times;
        </button>
      )}
    </div>
  )

  // Hidden head: only show archive button when archives exist
  const hiddenHeadArchiveBtn = headVariant === 'hidden' && archivedChildren.length > 0 ? (
    <div className="card-shell__hidden-head-actions">
      {archivedChildren.length > 0 && (
        <button
          ref={archiveBtnRef}
          className="node-titlebar__archive-btn card-shell__archive-btn"
          title="Archived children"
          onClick={(e) => { e.stopPropagation(); toggleArchive() }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {archivedChildren.length}
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
            <div className="card-shell__archive-body" ref={archiveBodyRef}>
              <ArchiveBody
                parentId={nodeId}
                archives={archivedChildren}
                onUnarchive={onUnarchive}
                onArchiveDelete={onArchiveDelete}
              />
            </div>
          )}
          {children}
        </div>
      </div>
    </div>
  )
}
