import { useRef } from 'react'
import { buttonsPerRow, EDGE_PAD } from '../lib/floating-layout'
import { usePressPopup } from '../hooks/usePressPopup'
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

/**
 * Wrap the buttons into even rows when one row is wider than the window
 * (nine buttons: five and four, not eight and one). Widths compared as drawn,
 * so the phone's enlargement cancels out.
 */
function wrapButtons(el: HTMLElement): void {
  const actions = el.querySelector<HTMLElement>('.node-titlebar__actions')
  if (!actions) return
  actions.style.display = ''
  actions.style.gridTemplateColumns = ''
  const perRow = buttonsPerRow(actions.children.length, el.getBoundingClientRect().width, window.innerWidth - 2 * EDGE_PAD)
  if (perRow === null) return
  actions.style.display = 'grid'
  actions.style.gridTemplateColumns = `repeat(${perRow}, auto)`
}

export function FloatingToolbar({ nodeId, screenX, screenY, preset, onDismiss, openedByTouch = false }: FloatingToolbarProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const guardClick = usePressPopup(containerRef, { screenX, screenY, openedByTouch, onDismiss }, wrapButtons)

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
      onClickCapture={guardClick}
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
