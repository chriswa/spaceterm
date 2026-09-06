import type { CSSProperties } from 'react'
import type { NodeLabel } from '../lib/node-label'
import { DEFAULT_PRESET, type ColorPreset } from '../lib/color-presets'
import type { NodeId } from '../../../../shared/ids'

interface NodeLabelsProps {
  labels: readonly NodeLabel[]
  /** Inherited colour presets, keyed by node id — a label wears its node's colour. */
  resolvedPresets: Record<string, ColorPreset>
  /** "Dim stale nodes" brightness, so a label fades with the node that supplies it. */
  nodeBrightness: Map<NodeId, number>
  onLabelClick: (nodeId: NodeId) => void
}

/**
 * Captions drawn directly above each labelled node's card.
 *
 * Rendered as direct children of the canvas surface rather than inside a
 * wrapper, so each label competes with the cards on one z-index scale: every
 * card's z-index comes from the server's counter and starts at 1, so a label at
 * 0 sits under any card it happens to overlap and never steals its clicks.
 *
 * They carry `canvas-node` for the same reason cards do — it is how the
 * viewport tells its own background from anything drawn on top of it, and a
 * label must not start a pan, arm the edge-split indicator, or count as empty
 * space for a double-click. It deliberately carries no `data-node-id`: that
 * attribute means "this element *is* that node", which the cmd-click and flash
 * paths both rely on, and a label is a caption for one rather than the node.
 *
 * Clicking one navigates, but nothing about it says so — no cursor change, no
 * hover state. A caption that lit up under the pointer read as a control the
 * canvas was offering rather than as a name written on the canvas.
 */
export function NodeLabels({ labels, resolvedPresets, nodeBrightness, onLabelClick }: NodeLabelsProps) {
  return (
    <>
      {labels.map((label) => {
        const brightness = nodeBrightness.get(label.nodeId) ?? 1
        return (
          <div
            key={label.nodeId}
            className="node-label canvas-node"
            style={{
              left: label.x - label.width / 2,
              top: label.y - label.height / 2,
              width: label.width,
              height: label.height,
              '--node-label-fg': (resolvedPresets[label.nodeId] ?? DEFAULT_PRESET).titleBarBg,
              filter: brightness < 1 ? `brightness(${brightness})` : undefined
            } as CSSProperties}
            onClick={() => onLabelClick(label.nodeId)}
          >
            <span className="node-label__text">{label.lines.join('\n')}</span>
          </div>
        )
      })}
    </>
  )
}
