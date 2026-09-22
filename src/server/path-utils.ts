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
 *
 * `rootCwd` is what the walk answers with when it reaches the root without
 * finding one — `ServerState.rootCwd`, the default the user set on the root
 * node. Passing it here rather than at each launch site is what makes one
 * setting cover agent launches, new directory cards and file-path resolution;
 * omitting it is the "no default" case and behaves as before.
 */
export function getAncestorCwd(
  nodes: Record<string, NodeData>,
  nodeId: NodeId,
  rootCwd?: string
): string | undefined {
  const withCwd = findAncestor(
    lookupIn(nodes),
    nodeId,
    (node) => (node.type === 'terminal' || node.type === 'directory') && !!node.cwd,
    { includeSelf: true }
  )
  if (withCwd && 'cwd' in withCwd) return withCwd.cwd
  return rootCwd
}
