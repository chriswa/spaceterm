import { describe, it, expect } from 'vitest'
import { groupNodes, groupNodesWithParent, groupSize, archivesOwnedBy, ownedArchiveLists } from './archive-tree'
import type { ArchivedDescendant, ArchivedNode, NodeData } from './state'
import { asNodeId, ROOT_NODE_ID, type NodeId } from './ids'

const nid = (s: string) => asNodeId(s)

/** A title node, the cheapest NodeData to construct. */
function node(id: string, parentId: NodeId = ROOT_NODE_ID, archivedChildren: ArchivedNode[] = []): NodeData {
  return {
    type: 'title', id: nid(id), parentId, x: 0, y: 0, zIndex: 0,
    archivedChildren, text: id
  } as NodeData
}

function member(id: string, parentId: string, descendants: ArchivedDescendant[] = [], archived: ArchivedNode[] = []): ArchivedDescendant {
  return { data: node(id, nid(parentId), archived), descendants }
}

function entry(id: string, descendants: ArchivedDescendant[] = [], archived: ArchivedNode[] = []): ArchivedNode {
  return { archivedAt: '2026-09-09T00:00:00.000Z', data: node(id, ROOT_NODE_ID, archived), descendants }
}

const idsOf = (gen: Iterable<NodeData>) => [...gen].map((n) => n.id)

describe('groupNodes', () => {
  it('yields the root first', () => {
    expect(idsOf(groupNodes(entry('root-entry')))[0]).toBe('root-entry')
  })

  it('yields the whole live subtree, depth first', () => {
    const tree = entry('a', [member('b', 'a', [member('c', 'b')]), member('d', 'a')])
    expect(idsOf(groupNodes(tree))).toEqual(['a', 'b', 'c', 'd'])
  })

  it('treats a missing descendants field as a lone leaf', () => {
    const legacy: ArchivedNode = { archivedAt: '2026-09-09T00:00:00.000Z', data: node('solo') }
    expect(idsOf(groupNodes(legacy))).toEqual(['solo'])
  })

  it('does not yield nodes that were already archived under the group', () => {
    const tree = entry('a', [member('b', 'a', [], [entry('buried')])], [entry('older')])
    expect(idsOf(groupNodes(tree))).toEqual(['a', 'b'])
  })
})

describe('groupNodesWithParent', () => {
  it('leaves the root parentless, because only the restorer knows where it lands', () => {
    const tree = entry('a', [member('b', 'a')])
    expect([...groupNodesWithParent(tree)][0].groupParentId).toBeUndefined()
  })

  it('reports each member under its in-group parent', () => {
    const tree = entry('a', [member('b', 'a', [member('c', 'b')]), member('d', 'a')])
    const pairs = [...groupNodesWithParent(tree)].map((m) => [m.data.id, m.groupParentId])
    expect(pairs).toEqual([['a', undefined], ['b', 'a'], ['c', 'b'], ['d', 'a']])
  })
})

describe('groupSize', () => {
  it('counts a lone entry as one card', () => {
    expect(groupSize(entry('a'))).toBe(1)
  })

  it('counts every live member', () => {
    expect(groupSize(entry('a', [member('b', 'a', [member('c', 'b')]), member('d', 'a')]))).toBe(4)
  })

  it('ignores archives owned by the group, which stay archived', () => {
    expect(groupSize(entry('a', [member('b', 'a', [], [entry('buried')])], [entry('older')]))).toBe(2)
  })
})

describe('archivesOwnedBy', () => {
  it('includes the root entry own archives', () => {
    expect(archivesOwnedBy(entry('a', [], [entry('older')])).map((e) => e.data.id)).toEqual(['older'])
  })

  it('includes archives held by group members, which a path hop must reach', () => {
    const tree = entry('a', [member('b', 'a', [], [entry('buried')])], [entry('older')])
    expect(archivesOwnedBy(tree).map((e) => e.data.id).sort()).toEqual(['buried', 'older'])
  })

  it('reaches archives nested arbitrarily deep in the group', () => {
    const tree = entry('a', [member('b', 'a', [member('c', 'b', [], [entry('deep')])])])
    expect(archivesOwnedBy(tree).map((e) => e.data.id)).toEqual(['deep'])
  })
})

describe('ownedArchiveLists', () => {
  it('hands back the actual arrays, so a caller can splice an entry out', () => {
    const buried = entry('buried')
    const tree = entry('a', [member('b', 'a', [], [buried])])
    const lists = ownedArchiveLists(tree)
    const holding = lists.find((l) => l.includes(buried))!
    holding.splice(holding.indexOf(buried), 1)
    expect(archivesOwnedBy(tree)).toEqual([])
  })
})
