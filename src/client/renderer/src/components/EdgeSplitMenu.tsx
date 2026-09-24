import { useEffect, useRef } from 'react'
import { AddNodeBody, type AddNodeType } from './AddNodeBody'

interface EdgeSplitMenuProps {
  screenX: number
  screenY: number
  onSelect: (type: AddNodeType) => void
  onDismiss: () => void
}

export function EdgeSplitMenu({ screenX, screenY, onSelect, onDismiss }: EdgeSplitMenuProps) {
  const containerRef = useRef<HTMLDivElement>(null)

  // Dismiss on click outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        onDismiss()
      }
    }
    document.addEventListener('mousedown', handler, { capture: true })
    return () => document.removeEventListener('mousedown', handler, { capture: true })
  }, [onDismiss])

  // Dismiss on wheel/zoom
  useEffect(() => {
    const handler = () => onDismiss()
    window.addEventListener('wheel', handler, { capture: true, passive: true })
    return () => window.removeEventListener('wheel', handler, { capture: true })
  }, [onDismiss])

  // Dismiss on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onDismiss()
      }
    }
    window.addEventListener('keydown', handler, { capture: true })
    return () => window.removeEventListener('keydown', handler, { capture: true })
  }, [onDismiss])

  // Clamp position to viewport bounds
  const pad = 8
  const left = Math.max(pad, Math.min(screenX, window.innerWidth - pad))
  const top = Math.max(pad, Math.min(screenY, window.innerHeight - pad))

  return (
    <div
      ref={containerRef}
      className="edge-split-menu"
      style={{ left, top }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="edge-split-menu__header">Add child node</div>
      <AddNodeBody onSelect={onSelect} />
    </div>
  )
}
