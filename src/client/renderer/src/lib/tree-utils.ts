import type { NodeData } from '../../../../shared/state'

/**
 * Check if `potentialAncestorId` is an ancestor of `nodeId` by walking up parentId links.
 * Used to prevent reparenting a node to itself or one of its descendants (which would create a cycle).
 */
export function isDescendantOf(
  nodes: Record<string, NodeData>,
  nodeId: string,
  potentialAncestorId: string
): boolean {
  let current = nodeId
  while (current && current !== 'root') {
    if (current === potentialAncestorId) return true
    const node = nodes[current]
    if (!node) return false
    current = node.parentId
  }
  return false
}
