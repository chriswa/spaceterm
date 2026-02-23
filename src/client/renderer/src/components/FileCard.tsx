import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { FILE_WIDTH, FILE_HEIGHT } from '../lib/constants'
import type { ColorPreset } from '../lib/color-presets'
import type { Camera } from '../lib/camera'
import { blendHex } from '../lib/color-presets'
import type { ArchivedNode } from '../../../../shared/state'
import { CardShell } from './CardShell'
import { useNodeStore } from '../stores/nodeStore'
import { useReparentStore } from '../stores/reparentStore'
import { angleBorderColor } from '../lib/angle-color'

const DRAG_THRESHOLD = 5
const FILE_H_PADDING = 80
const MIN_FILE_WIDTH = 180
const DEFAULT_BG = '#1e1e2e'

function documentPaths(w: number) {
  // Document icon: page with a dog-ear fold in the top-right corner
  const margin = 16
  const left = margin
  const right = w - margin
  const top = 10
  const bottom = 138
  const foldSize = 24
  const cornerX = right - foldSize
  const cornerY = top + foldSize

  const outline = `M ${left + 8} ${top} Q ${left} ${top} ${left} ${top + 8} L ${left} ${bottom - 8} Q ${left} ${bottom} ${left + 8} ${bottom} L ${right - 8} ${bottom} Q ${right} ${bottom} ${right} ${bottom - 8} L ${right} ${cornerY} L ${cornerX} ${top} L ${left + 8} ${top} Z`
  const fold = `M ${cornerX} ${top} L ${cornerX} ${cornerY - 2} Q ${cornerX} ${cornerY} ${cornerX + 2} ${cornerY} L ${right} ${cornerY}`

  return { outline, fold }
}

interface FileCardProps {
  id: string
  x: number
  y: number
  zIndex: number
  zoom: number
  filePath: string
  inheritedCwd?: string
  focused: boolean
  selected: boolean
  colorPresetId?: string
  resolvedPreset?: ColorPreset
  archivedChildren: ArchivedNode[]
  onFocus: (id: string) => void
  onClose: (id: string) => void
  onMove: (id: string, x: number, y: number, metaKey?: boolean) => void
  onFilePathChange: (id: string, filePath: string) => void
  onColorChange: (id: string, color: string) => void
  onUnarchive: (parentNodeId: string, archivedNodeId: string) => void
  onArchiveDelete: (parentNodeId: string, archivedNodeId: string) => void
  onOpenArchiveSearch: (nodeId: string) => void
  onNodeReady?: (nodeId: string, bounds: { x: number; y: number; width: number; height: number }) => void
  onDragStart?: (id: string, solo?: boolean, ctrlAtStart?: boolean, shiftAtStart?: boolean) => void
  onDragEnd?: (id: string) => void
  onStartReparent?: (id: string) => void
  onReparentTarget?: (id: string) => void
  onAddNode?: (parentNodeId: string, type: import('./AddNodeBody').AddNodeType) => void
  cameraRef: React.RefObject<Camera>
}

export function FileCard({
  id, x, y, zIndex, zoom, filePath, inheritedCwd, focused, selected, colorPresetId, resolvedPreset, archivedChildren,
  onFocus, onClose, onMove, onFilePathChange, onColorChange,
  onUnarchive, onArchiveDelete, onOpenArchiveSearch, onNodeReady,
  onDragStart, onDragEnd, onStartReparent, onReparentTarget, onAddNode, cameraRef
}: FileCardProps) {
  const preset = resolvedPreset
  const [editing, setEditing] = useState(false)
  const [editValue, setEditValue] = useState(filePath)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
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
      setEditValue('')
      setError(null)
      setEditing(true)
    }
  }, [focused, freshlyCreated, id])

  // Measure text width via hidden span
  useLayoutEffect(() => {
    if (!measureRef.current) return
    measureRef.current.textContent = (editing ? editValue : filePath) || ' '
    setTextWidth(measureRef.current.offsetWidth)
  }, [filePath, editing, editValue])

  const fileWidth = Math.max(MIN_FILE_WIDTH, textWidth + FILE_H_PADDING)
  const paths = documentPaths(fileWidth)

  // Notify parent when focused node size is known
  useEffect(() => {
    if (!focused) return
    onNodeReady?.(id, { x: x - fileWidth / 2, y: y - FILE_HEIGHT / 2, width: fileWidth, height: FILE_HEIGHT })
  }, [focused, id, x, y, fileWidth, onNodeReady])

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
    setEditValue(filePath)
    setError(null)
    setEditing(true)
  }, [filePath])

  const cancelEditing = useCallback(() => {
    setEditing(false)
    setError(null)
  }, [])

  const validateAndSave = useCallback(async () => {
    const trimmed = editValue.trim()
    if (!trimmed || trimmed === filePath) {
      cancelEditing()
      return
    }
    try {
      const result = await window.api.node.validateFile(trimmed, inheritedCwd)
      if (result.valid) {
        onFilePathChange(id, trimmed)
        setEditing(false)
        setError(null)
      } else {
        cancelEditing()
      }
    } catch {
      cancelEditing()
    }
  }, [editValue, filePath, id, inheritedCwd, onFilePathChange, cancelEditing])

  const handleInputChange = useCallback(async (value: string) => {
    setEditValue(value)
    if (!value.trim()) {
      setError(null)
      return
    }
    try {
      const result = await window.api.node.validateFile(value.trim(), inheritedCwd)
      setError(result.valid ? null : (result.error ?? 'Invalid path'))
    } catch {
      setError(null)
    }
  }, [inheritedCwd])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      validateAndSave()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      cancelEditing()
    }
  }, [validateAndSave, cancelEditing])

  // Drag handler
  const handleMouseDown = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('.node-titlebar__actions, .node-titlebar__color-picker, .archive-body')) return
    if (editing && (e.target as HTMLElement).closest('.file-card__input')) return

    e.preventDefault()

    const startScreenX = e.clientX
    const startScreenY = e.clientY
    const startX = propsRef.current.x
    const startY = propsRef.current.y
    const currentZoom = cameraRef.current.z
    const ctrlAtStart = e.ctrlKey
    let dragging = false

    const onMouseMove = (ev: MouseEvent) => {
      const dx = ev.clientX - startScreenX
      const dy = ev.clientY - startScreenY

      if (!dragging && Math.abs(dx) + Math.abs(dy) > DRAG_THRESHOLD) {
        dragging = true
        onDragStart?.(id, ev.metaKey, ctrlAtStart, ev.shiftKey)
      }

      if (dragging) {
        onMove(id, startX + dx / currentZoom, startY + dy / currentZoom, ev.metaKey)
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
      x={x - fileWidth / 2}
      y={y - FILE_HEIGHT / 2}
      width={fileWidth}
      height={FILE_HEIGHT}
      zIndex={zIndex}
      focused={focused}
      headVariant="overlay"
      archivedChildren={archivedChildren}
      onClose={onClose}
      onColorChange={onColorChange}
      onUnarchive={onUnarchive}
      onArchiveDelete={onArchiveDelete}
      onOpenArchiveSearch={onOpenArchiveSearch}
      onMouseDown={handleMouseDown}
      onStartReparent={onStartReparent}
      onAddNode={onAddNode}
      isReparenting={reparentingNodeId === id}
      className={`file-card ${focused ? 'file-card--focused' : selected ? 'file-card--selected' : ''}`}
      style={{
        backgroundColor: 'transparent',
        '--file-fg': preset?.terminalBg ?? DEFAULT_BG,
      } as React.CSSProperties}
      onMouseEnter={() => { if (reparentingNodeId) useReparentStore.getState().setHoveredNode(id) }}
      onMouseLeave={() => { if (reparentingNodeId) useReparentStore.getState().setHoveredNode(null) }}
    >
      <svg
        className="file-card__doc-svg"
        viewBox={`0 0 ${fileWidth} 144`}
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        style={focused ? { color: angleBorderColor(x, y), filter: `drop-shadow(0 0 4px ${angleBorderColor(x, y)})` } : undefined}
      >
        <path d={paths.outline} fill={blendHex(preset?.titleBarBg ?? '#ffffff', '#000000', 0.8)} stroke="currentColor" strokeWidth="1.5" />
        <path d={paths.fold} fill="none" stroke="currentColor" strokeWidth="1.5" />
      </svg>
      <div className="file-card__body">
        <span ref={measureRef} className="file-card__measure" />
        {editing ? (
          <div className="file-card__edit-container">
            <input
              ref={inputRef}
              className="file-card__input"
              type="text"
              value={editValue}
              onChange={(e) => handleInputChange(e.target.value)}
              onKeyDown={handleKeyDown}
              onBlur={validateAndSave}
            />
            {error && <div className="file-card__error">{error}</div>}
          </div>
        ) : (
          <div className="file-card__label" onClick={focused ? startEditing : undefined}>
            {filePath || <span style={{ opacity: 0.4 }}>file path</span>}
          </div>
        )}
      </div>
    </CardShell>
  )
}
