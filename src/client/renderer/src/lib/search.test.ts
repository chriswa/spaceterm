import { describe, it, expect } from 'vitest'
import { buildSearchableEntries, type SearchEntry } from './search'
import { DEFAULT_PRESET } from './color-presets'
import type { ArchivedDescendant, ArchivedNode, NodeData } from '../../../../shared/state'
import { asNodeId, ROOT_NODE_ID, type NodeId } from '../../../../shared/ids'

const nid = (s: string) => asNodeId(s)

function node(id: string, parentId: NodeId = ROOT_NODE_ID, archivedChildren: ArchivedNode[] = []): NodeData {
  return {
    type: 'title', id: nid(id), parentId, x: 0, y: 0, zIndex: 0,
    archivedChildren, text: id
  } as NodeData
}

function member(id: string, parentId: string, descendants: ArchivedDescendant[] = [], archived: ArchivedNode[] = []): ArchivedDescendant {
  return { data: node(id, nid(parentId), archived), descendants }
}

function entry(id: string, parentId: NodeId, descendants: ArchivedDescendant[] = [], archived: ArchivedNode[] = []): ArchivedNode {
  return { archivedAt: '2026-09-09T00:00:00.000Z', data: node(id, parentId, archived), descendants }
}

/** Index a host node's archive and return the results by node id. */
function index(hostId: string, archives: ArchivedNode[]): Map<string, SearchEntry> {
  const host = node(hostId)
  host.archivedChildren = archives
  const entries = buildSearchableEntries(
    { [hostId]: host }, [], { [hostId]: DEFAULT_PRESET }, { kind: 'archived-children', parentId: hostId }
  )
  return new Map(entries.map((e) => [e.data.id, e]))
}

describe('archived search results', () => {
  it('names an entry by a path a restore can act on', () => {
    const results = index('host', [entry('solo', nid('host'))])
    expect(results.get('solo')?.restorePath).toEqual(['solo'])
    expect(results.get('solo')?.restoreCount).toBe(1)
  })

  it('finds a card buried inside an archived subtree', () => {
    const results = index('host', [entry('grp', nid('host'), [member('buried', 'grp')])])
    expect(results.has('buried')).toBe(true)
  })

  it('routes a group member to the entry that restores it', () => {
    const results = index('host', [entry('grp', nid('host'), [member('buried', 'grp')])])
    const buried = results.get('buried')!

    // Clicking the member restores the group, not the member alone.
    expect(buried.restorePath).toEqual(['grp'])
    expect(buried.isGroupMember).toBe(true)
    expect(buried.restoreCount).toBe(2)
  })

  it('says how many cards a restore brings back', () => {
    const results = index('host', [
      entry('grp', nid('host'), [member('a', 'grp', [member('b', 'a')]), member('c', 'grp')])
    ])
    expect(results.get('grp')?.restoreCount).toBe(4)
  })

  it('gives an entry buried under an archived subtree the full path to itself', () => {
    // `deep` was archived under `a`, and `a` was later swept into `grp`'s group.
    // Naming it by its own id alone is what used to make reviving it a no-op.
    const results = index('host', [
      entry('grp', nid('host'), [member('a', 'grp', [], [entry('deep', nid('a'))])])
    ])
    expect(results.get('deep')?.restorePath).toEqual(['grp', 'deep'])
    expect(results.get('deep')?.isGroupMember).toBeUndefined()
  })

  it('gives a nested archive its chain, not just its own id', () => {
    const results = index('host', [entry('outer', nid('host'), [], [entry('inner', nid('outer'))])])
    expect(results.get('inner')?.restorePath).toEqual(['outer', 'inner'])
  })

  it('tags group members with the entry they came down with, for the breadcrumb box', () => {
    const results = index('host', [
      entry('grp', nid('host'), [member('a', 'grp', [member('b', 'a')])])
    ])
    // The live host, then `grp` and `a` — the two that came down together.
    expect(results.get('b')?.ancestors.map((x) => [x.data.id, x.groupRootId]))
      .toEqual([['host', undefined], ['grp', 'grp'], ['a', 'grp']])
  })

  it('does not box a card archived on its own', () => {
    const results = index('host', [entry('outer', nid('host'), [], [entry('inner', nid('outer'))])])
    expect(results.get('inner')?.ancestors.map((x) => x.groupRootId)).toEqual([undefined, undefined])
  })
})
