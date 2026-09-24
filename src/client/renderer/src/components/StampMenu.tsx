import type { StampKind } from '../../../../shared/stamps'
import { AddNodeList, STAMP_ITEMS, isStampAddType, stampKindOf } from './AddNodeBody'
import { PopupMenu } from './PopupMenu'

interface StampMenuProps {
  screenX: number
  screenY: number
  onSelect: (kind: StampKind) => void
  onDismiss: () => void
}

/** The stamp picker Cmd+click on the canvas background opens. */
export function StampMenu({ screenX, screenY, onSelect, onDismiss }: StampMenuProps) {
  return (
    <PopupMenu screenX={screenX} screenY={screenY} header="Add stamp" onDismiss={onDismiss}>
      <AddNodeList
        items={STAMP_ITEMS}
        onSelect={(type) => { if (isStampAddType(type)) onSelect(stampKindOf(type)) }}
      />
    </PopupMenu>
  )
}
