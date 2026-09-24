import { useEffect, useRef } from 'react'
import { STAMP_SIZE } from '../../../../shared/node-size'
import type { StampKind } from '../../../../shared/stamps'
import type { ColorPreset } from '../lib/color-presets'
import type { Camera } from '../lib/camera'
import type { ArchivedNode } from '../../../../shared/state'
import { CardShell } from './CardShell'
import { StampArt } from './StampArt'
import { useReparentStore } from '../stores/reparentStore'
import { type NodeId } from '../../../../shared/ids'

const DRAG_THRESHOLD = 5
const noop = () => {}

interface StampCardProps {
  id: NodeId
  x: number
  y: number
  zIndex: number
  stamp: StampKind
  focused: boolean
  selected: boolean
  resolvedPreset?: ColorPreset
  archivedChildren: ArchivedNode[]
  onFocus: (id: NodeId) => void
  onClose: (id: NodeId) => void
  onMove: (id: NodeId, x: number, y: number, metaKey?: boolean, shiftKey?: boolean) => void
  onOpenArchiveSearch: (nodeId: NodeId) => void
  onNodeReady?: (nodeId: NodeId, bounds: { x: number; y: number; width: number; height: number }) => void
  onDragStart?: (id: NodeId, solo?: boolean, ctrlAtStart?: boolean, shiftAtStart?: boolean) => void
  onDragEnd?: (id: NodeId) => void
  onStartReparent?: (id: NodeId) => void
  onReparentTarget?: (id: NodeId) => void
  cameraRef: React.MutableRefObject<Camera>
}

/**
 * A stamp on the canvas.
 *
 * Only the painted glyph takes the pointer (`card-shell--painted-hit`), so a
 * stamp dropped over a card never swallows a click aimed at the card. It has
 * no add-child button and no colour picker: stamps are leaves and their colour
 * is the glyph's own.
 */
export function StampCard({
  id, x, y, zIndex, stamp, focused, selected, resolvedPreset, archivedChildren,
  onFocus, onClose, onMove, onOpenArchiveSearch, onNodeReady,
  onDragStart, onDragEnd, onStartReparent, onReparentTarget, cameraRef
}: StampCardProps) {
  const propsRef = useRef({ x, y })
  propsRef.current = { x, y }
  const reparentingNodeId = useReparentStore(s => s.reparentingNodeId)

  useEffect(() => {
    if (!focused) return
    onNodeReady?.(id, { x: x - STAMP_SIZE / 2, y: y - STAMP_SIZE / 2, width: STAMP_SIZE, height: STAMP_SIZE })
  }, [focused, id, x, y, onNodeReady])

  const handleMouseDown = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('.node-titlebar__actions, .archive-body')) return
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
        onMove(id, startX + dx / currentZoom, startY + dy / currentZoom, ev.metaKey, ev.shiftKey)
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
      x={x - STAMP_SIZE / 2}
      y={y - STAMP_SIZE / 2}
      width={STAMP_SIZE}
      height={STAMP_SIZE}
      zIndex={zIndex}
      focused={focused}
      headVariant="overlay"
      hitTest="painted"
      preset={resolvedPreset}
      showColorPicker={false}
      archivedChildren={archivedChildren}
      onClose={onClose}
      onColorChange={noop}
      onOpenArchiveSearch={onOpenArchiveSearch}
      onMouseDown={handleMouseDown}
      onStartReparent={onStartReparent}
      isReparenting={reparentingNodeId === id}
      className={`stamp-card${focused ? ' stamp-card--focused' : selected ? ' stamp-card--selected' : ''}`}
      onMouseEnter={() => { if (reparentingNodeId) useReparentStore.getState().setHoveredNode(id) }}
      onMouseLeave={() => { if (reparentingNodeId) useReparentStore.getState().setHoveredNode(null) }}
    >
      <StampArt kind={stamp} size="100%" />
    </CardShell>
  )
}
