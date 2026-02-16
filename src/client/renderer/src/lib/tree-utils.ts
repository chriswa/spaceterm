import type { NodeData } from '../../../../shared/state'
import { COLOR_PRESET_MAP, DEFAULT_PRESET } from './color-presets'
import type { ColorPreset } from './color-presets'

/**
 * Collect all descendant IDs of a given node (children, grandchildren, etc.) via BFS.
 * Does NOT include the node itself.
 */
export function getDescendantIds(
  nodes: Record<string, NodeData>,
  nodeId: string
): string[] {
  // Build parentId → childIds map
  const childrenMap = new Map<string, string[]>()
  for (const id in nodes) {
    const parentId = nodes[id].parentId
    let list = childrenMap.get(parentId)
    if (!list) {
      list = []
      childrenMap.set(parentId, list)
    }
    list.push(id)
  }

  // BFS from nodeId
  const result: string[] = []
  const queue = childrenMap.get(nodeId)
  if (!queue) return result
  const frontier = [...queue]
  while (frontier.length > 0) {
    const current = frontier.pop()!
    result.push(current)
    const children = childrenMap.get(current)
    if (children) {
      for (const child of children) {
        frontier.push(child)
      }
    }
  }
  return result
}

/**
 * Check if `potentialAncestorId` is an ancestor of `nodeId` by walking up parentId links.
 * Used to prevent reparenting a node to itself or one of its descendants (which would create a cycle).
 */
/**
 * Walk up the ancestor chain from `startNodeId`, returning the first CWD found.
 * Checks the live cwdMap (from PTY tracking) first, then static node data.
 */
export function getAncestorCwd(
  nodes: Record<string, NodeData>,
  startNodeId: string,
  cwdMap: Map<string, string>
): string | undefined {
  let current = startNodeId
  while (current && current !== 'root') {
    const node = nodes[current]
    if (!node) return undefined
    const cwd = cwdMap.get(current)
      ?? (node.type === 'terminal' ? node.cwd : undefined)
      ?? (node.type === 'directory' ? node.cwd : undefined)
    if (cwd) return cwd
    current = node.parentId
  }
  return undefined
}

/**
 * Walk up the ancestor chain resolving color inheritance.
 * Skips nodes whose colorPresetId is 'inherit' or missing.
 * Returns the first valid ColorPreset, falling back to DEFAULT_PRESET at the root.
 */
export function resolveInheritedPreset(
  nodes: Record<string, NodeData>,
  nodeId: string
): ColorPreset {
  let current = nodeId
  while (current && current !== 'root') {
    const node = nodes[current]
    if (!node) break
    if (node.colorPresetId && node.colorPresetId !== 'inherit') {
      const preset = COLOR_PRESET_MAP[node.colorPresetId]
      if (preset) return preset
    }
    current = node.parentId
  }
  return DEFAULT_PRESET
}

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
