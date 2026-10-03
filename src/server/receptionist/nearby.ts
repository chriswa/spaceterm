import type { CameraBounds } from '../../shared/protocol'
import type { NodeData } from '../../shared/state'
import type { NodeId } from '../../shared/ids'
import { measureCard } from '../../shared/card-types'
import { nodeLabelText } from '../../shared/node-label'

/**
 * What the user is looking at: the nodes nearest the middle of their screen.
 *
 * So "what's this one doing?" and "tell the one I'm looking at to stop" can
 * mean something. Any node can be nearest — a note, a title, a directory, a
 * plain terminal — not only an agent, so each comes back with what it is and
 * the receptionist decides what it can do with it.
 *
 * Cards are centre-anchored (`node.x`, `node.y` is the middle), and distance is
 * to the card's edge, not its middle, so a big card the screen is centred
 * inside of is at distance zero.
 */

export interface NearbyNode {
  nodeId: NodeId
  /** `terminal`, `markdown`, `title`, `directory`, `file`, … as the node is typed. */
  type: NodeData['type']
  /** What the node is called, or says, if anything. */
  label?: string
  /** World units from the middle of the screen to the card's nearest edge. */
  distance: number
  /** The card overlaps the visible area. */
  inView: boolean
}

/** How many nodes `nearby` reports. */
export const NEARBY_LIMIT = 6
const LABEL_CHARS = 80

export function nodesNearView(nodes: readonly NodeData[], view: CameraBounds, limit = NEARBY_LIMIT): NearbyNode[] {
  const cx = view.x + view.width / 2
  const cy = view.y + view.height / 2
  return nodes.map((node) => {
    const { width, height } = measureCard(node)
    const left = node.x - width / 2, right = node.x + width / 2
    const top = node.y - height / 2, bottom = node.y + height / 2
    const dx = Math.max(left - cx, 0, cx - right)
    const dy = Math.max(top - cy, 0, cy - bottom)
    const inView = right >= view.x && left <= view.x + view.width && bottom >= view.y && top <= view.y + view.height
    const label = labelOf(node)
    return { nodeId: node.id, type: node.type, ...(label ? { label } : {}), distance: Math.hypot(dx, dy), inView }
  })
    .sort((a, b) => a.distance - b.distance)
    .slice(0, limit)
}

function labelOf(node: NodeData): string | undefined {
  const text = nodeLabelText(node)
    ?? (node.type === 'title' ? node.text
      : node.type === 'directory' ? node.cwd
        : node.type === 'file' ? node.filePath
          : undefined)
  const flat = text?.replace(/\s+/g, ' ').trim()
  if (!flat) return undefined
  return flat.length <= LABEL_CHARS ? flat : `${flat.slice(0, LABEL_CHARS - 1)}…`
}

/** Where a node sits relative to the screen, in words. */
export function whereWords(node: NearbyNode, view: CameraBounds): string {
  if (node.distance === 0) return 'under the middle of the screen'
  if (node.inView) return 'on screen'
  const screens = Math.round(node.distance / Math.max(view.width, view.height))
  if (screens < 1) return 'just off screen'
  return `off screen, about ${screens} screen${screens === 1 ? '' : 's'} away`
}
