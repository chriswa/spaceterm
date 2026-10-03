import { useEffect, useLayoutEffect, useRef } from 'react'
import { buttonsPerRow, EDGE_PAD, shiftIntoView } from '../lib/floating-layout'
import type { ColorPreset } from '../lib/color-presets'
import { nodeActionRegistry } from '../lib/action-registry'
import { NodeActionBar } from './NodeActionBar'
import type { NodeId } from '../../../../shared/ids'

interface FloatingToolbarProps {
  nodeId: NodeId
  screenX: number
  screenY: number
  preset: ColorPreset
  onDismiss: () => void
  /**
   * Opened by a long press, so the finger that opened it is still down,
   * right over the middle of it. Its release must not choose a button.
   */
  openedByTouch?: boolean
}

export function FloatingToolbar({ nodeId, screenX, screenY, preset, onDismiss, openedByTouch = false }: FloatingToolbarProps) {
  const containerRef = useRef<HTMLDivElement>(null)

  // Lifting the finger that opened this makes a click wherever it lifts, and
  // iOS does not reliably let that click be cancelled. So until a new touch
  // begins, every click here is that one, and is swallowed.
  const armedRef = useRef(!openedByTouch)
  useEffect(() => {
    if (armedRef.current) return
    const arm = () => { armedRef.current = true }
    window.addEventListener('touchstart', arm, { capture: true, passive: true })
    return () => window.removeEventListener('touchstart', arm, { capture: true })
  }, [])

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

  // Whole on screen, wherever the press was: centred on it, wrapped into
  // even rows if one row is wider than the window, then moved in from any
  // edge it crosses. Measured as drawn — the phone enlarges the bar with CSS
  // `scale` — and before the first paint, so it never visibly jumps.
  useLayoutEffect(() => {
    const el = containerRef.current
    if (!el) return
    const actions = el.querySelector<HTMLElement>('.node-titlebar__actions')
    el.style.left = `${screenX}px`
    el.style.top = `${screenY}px`
    if (actions) {
      actions.style.display = ''
      actions.style.gridTemplateColumns = ''
      // Both on-screen widths, so the enlargement cancels out.
      const drawn = el.getBoundingClientRect().width
      const perRow = buttonsPerRow(actions.children.length, drawn, window.innerWidth - 2 * EDGE_PAD)
      if (perRow !== null) {
        actions.style.display = 'grid'
        actions.style.gridTemplateColumns = `repeat(${perRow}, auto)`
      }
    }
    const box = el.getBoundingClientRect()
    el.style.left = `${screenX + shiftIntoView(box.left, box.right, window.innerWidth)}px`
    el.style.top = `${screenY + shiftIntoView(box.top, box.bottom, window.innerHeight)}px`
  }, [nodeId, screenX, screenY])

  const registeredProps = nodeActionRegistry.get(nodeId)
  if (!registeredProps) return null

  return (
    <div
      ref={containerRef}
      className="floating-toolbar"
      style={{
        transform: 'translate(-50%, -50%)',
        background: preset.titleBarBg,
      }}
      onMouseDown={(e) => e.stopPropagation()}
      onClickCapture={(e) => {
        if (armedRef.current) return
        e.preventDefault()
        e.stopPropagation()
      }}
    >
      <NodeActionBar
        {...registeredProps}
        preset={preset}
        variant="floating"
        onActionInvoked={onDismiss}
      />
    </div>
  )
}
