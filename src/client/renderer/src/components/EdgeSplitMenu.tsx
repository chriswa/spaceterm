import { AddNodeBody, type AddNodeType } from './AddNodeBody'
import { PopupMenu } from './PopupMenu'

interface EdgeSplitMenuProps {
  screenX: number
  screenY: number
  onSelect: (type: AddNodeType) => void
  onDismiss: () => void
}

export function EdgeSplitMenu({ screenX, screenY, onSelect, onDismiss }: EdgeSplitMenuProps) {
  return (
    <PopupMenu screenX={screenX} screenY={screenY} header="Add child node" onDismiss={onDismiss}>
      <AddNodeBody onSelect={onSelect} includeStamps={false} />
    </PopupMenu>
  )
}
