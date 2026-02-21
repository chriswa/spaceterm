import { useCallback } from 'react'
import { ROOT_NODE_RADIUS } from '../lib/constants'
import type { ArchivedNode } from '../../../../shared/state'
import { CardShell } from './CardShell'
import type { AddNodeType } from './AddNodeBody'
import { useReparentStore } from '../stores/reparentStore'
const noop = () => {}

interface RootNodeProps {
  focused: boolean
  selected: boolean
  onClick: () => void
  archivedChildren: ArchivedNode[]
  onUnarchive: (parentNodeId: string, archivedNodeId: string) => void
  onArchiveDelete: (parentNodeId: string, archivedNodeId: string) => void
  onArchiveToggled: (nodeId: string, open: boolean) => void
  onAddNode?: (parentNodeId: string, type: AddNodeType) => void
  onReparentTarget?: (id: string) => void
}

/**
 * The card-shell__hidden-head-actions div (archive + add-node buttons) sits in
 * normal flow above the body-wrapper inside CardShell. The body-wrapper has
 * position:relative, so our absolutely-positioned circle is offset downward by
 * this height. We compensate with a negative top so the circle is centred on
 * the world origin.
 *   height = padding-top (4) + button (20) + padding-bottom (4) = 28
 */
const HIDDEN_ACTIONS_HEIGHT = 28

export function RootNode({ focused, selected, onClick, archivedChildren, onUnarchive, onArchiveDelete, onArchiveToggled, onAddNode, onReparentTarget }: RootNodeProps) {
  const size = ROOT_NODE_RADIUS * 2
  const reparentingNodeId = useReparentStore(s => s.reparentingNodeId)
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      if (reparentingNodeId) {
        onReparentTarget?.('root')
      } else {
        onClick()
      }
    },
    [onClick, reparentingNodeId, onReparentTarget],
  )

  return (
    <CardShell
      nodeId="root"
      x={-ROOT_NODE_RADIUS}
      y={-ROOT_NODE_RADIUS}
      width={size}
      height={size}
      zIndex={0}
      focused={focused}
      headVariant="hidden"
      showClose={false}
      showColorPicker={false}
      archivedChildren={archivedChildren}
      onClose={noop}
      onColorChange={noop}
      onUnarchive={onUnarchive}
      onArchiveDelete={onArchiveDelete}
      onArchiveToggled={onArchiveToggled}
      onAddNode={onAddNode}
      onMouseDown={handleMouseDown}
      onMouseEnter={() => { if (reparentingNodeId) useReparentStore.getState().setHoveredNode('root') }}
      onMouseLeave={() => { if (reparentingNodeId) useReparentStore.getState().setHoveredNode(null) }}
      className={`root-node${focused ? ' root-node--focused' : ''}`}
      style={{ background: 'transparent', border: 'none' }}
    >
      <div
        className="root-node__circle"
        style={{
          position: 'absolute',
          left: size * 0.15,
          top: size * 0.15 - HIDDEN_ACTIONS_HEIGHT,
          width: size * 0.7,
          height: size * 0.7,
          borderRadius: '50%',
          background: '#000',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          pointerEvents: 'none',
        }}
      >
        {focused && (
          <span
            style={{
              color: '#fff',
              fontSize: 22,
              fontWeight: 600,
              letterSpacing: '0.05em',
              userSelect: 'none',
            }}
          >
            root
          </span>
        )}
      </div>
    </CardShell>
  )
}
