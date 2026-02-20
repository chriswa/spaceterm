import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { TITLE_HEIGHT, TITLE_LINE_HEIGHT, TITLE_H_PADDING, TITLE_MIN_WIDTH } from '../lib/constants'
import type { ColorPreset } from '../lib/color-presets'
import type { Camera } from '../lib/camera'
import type { ArchivedNode } from '../../../../shared/state'
import { CardShell } from './CardShell'
import { useNodeStore } from '../stores/nodeStore'
import { useReparentStore } from '../stores/reparentStore'

const DRAG_THRESHOLD = 5

interface TitleCardProps {
  id: string
  x: number
  y: number
  zIndex: number
  zoom: number
  text: string
  focused: boolean
  selected: boolean
  colorPresetId?: string
  resolvedPreset?: ColorPreset
  archivedChildren: ArchivedNode[]
  onFocus: (id: string) => void
  onClose: (id: string) => void
  onMove: (id: string, x: number, y: number) => void
  onTextChange: (id: string, text: string) => void
  onColorChange: (id: string, color: string) => void
  onUnarchive: (parentNodeId: string, archivedNodeId: string) => void
  onArchiveDelete: (parentNodeId: string, archivedNodeId: string) => void
  onArchiveToggled: (nodeId: string, open: boolean) => void
  onNodeReady?: (nodeId: string, bounds: { x: number; y: number; width: number; height: number }) => void
  onDragStart?: (id: string, solo?: boolean) => void
  onDragEnd?: (id: string) => void
  onStartReparent?: (id: string) => void
  onReparentTarget?: (id: string) => void
  onAddNode?: (parentNodeId: string, type: import('./AddNodeBody').AddNodeType) => void
  cameraRef: React.RefObject<Camera>
}

export function TitleCard({
  id, x, y, zIndex, zoom, text, focused, selected, colorPresetId, resolvedPreset, archivedChildren,
  onFocus, onClose, onMove, onTextChange, onColorChange,
  onUnarchive, onArchiveDelete, onArchiveToggled, onNodeReady,
  onDragStart, onDragEnd, onStartReparent, onReparentTarget, onAddNode, cameraRef
}: TitleCardProps) {
  const preset = resolvedPreset
  const [editing, setEditing] = useState(false)
  const [editValue, setEditValue] = useState(text)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const measureRef = useRef<HTMLSpanElement>(null)
  const [textWidth, setTextWidth] = useState(0)
  const propsRef = useRef({ x, y, zoom, id })
  propsRef.current = { x, y, zoom, id }
  const reparentingNodeId = useReparentStore(s => s.reparentingNodeId)
  const freshlyCreated = useNodeStore(s => s.freshlyCreatedIds.has(id))

  // Auto-enter edit mode when freshly created and focused
  useEffect(() => {
    if (focused && freshlyCreated) {
      useNodeStore.getState().clearFreshlyCreated(id)
      setEditValue(text)
      setEditing(true)
    }
  }, [focused, freshlyCreated, id, text])

  // Measure text width via hidden span
  useLayoutEffect(() => {
    if (!measureRef.current) return
    measureRef.current.textContent = (editing ? editValue : text) || 'Title'
    setTextWidth(measureRef.current.offsetWidth)
  }, [text, editing, editValue])

  const displayText = editing ? editValue : text
  const lines = displayText ? displayText.split('\n') : ['']
  const lineCount = lines.length
  const cardWidth = Math.max(TITLE_MIN_WIDTH, textWidth + TITLE_H_PADDING)
  const cardHeight = TITLE_HEIGHT + (lineCount - 1) * TITLE_LINE_HEIGHT

  // Notify parent when focused node size is known
  useEffect(() => {
    if (!focused) return
    onNodeReady?.(id, { x: x - cardWidth / 2, y: y - cardHeight / 2, width: cardWidth, height: cardHeight })
  }, [focused, id, x, y, cardWidth, cardHeight, onNodeReady])

  // Auto-focus input when entering edit mode
  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [editing])

  const startEditing = useCallback(() => {
    setEditValue(text)
    setEditing(true)
  }, [text])

  const cancelEditing = useCallback(() => {
    setEditing(false)
  }, [])

  const saveAndClose = useCallback(() => {
    const trimmed = editValue.trim()
    if (trimmed !== text) {
      onTextChange(id, trimmed)
    }
    setEditing(false)
  }, [editValue, text, id, onTextChange])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && e.shiftKey) {
      // Allow default textarea behavior (insert newline)
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      saveAndClose()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      cancelEditing()
    }
  }, [saveAndClose, cancelEditing])

  // Drag handler — same pattern as DirectoryCard
  const handleMouseDown = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('.node-titlebar__actions, .node-titlebar__color-picker, .archive-body')) return
    if (editing && (e.target as HTMLElement).closest('.title-card__input')) return

    e.preventDefault()

    const startScreenX = e.clientX
    const startScreenY = e.clientY
    const startX = propsRef.current.x
    const startY = propsRef.current.y
    const currentZoom = cameraRef.current.z
    let dragging = false

    const onMouseMove = (ev: MouseEvent) => {
      const dx = ev.clientX - startScreenX
      const dy = ev.clientY - startScreenY

      if (!dragging && Math.abs(dx) + Math.abs(dy) > DRAG_THRESHOLD) {
        dragging = true
        onDragStart?.(id, ev.metaKey)
      }

      if (dragging) {
        onMove(id, startX + dx / currentZoom, startY + dy / currentZoom)
      }
    }

    const onMouseUp = () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
      if (dragging) {
        onDragEnd?.(id)
      } else if (useReparentStore.getState().reparentingNodeId) {
        onReparentTarget?.(id)
      } else if (!editing) {
        onFocus(id)
      }
    }

    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
  }

  return (
    <CardShell
      nodeId={id}
      x={x - cardWidth / 2}
      y={y - cardHeight / 2}
      width={cardWidth}
      height={cardHeight}
      zIndex={zIndex}
      focused={focused}
      headVariant="overlay"
      archivedChildren={archivedChildren}
      onClose={onClose}
      onColorChange={onColorChange}
      onUnarchive={onUnarchive}
      onArchiveDelete={onArchiveDelete}
      onArchiveToggled={onArchiveToggled}
      onMouseDown={handleMouseDown}
      onStartReparent={onStartReparent}
      onAddNode={onAddNode}
      isReparenting={reparentingNodeId === id}
      className={`title-card ${focused ? 'title-card--focused' : selected ? 'title-card--selected' : ''}`}
      style={{
        backgroundColor: 'transparent',
        '--title-fg': preset?.titleBarBg ?? '#a66cff',
      } as React.CSSProperties}
      onMouseEnter={() => { if (reparentingNodeId) useReparentStore.getState().setHoveredNode(id) }}
      onMouseLeave={() => { if (reparentingNodeId) useReparentStore.getState().setHoveredNode(null) }}
    >
      <div className="title-card__body">
        <span ref={measureRef} className="title-card__measure" />
        {editing ? (
          <textarea
            ref={inputRef}
            className="title-card__input"
            value={editValue}
            rows={lineCount}
            onChange={(e) => setEditValue(e.target.value)}
            onKeyDown={handleKeyDown}
            onBlur={saveAndClose}
            placeholder="Title"
          />
        ) : (
          <div className="title-card__label" onClick={focused ? startEditing : undefined}>
            {text || 'Title'}
          </div>
        )}
      </div>
    </CardShell>
  )
}
