import { useCallback } from 'react'
import { ROOT_NODE_RADIUS, ROOT_DISC_RADIUS, ROOT_DISC_INSET } from '../lib/constants'
import { useFacet } from '../hooks/useFacet'
import type { ArchivedNode } from '../../../../shared/state'
import { CardShell } from './CardShell'
import type { AddNodeType } from './AddNodeBody'
import { useReparentStore } from '../stores/reparentStore'
import { ROOT_NODE_ID, type NodeId } from '../../../../shared/ids'
const noop = () => {}

interface RootNodeProps {
  focused: boolean
  selected: boolean
  onClick: () => void
  archivedChildren: ArchivedNode[]
  onUnarchive: (parentNodeId: NodeId, archivedNodeId: NodeId) => void
  onArchiveDelete: (parentNodeId: NodeId, archivedNodeId: NodeId) => void
  onOpenArchiveSearch: (nodeId: NodeId) => void
  onAddNode?: (parentNodeId: NodeId, type: AddNodeType) => void
  onReparentTarget?: (id: NodeId) => void
}

/**
 * The card-shell__hidden-head-actions div (archive + add-node buttons) sits in
 * normal flow above the body-wrapper inside CardShell. The body-wrapper has
 * position:relative, so our absolutely-positioned circle is offset downward by
 * this height. We compensate with a negative top so the circle is centred on
 * the world origin.
 *   height = padding-top (4) + button (20) + padding-bottom (4) = 28
 * The row is enlarged by `--card-chrome-scale`, but with a transform, which
 * layout does not see — so this stays one number rather than two that have to
 * agree.
 */
const HIDDEN_ACTIONS_HEIGHT = 28

export function RootNode({ focused, selected, onClick, archivedChildren, onUnarchive, onArchiveDelete, onOpenArchiveSearch, onAddNode, onReparentTarget }: RootNodeProps) {
  const size = ROOT_NODE_RADIUS * 2
  const visualSize = ROOT_DISC_RADIUS * 2
  const { Component: RootNodeVisual } = useFacet('rootNode')
  const reparentingNodeId = useReparentStore(s => s.reparentingNodeId)
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      if (reparentingNodeId) {
        onReparentTarget?.(ROOT_NODE_ID)
      } else {
        onClick()
      }
    },
    [onClick, reparentingNodeId, onReparentTarget],
  )

  return (
    <CardShell
      nodeId={ROOT_NODE_ID}
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
      onOpenArchiveSearch={onOpenArchiveSearch}
      onAddNode={onAddNode}
      onMouseDown={handleMouseDown}
      onMouseEnter={() => { if (reparentingNodeId) useReparentStore.getState().setHoveredNode(ROOT_NODE_ID) }}
      onMouseLeave={() => { if (reparentingNodeId) useReparentStore.getState().setHoveredNode(null) }}
      className={`root-node${focused ? ' root-node--focused' : ''}`}
      style={{ background: 'transparent', border: 'none' }}
    >
      {/* The box is positioned here and filled by the `rootNode` facet, so a
          facet can be a CSS circle or a live WebGL canvas without either
          knowing where CardShell puts it. */}
      <div
        style={{
          position: 'absolute',
          left: ROOT_DISC_INSET,
          top: ROOT_DISC_INSET - HIDDEN_ACTIONS_HEIGHT,
          width: visualSize,
          height: visualSize,
          pointerEvents: 'none',
        }}
      >
        <RootNodeVisual size={visualSize} focused={focused} />
      </div>
    </CardShell>
  )
}
