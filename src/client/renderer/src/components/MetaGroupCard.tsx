import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { TITLE_HEIGHT, TITLE_H_PADDING, TITLE_MIN_WIDTH } from '../lib/constants'
import type { ColorPreset } from '../lib/color-presets'
import { cardSurfaceColor } from '../lib/color-presets'
import type { Camera } from '../lib/camera'
import type { ArchivedNode } from '../../../../shared/state'
import { CardShell } from './CardShell'
import { useReparentStore } from '../stores/reparentStore'
import { type NodeId } from '../../../../shared/ids'

const DRAG_THRESHOLD = 5

interface MetaGroupCardProps {
  id: NodeId
  x: number
  y: number
  zIndex: number
  zoom: number
  label: string
  sourcePath: string
  focused: boolean
  selected: boolean
  resolvedPreset?: ColorPreset
  archivedChildren: ArchivedNode[]
  onFocus: (id: NodeId) => void
  onMove: (id: NodeId, x: number, y: number, metaKey?: boolean, shiftKey?: boolean) => void
  onRescan: (id: NodeId) => void
  onNodeReady?: (nodeId: NodeId, bounds: { x: number; y: number; width: number; height: number }) => void
  onDragStart?: (id: NodeId, solo?: boolean, ctrlAtStart?: boolean, shiftAtStart?: boolean) => void
  onDragEnd?: (id: NodeId) => void
  cameraRef: React.MutableRefObject<Camera>
}

/**
 * The header of a generated agent-meta branch.
 *
 * Shaped like a title card and deliberately not one. Its text is derived from
 * the filesystem, so there is nothing to edit; it is a view, so there is nothing
 * to close; and it has no colour of its own because there is nowhere to keep one
 * — `MetaHostEntry` remembers positions, not appearance, and silently discarding
 * a colour on restart would be worse than not offering it.
 *
 * What clicking it does instead of opening an editor is rescan, which is the
 * affordance that matters: the directory watcher covers the ordinary cases, and
 * this covers the ones it cannot see.
 */
export function MetaGroupCard({
  id, x, y, zIndex, label, sourcePath, focused, selected, resolvedPreset, archivedChildren,
  onFocus, onMove, onRescan, onNodeReady, onDragStart, onDragEnd, cameraRef
}: MetaGroupCardProps) {
  const preset = resolvedPreset
  const measureRef = useRef<HTMLSpanElement>(null)
  const [textWidth, setTextWidth] = useState(0)
  const propsRef = useRef({ x, y, id })
  propsRef.current = { x, y, id }
  const reparentingNodeId = useReparentStore(s => s.reparentingNodeId)

  useLayoutEffect(() => {
    if (!measureRef.current) return
    measureRef.current.textContent = label || 'Agent Meta'
    setTextWidth(measureRef.current.offsetWidth)
  }, [label])

  const cardWidth = Math.max(TITLE_MIN_WIDTH, textWidth + TITLE_H_PADDING)
  const cardHeight = TITLE_HEIGHT

  useEffect(() => {
    if (!focused) return
    onNodeReady?.(id, { x: x - cardWidth / 2, y: y - cardHeight / 2, width: cardWidth, height: cardHeight })
  }, [focused, id, x, y, cardWidth, cardHeight, onNodeReady])

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
      } else if (focused) {
        onRescan(id)
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
      x={x - cardWidth / 2}
      y={y - cardHeight / 2}
      width={cardWidth}
      height={cardHeight}
      zIndex={zIndex}
      focused={focused}
      headVariant="overlay"
      // A view of the filesystem: there is nothing here to archive, and nothing
      // may be parented to it — a real node hanging off a generated card would
      // be orphaned the moment the branch closed.
      showClose={false}
      showColorPicker={false}
      archivedChildren={archivedChildren}
      onClose={() => {}}
      onColorChange={() => {}}
      onOpenArchiveSearch={() => {}}
      onMouseDown={handleMouseDown}
      isReparenting={reparentingNodeId === id}
      className={`meta-group-card ${focused ? 'meta-group-card--focused' : selected ? 'meta-group-card--selected' : ''}`}
      style={{
        backgroundColor: cardSurfaceColor(preset),
        '--title-fg': preset?.titleBarBg ?? '#a66cff',
      } as React.CSSProperties}
    >
      <div className="meta-group-card__body" title={`${sourcePath}\nClick to rescan`}>
        <span ref={measureRef} className="meta-group-card__measure" />
        <div className="meta-group-card__label">{label}</div>
      </div>
    </CardShell>
  )
}
