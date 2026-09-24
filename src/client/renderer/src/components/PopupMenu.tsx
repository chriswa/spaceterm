import { useEffect, useRef, type ReactNode } from 'react'

interface PopupMenuProps {
  screenX: number
  screenY: number
  header: string
  onDismiss: () => void
  children: ReactNode
}

/**
 * A titled menu centred on a screen point, for Cmd+click on the canvas.
 * Dismissed by a click outside it, the wheel, or Escape.
 */
export function PopupMenu({ screenX, screenY, header, onDismiss, children }: PopupMenuProps) {
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) onDismiss()
    }
    const onWheel = () => onDismiss()
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      onDismiss()
    }
    document.addEventListener('mousedown', onMouseDown, { capture: true })
    window.addEventListener('wheel', onWheel, { capture: true, passive: true })
    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => {
      document.removeEventListener('mousedown', onMouseDown, { capture: true })
      window.removeEventListener('wheel', onWheel, { capture: true })
      window.removeEventListener('keydown', onKeyDown, { capture: true })
    }
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
      <div className="edge-split-menu__header">{header}</div>
      {children}
    </div>
  )
}
