import type { ServerState, ArchivedNode, ArchivedDescendant } from '../shared/state'

/**
 * TEMPORARY — delete this file and its one call in `StateManager` once the
 * operator's server has restarted on it.
 *
 * The stamp card type was removed, but archives written while it existed still
 * hold stamp entries, and restoring one would hand the renderer a node type it
 * cannot draw. Drops them in place and returns how many went.
 */
export function stripArchivedStamps(state: ServerState): number {
  let removed = 0
  const isStamp = (data: { type: string }) => data.type === 'stamp'

  // Declarations, not arrows: the two recurse into each other. Missing arrays
  // are left missing — hand-built states and fixtures omit them.
  function entries(list: ArchivedNode[] | undefined): ArchivedNode[] | undefined {
    return list?.filter((e) => {
      if (isStamp(e.data)) { removed++; return false }
      e.data.archivedChildren = entries(e.data.archivedChildren)!
      e.descendants = descendants(e.descendants)
      return true
    })
  }

  function descendants(list: ArchivedDescendant[] | undefined): ArchivedDescendant[] | undefined {
    return list?.filter((d) => {
      if (isStamp(d.data)) { removed++; return false }
      d.data.archivedChildren = entries(d.data.archivedChildren)!
      d.descendants = descendants(d.descendants)!
      return true
    })
  }

  for (const node of Object.values(state.nodes)) node.archivedChildren = entries(node.archivedChildren)!
  state.rootArchivedChildren = entries(state.rootArchivedChildren)!
  return removed
}
