import { homedir } from 'os'
import type { AlertType, NodeAlert, NodeData, TerminalNodeData } from '../shared/state'
import type { NodeId } from '../shared/ids'
import { expandTilde } from './cwd'
import { getAncestorCwd } from './path-utils'

/**
 * The cwd-mismatch alert engine.
 *
 * An agent surface inherits a working directory from its nearest ancestor with
 * one. If the agent then `cd`s somewhere else, the surface's position on the
 * canvas stops describing where it is actually working — which is worth telling
 * the user about, because the canvas layout is the mental model.
 *
 * Extracted from StateManager, where it was the last remaining tenant: it is
 * about paths and alerts, not about owning state, and being a pure function of
 * the node graph is what makes it testable. StateManager applies what these
 * return.
 */

const CWD_MISMATCH: AlertType = 'cwd-mismatch'

/**
 * Normalize a path for comparison: expand `~` and strip a trailing slash.
 *
 * The `~` expansion is load-bearing. Before it was added, a surface whose cwd
 * was stored as `~/project` never compared equal to an ancestor's
 * `/Users/me/project`, so every such surface carried a permanent false alert —
 * enough of them that the fix shipped alongside a one-time wipe of all stored
 * alerts (now migration 1 → 2 in state-migrations.ts).
 */
export function normalizeCwd(p: string): string {
  let out = expandTilde(p) ?? p
  if (out.length > 1 && out.endsWith('/')) out = out.slice(0, -1)
  return out
}

/** Abbreviate a path with `~` for the home directory, for display. */
export function abbreviateCwd(p: string): string {
  const home = homedir()
  if (p === home) return '~'
  if (p.startsWith(home + '/')) return '~' + p.slice(home.length)
  return p
}

/**
 * The alert list a terminal should have, or null when it is already correct.
 *
 * `undefined` alerts means "no alerts at all", which is how an absent field is
 * represented on a node; an empty array would persist a meaningless key.
 */
export function evaluateCwdMismatch(
  nodes: Record<string, NodeData>,
  node: TerminalNodeData,
  now: number
): { alerts: NodeAlert[] | undefined } | null {
  // Only agent surfaces have a meaningful working directory to disagree about.
  if (node.claudeSessionHistory.length === 0) return null

  const parentCwd = getAncestorCwd(nodes, node.parentId)
  const alerts = node.alerts ?? []
  const existing = alerts.some((a) => a.type === CWD_MISMATCH)

  // Nothing to compare against — leave any existing alert alone rather than
  // clearing it on incomplete information.
  if (!parentCwd || !node.cwd) return null

  const mismatched = normalizeCwd(node.cwd) !== normalizeCwd(parentCwd)

  if (mismatched && !existing) {
    const message = `Working directory changed to ${abbreviateCwd(node.cwd)} (parent: ${abbreviateCwd(parentCwd)})`
    return { alerts: [...alerts, { type: CWD_MISMATCH, message, timestamp: now }] }
  }
  if (!mismatched && existing) {
    const remaining = alerts.filter((a) => a.type !== CWD_MISMATCH)
    return { alerts: remaining.length > 0 ? remaining : undefined }
  }
  return null
}

/** Every terminal in the graph whose cwd alert needs changing. */
export function scanCwdMismatches(
  nodes: Record<string, NodeData>,
  now: number
): Array<{ node: TerminalNodeData; alerts: NodeAlert[] | undefined }> {
  const changes: Array<{ node: TerminalNodeData; alerts: NodeAlert[] | undefined }> = []
  for (const node of Object.values(nodes)) {
    if (node.type !== 'terminal') continue
    const change = evaluateCwdMismatch(nodes, node, now)
    if (change) changes.push({ node, alerts: change.alerts })
  }
  return changes
}

/**
 * Every terminal at or below `rootId` whose cwd alert needs changing.
 *
 * Used when a directory's cwd changes: every surface that inherits from it has
 * to be re-evaluated, not just its immediate children.
 */
export function scanDescendantCwdMismatches(
  nodes: Record<string, NodeData>,
  rootId: NodeId,
  now: number
): Array<{ node: TerminalNodeData; alerts: NodeAlert[] | undefined }> {
  const changes: Array<{ node: TerminalNodeData; alerts: NodeAlert[] | undefined }> = []
  const queue: NodeId[] = [rootId]
  const visited = new Set<NodeId>()

  while (queue.length > 0) {
    const id = queue.shift()!
    if (visited.has(id)) continue
    visited.add(id)
    const node = nodes[id]
    if (!node) continue

    if (node.type === 'terminal') {
      const change = evaluateCwdMismatch(nodes, node, now)
      if (change) changes.push({ node, alerts: change.alerts })
    }

    for (const child of Object.values(nodes)) {
      if (child.parentId === id && !visited.has(child.id)) {
        queue.push(child.id)
      }
    }
  }
  return changes
}
