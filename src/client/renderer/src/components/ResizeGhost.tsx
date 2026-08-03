import { useNodeStore } from '../stores/nodeStore'
import { useResizeStore } from '../stores/resizeStore'
import { terminalPixelSize } from '../lib/constants'

/**
 * The preview drawn while a surface is being resized.
 *
 * Centre-anchored, like the card it stands for: a card is positioned at
 * `x - width/2`, so the outline grows away from the surface's centre in every
 * direction and the surface itself stays put underneath, at its current size,
 * as the reference for how much bigger this is going to be.
 *
 * It draws nothing but an outline and a readout — the snapshot behind it is the
 * real card, still rendering. That is also why it is a sibling of the cards in
 * the world layer rather than an overlay in screen space: it has to scale and
 * pan with them.
 */
export function ResizeGhost(): React.ReactElement | null {
  const resizingNodeId = useResizeStore(s => s.resizingNodeId)
  const draft = useResizeStore(s => s.draft)
  const node = useNodeStore(s => (resizingNodeId ? s.nodes[resizingNodeId] : undefined))

  if (!resizingNodeId || !node || node.type !== 'terminal') return null

  // Before the pointer has moved, stand exactly on the current size — so the
  // mode opens showing "this is what you have" rather than a jump.
  const cols = draft?.cols ?? node.cols
  const rows = draft?.rows ?? node.rows
  const { width, height } = terminalPixelSize(cols, rows)
  const grew = cols * rows >= node.cols * node.rows

  return (
    <div
      className="resize-ghost"
      style={{
        position: 'absolute',
        left: node.x - width / 2,
        top: node.y - height / 2,
        width,
        height,
        pointerEvents: 'none',
        zIndex: 10_000,
      }}
    >
      <div className={`resize-ghost__readout${grew ? '' : ' resize-ghost__readout--shrinking'}`}>
        {cols} × {rows}
      </div>
    </div>
  )
}
