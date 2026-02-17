import * as path from 'path'
import { homedir } from 'os'
import type { NodeData } from '../shared/state'

/**
 * Expand `~` and resolve relative paths against an optional cwd.
 * Returns an absolute path.
 */
export function resolveFilePath(rawPath: string, cwd?: string): string {
  let resolved = rawPath
  if (resolved.startsWith('~')) {
    resolved = path.join(homedir(), resolved.slice(1))
  }
  if (!path.isAbsolute(resolved) && cwd) {
    let expandedCwd = cwd
    if (expandedCwd.startsWith('~')) {
      expandedCwd = path.join(homedir(), expandedCwd.slice(1))
    }
    resolved = path.resolve(expandedCwd, resolved)
  }
  return resolved
}

/**
 * Walk the parentId chain to find an ancestor with a cwd
 * (terminal or directory node). Mirrors client-side `getAncestorCwd`.
 */
export function getAncestorCwd(nodes: Record<string, NodeData>, nodeId: string): string | undefined {
  let currentId = nodeId
  const visited = new Set<string>()
  while (currentId && currentId !== 'root') {
    if (visited.has(currentId)) break
    visited.add(currentId)
    const node = nodes[currentId]
    if (!node) break
    if (node.type === 'terminal' && node.cwd) return node.cwd
    if (node.type === 'directory' && node.cwd) return node.cwd
    currentId = node.parentId
  }
  return undefined
}
