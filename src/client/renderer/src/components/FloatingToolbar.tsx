import { useEffect, useRef } from 'react'
import type { ColorPreset } from '../lib/color-presets'
import { nodeActionRegistry } from '../lib/action-registry'
import { NodeActionBar } from './NodeActionBar'

interface FloatingToolbarProps {
  nodeId: string
  screenX: number
  screenY: number
  preset: ColorPreset
  onDismiss: () => void
}

export function FloatingToolbar({ nodeId, screenX, screenY, preset, onDismiss }: FloatingToolbarProps) {
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

  const registeredProps = nodeActionRegistry.get(nodeId)
  if (!registeredProps) return null

  // Clamp position to viewport bounds
  const pad = 8
  const left = Math.max(pad, Math.min(screenX, window.innerWidth - pad))
  const top = Math.max(pad, Math.min(screenY, window.innerHeight - pad))

  return (
    <div
      ref={containerRef}
      className="floating-toolbar"
      style={{
        left,
        top,
        transform: 'translate(-50%, -50%)',
        background: preset.titleBarBg,
      }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <NodeActionBar
        {...registeredProps}
        variant="floating"
        onActionInvoked={onDismiss}
      />
    </div>
  )
}
