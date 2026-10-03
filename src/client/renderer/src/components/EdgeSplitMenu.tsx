import { useRef } from 'react'
import { AddNodeBody, type AddNodeType } from './AddNodeBody'
import { usePressPopup } from '../hooks/usePressPopup'

interface EdgeSplitMenuProps {
  screenX: number
  screenY: number
  onSelect: (type: AddNodeType) => void
  onDismiss: () => void
  /** Opened by a long press on the edge, whose release must not pick a type. */
  openedByTouch?: boolean
}

export function EdgeSplitMenu({ screenX, screenY, onSelect, onDismiss, openedByTouch = false }: EdgeSplitMenuProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const guardClick = usePressPopup(containerRef, { screenX, screenY, openedByTouch, onDismiss })

  return (
    <div
      ref={containerRef}
      className="edge-split-menu"
      onMouseDown={(e) => e.stopPropagation()}
      onClickCapture={guardClick}
    >
      <div className="edge-split-menu__header">Add child node</div>
      <AddNodeBody onSelect={onSelect} />
    </div>
  )
}
