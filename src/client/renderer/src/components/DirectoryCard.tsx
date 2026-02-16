import { useCallback, useEffect, useRef, useState } from 'react'
import { DIRECTORY_WIDTH, DIRECTORY_HEIGHT } from '../lib/constants'
import type { ColorPreset } from '../lib/color-presets'
import type { ArchivedNode } from '../../../../shared/state'
import { CardShell } from './CardShell'
import { useReparentStore } from '../stores/reparentStore'

const DRAG_THRESHOLD = 5

interface DirectoryCardProps {
  id: string
  x: number
  y: number
  zIndex: number
  zoom: number
  cwd: string
  focused: boolean
  selected: boolean
  colorPresetId?: string
  resolvedPreset?: ColorPreset
  archivedChildren: ArchivedNode[]
  onFocus: (id: string) => void
  onClose: (id: string) => void
  onMove: (id: string, x: number, y: number) => void
  onCwdChange: (id: string, cwd: string) => void
  onColorChange: (id: string, color: string) => void
  onUnarchive: (parentNodeId: string, archivedNodeId: string) => void
  onArchiveDelete: (parentNodeId: string, archivedNodeId: string) => void
  onArchiveToggled: (nodeId: string, open: boolean) => void
  onNodeReady?: (nodeId: string, bounds: { x: number; y: number; width: number; height: number }) => void
  onDragStart?: (id: string, solo?: boolean) => void
  onDragEnd?: (id: string) => void
  onStartReparent?: (id: string) => void
  onReparentTarget?: (id: string) => void
}

export function DirectoryCard({
  id, x, y, zIndex, zoom, cwd, focused, selected, colorPresetId, resolvedPreset, archivedChildren,
  onFocus, onClose, onMove, onCwdChange, onColorChange,
  onUnarchive, onArchiveDelete, onArchiveToggled, onNodeReady,
  onDragStart, onDragEnd, onStartReparent, onReparentTarget
}: DirectoryCardProps) {
  const preset = resolvedPreset
  const [editing, setEditing] = useState(false)
  const [editValue, setEditValue] = useState(cwd)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const measureRef = useRef<HTMLSpanElement>(null)
  const propsRef = useRef({ x, y, zoom, id })
  propsRef.current = { x, y, zoom, id }
  const reparentingNodeId = useReparentStore(s => s.reparentingNodeId)

  // Notify parent when focused node size is known
  useEffect(() => {
    if (!focused) return
    onNodeReady?.(id, { x: x - DIRECTORY_WIDTH / 2, y: y - DIRECTORY_HEIGHT / 2, width: DIRECTORY_WIDTH, height: DIRECTORY_HEIGHT })
  }, [focused, id, x, y, onNodeReady])

  // Auto-focus input when entering edit mode
  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [editing])

  // Auto-size input based on content
  useEffect(() => {
    if (editing && measureRef.current && inputRef.current) {
      measureRef.current.textContent = editValue || ' '
      inputRef.current.style.width = `${measureRef.current.offsetWidth + 4}px`
    }
  }, [editing, editValue])

  const startEditing = useCallback(() => {
    setEditValue(cwd)
    setError(null)
    setEditing(true)
  }, [cwd])

  const cancelEditing = useCallback(() => {
    setEditing(false)
    setError(null)
  }, [])

  const validateAndSave = useCallback(async () => {
    const trimmed = editValue.trim()
    if (!trimmed || trimmed === cwd) {
      cancelEditing()
      return
    }
    try {
      const result = await window.api.node.validateDirectory(trimmed)
      if (result.valid) {
        onCwdChange(id, trimmed)
        setEditing(false)
        setError(null)
      } else {
        // Revert on invalid
        cancelEditing()
      }
    } catch {
      cancelEditing()
    }
  }, [editValue, cwd, id, onCwdChange, cancelEditing])

  const handleInputChange = useCallback(async (value: string) => {
    setEditValue(value)
    if (!value.trim()) {
      setError(null)
      return
    }
    try {
      const result = await window.api.node.validateDirectory(value.trim())
      setError(result.valid ? null : (result.error ?? 'Invalid path'))
    } catch {
      setError(null)
    }
  }, [])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      validateAndSave()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      cancelEditing()
    }
  }, [validateAndSave, cancelEditing])

  // Drag handler — same pattern as MarkdownCard
  const handleMouseDown = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('.node-titlebar__actions, .node-titlebar__color-picker, .archive-body')) return

    // Don't start drag if clicking the input while editing
    if (editing && (e.target as HTMLElement).closest('.directory-card__input')) return

    e.preventDefault()

    const startScreenX = e.clientX
    const startScreenY = e.clientY
    const startX = propsRef.current.x
    const startY = propsRef.current.y
    const currentZoom = propsRef.current.zoom
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
      x={x - DIRECTORY_WIDTH / 2}
      y={y - DIRECTORY_HEIGHT / 2}
      width={DIRECTORY_WIDTH}
      height={DIRECTORY_HEIGHT}
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
      isReparenting={reparentingNodeId === id}
      className={`directory-card ${focused ? 'directory-card--focused' : selected ? 'directory-card--selected' : ''}`}
      style={{ backgroundColor: preset?.terminalBg ?? '#1e1e2e' }}
      onMouseEnter={() => { if (reparentingNodeId) useReparentStore.getState().setHoveredNode(id) }}
      onMouseLeave={() => { if (reparentingNodeId) useReparentStore.getState().setHoveredNode(null) }}
    >
      <div className="directory-card__body">
        {editing ? (
          <div className="directory-card__edit-container">
            <span ref={measureRef} className="directory-card__measure" />
            <input
              ref={inputRef}
              className="directory-card__input"
              type="text"
              value={editValue}
              onChange={(e) => handleInputChange(e.target.value)}
              onKeyDown={handleKeyDown}
              onBlur={validateAndSave}
            />
            {error && <div className="directory-card__error">{error}</div>}
          </div>
        ) : (
          <div className="directory-card__label" onClick={focused ? startEditing : undefined}>
            {cwd}
          </div>
        )}
      </div>
    </CardShell>
  )
}
