import type { ArchivedNode, ArchivedDescendant, NodeData } from './state'
import type { NodeId } from './ids'

/**
 * Walking the two kinds of nesting an archive entry has.
 *
 * An entry owns a *group* — itself plus the live subtree that was swept in with
 * it — and separately owns *archives*, which are entries that were already
 * archived under any member of that group. Restoring the entry brings the whole
 * group back and leaves every owned archive archived.
 *
 * Both the server (restoring, addressing entries by path, resolving a deep
 * link) and the renderer (search indexing, restore counts) need these walks, so
 * they live here rather than being written twice with a subtle difference.
 */

/** An entry or one of its group members — anything that can own a subtree. */
type GroupHolder = ArchivedNode | ArchivedDescendant


function descendantsOf(holder: GroupHolder): ArchivedDescendant[] {
  return holder.descendants ?? []
}

/**
 * Every node restored when `entry` is restored, root first, depth-first.
 *
 * Yields the snapshots themselves, not copies: callers that mutate must copy.
 */
export function* groupNodes(entry: GroupHolder): Generator<NodeData> {
  yield entry.data
  for (const descendant of descendantsOf(entry)) {
    yield* groupNodes(descendant)
  }
}

/**
 * Every group member paired with the id of its parent inside the group. The
 * root pairs with `undefined` — its parent is whatever it is restored under,
 * which only the caller knows.
 */
export function* groupNodesWithParent(
  entry: GroupHolder
): Generator<{ data: NodeData; groupParentId: string | undefined }> {
  yield { data: entry.data, groupParentId: undefined }
  for (const descendant of descendantsOf(entry)) {
    for (const member of groupNodesWithParent(descendant)) {
      yield { data: member.data, groupParentId: member.groupParentId ?? entry.data.id }
    }
  }
}

/** How many cards come back when this entry is restored. Never less than 1. */
export function groupSize(entry: GroupHolder): number {
  let count = 1
  for (const descendant of descendantsOf(entry)) {
    count += groupSize(descendant)
  }
  return count
}

/**
 * The archive entries this group owns: the root's own `archivedChildren` plus
 * every group member's.
 *
 * This is the set a path hop searches. Without the group members' archives in
 * it, an entry that was archived under a node which later became part of an
 * archived subtree would be unreachable — findable in search, but impossible to
 * name in a restore request.
 *
 * `archivedChildren` is typed as required but defended anyway: snapshots
 * deep-copied under older state versions predate the field, and those entries
 * are still sitting in people's archives.
 */
export function archivesOwnedBy(entry: GroupHolder): ArchivedNode[] {
  const owned: ArchivedNode[] = [...entry.data.archivedChildren ?? []]
  for (const descendant of descendantsOf(entry)) {
    owned.push(...archivesOwnedBy(descendant))
  }
  return owned
}

/**
 * The array physically holding each owned archive, so a caller that finds an
 * entry can splice it out of the right place. Same order as
 * {@link archivesOwnedBy}.
 */
export function ownedArchiveLists(entry: GroupHolder): ArchivedNode[][] {
  const lists: ArchivedNode[][] = []
  if (entry.data.archivedChildren) lists.push(entry.data.archivedChildren)
  for (const descendant of descendantsOf(entry)) {
    lists.push(...ownedArchiveLists(descendant))
  }
  return lists
}

/**
 * Follow a path of entry ids — outermost first — from a host's archive list to
 * the entry it names, or undefined if any hop is missing.
 *
 * Each hop looks through everything the previous entry owns, group members'
 * archives included, which is what lets a path name an entry buried inside an
 * archived subtree. Read-only: the server has its own walk that also reports
 * the array holding the entry, because it has to splice.
 */
export function findArchiveEntry(hostArchives: ArchivedNode[], path: NodeId[]): ArchivedNode | undefined {
  let candidates = hostArchives
  let found: ArchivedNode | undefined
  for (const id of path) {
    found = candidates.find((entry) => entry.data.id === id)
    if (!found) return undefined
    candidates = archivesOwnedBy(found)
  }
  return found
}
