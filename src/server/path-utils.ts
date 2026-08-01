import * as path from 'path'
import { homedir } from 'os'
import type { NodeData } from '../shared/state'
import type { NodeId } from '../shared/ids'
import { findAncestor, lookupIn } from '../shared/node-ancestry'

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
export function getAncestorCwd(nodes: Record<string, NodeData>, nodeId: NodeId): string | undefined {
  const withCwd = findAncestor(
    lookupIn(nodes),
    nodeId,
    (node) => (node.type === 'terminal' || node.type === 'directory') && !!node.cwd,
    { includeSelf: true }
  )
  return withCwd && 'cwd' in withCwd ? withCwd.cwd : undefined
}
