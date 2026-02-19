import { useCallback, useEffect, useRef, useState } from 'react'
import { IMAGE_DEFAULT_WIDTH, IMAGE_DEFAULT_HEIGHT } from '../lib/constants'
import type { ColorPreset } from '../lib/color-presets'
import type { Camera } from '../lib/camera'
import type { ArchivedNode } from '../../../../shared/state'
import { CardShell } from './CardShell'
import { useReparentStore } from '../stores/reparentStore'

const DRAG_THRESHOLD = 5

interface ImageCardProps {
  id: string
  x: number
  y: number
  zIndex: number
  zoom: number
  filePath: string
  width?: number
  height?: number
  focused: boolean
  selected: boolean
  colorPresetId?: string
  resolvedPreset?: ColorPreset
  archivedChildren: ArchivedNode[]
  onFocus: (id: string) => void
  onClose: (id: string) => void
  onMove: (id: string, x: number, y: number) => void
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
  onImageLoaded?: (id: string, width: number, height: number) => void
  cameraRef: React.RefObject<Camera>
}

export function ImageCard({
  id, x, y, zIndex, zoom, filePath, width, height, focused, selected,
  colorPresetId, resolvedPreset, archivedChildren,
  onFocus, onClose, onMove, onColorChange,
  onUnarchive, onArchiveDelete, onArchiveToggled, onNodeReady,
  onDragStart, onDragEnd, onStartReparent, onReparentTarget, onAddNode,
  onImageLoaded, cameraRef
}: ImageCardProps) {
  const [displaySize, setDisplaySize] = useState<{ width: number; height: number } | null>(null)
  const propsRef = useRef({ x, y, zoom, id })
  propsRef.current = { x, y, zoom, id }
  const reparentingNodeId = useReparentStore(s => s.reparentingNodeId)

  // Before image loads, use server-provided or default dimensions
  const currentWidth = displaySize?.width ?? width ?? IMAGE_DEFAULT_WIDTH
  const currentHeight = displaySize?.height ?? height ?? IMAGE_DEFAULT_HEIGHT

  // Notify parent when focused node size is known
  useEffect(() => {
    if (!focused) return
    onNodeReady?.(id, { x: x - currentWidth / 2, y: y - currentHeight / 2, width: currentWidth, height: currentHeight })
  }, [focused, id, x, y, currentWidth, currentHeight, onNodeReady])

  const handleImageLoad = useCallback((e: React.SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget
    const naturalW = img.naturalWidth
    const naturalH = img.naturalHeight
    let w: number
    let h: number

    if (width != null && height != null) {
      w = width
      h = height
    } else if (width != null) {
      w = width
      h = naturalH > 0 ? width * naturalH / naturalW : width
    } else if (height != null) {
      h = height
      w = naturalW > 0 ? height * naturalW / naturalH : height
    } else {
      w = naturalW
      h = naturalH
    }

    setDisplaySize({ width: w, height: h })
    onImageLoaded?.(id, w, h)
  }, [id, width, height, onImageLoaded])

  // Drag handler — same pattern as DirectoryCard
  const handleMouseDown = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('.node-titlebar__actions, .node-titlebar__color-picker, .archive-body')) return
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
      } else {
        onFocus(id)
      }
    }

    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
  }

  return (
    <CardShell
      nodeId={id}
      x={x - currentWidth / 2}
      y={y - currentHeight / 2}
      width={currentWidth}
      height={currentHeight}
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
      className={`image-card ${focused ? 'image-card--focused' : selected ? 'image-card--selected' : ''}`}
      style={{ backgroundColor: 'transparent' }}
      onMouseEnter={() => { if (reparentingNodeId) useReparentStore.getState().setHoveredNode(id) }}
      onMouseLeave={() => { if (reparentingNodeId) useReparentStore.getState().setHoveredNode(null) }}
    >
      <img
        className="image-card__img"
        src={`spaceterm-file://${filePath}`}
        onLoad={handleImageLoad}
        draggable={false}
        style={{
          width: currentWidth,
          height: currentHeight,
          objectFit: 'fill',
          display: 'block',
        }}
      />
    </CardShell>
  )
}
