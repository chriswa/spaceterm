import type { NodeData } from './state'
import { ROOT_NODE_ID, type NodeId } from './ids'

/**
 * Walking a node's parent chain.
 *
 * Four places did this — the ancestor prompt, the inherited cwd, the nearest
 * terminal ancestor, and the script API's ancestor list — and all four wrote
 * the same loop: a `visited` set to survive a cycle, a `!node` break for a
 * dangling parent, and a stop at the root. Three of the four spelled `'root'`
 * as a bare string rather than using `ROOT_NODE_ID`, which is the kind of
 * duplication `ROOT_NODE_ID` exists to prevent.
 *
 * The cycle guard is not defensive programming for its own sake. `parentId` is
 * set from client messages and read back from a state file that survives
 * crashes, and one of the four consumers is the script API — reachable by any
 * mod. An unguarded walk on a malformed graph does not corrupt anything; it
 * hangs the server.
 */

/** How a node's parent is found. A plain record or a live lookup both fit. */
export type NodeLookup = (nodeId: NodeId) => NodeData | undefined

/** Adapt a nodes record to a lookup. */
export function lookupIn(nodes: Record<string, NodeData>): NodeLookup {
  return (nodeId) => nodes[nodeId]
}

/**
 * Yield `startId`'s ancestors, nearest first, stopping at the root.
 *
 * Terminates on a `parentId` cycle by refusing to visit a node twice, and on a
 * dangling parent by stopping there — a partial chain is a better answer than
 * a thrown exception in a path that runs during startup reconciliation.
 *
 * `startId` itself is yielded only when `includeSelf` is set. Both callers
 * exist: "what context does this node inherit" includes the node, "what is my
 * nearest terminal ancestor" does not.
 */
export function* ancestorsOf(
  lookup: NodeLookup,
  startId: NodeId,
  { includeSelf = false }: { includeSelf?: boolean } = {}
): Generator<NodeData> {
  const visited = new Set<NodeId>()
  let currentId: NodeId = startId

  if (!includeSelf) {
    const start = lookup(startId)
    if (!start) return
    // Seed the guard with the starting node, so a cycle back through it stops
    // rather than reporting it as its own ancestor.
    visited.add(startId)
    currentId = start.parentId
  }

  while (currentId && currentId !== ROOT_NODE_ID && !visited.has(currentId)) {
    visited.add(currentId)
    const node = lookup(currentId)
    if (!node) return
    yield node
    currentId = node.parentId
  }
}

/** The first ancestor satisfying `predicate`, or undefined. */
export function findAncestor(
  lookup: NodeLookup,
  startId: NodeId,
  predicate: (node: NodeData) => boolean,
  options?: { includeSelf?: boolean }
): NodeData | undefined {
  for (const node of ancestorsOf(lookup, startId, options)) {
    if (predicate(node)) return node
  }
  return undefined
}
