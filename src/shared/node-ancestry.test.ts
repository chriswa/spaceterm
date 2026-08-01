import { describe, it, expect } from 'vitest'
import { ancestorsOf, findAncestor, lookupIn, type NodeLookup } from './node-ancestry'
import type { NodeData } from './state'
import { asNodeId, ROOT_NODE_ID, type NodeId } from './ids'

const nid = (s: string) => asNodeId(s)

/** A title node, which is the cheapest NodeData to construct. */
function node(id: string, parentId: NodeId = ROOT_NODE_ID): NodeData {
  return {
    type: 'title', id: nid(id), parentId, x: 0, y: 0, zIndex: 0,
    archivedChildren: [], text: id
  } as NodeData
}

/** Build a lookup from a chain `a -> b -> c` where each is the next's parent. */
function chain(...ids: string[]): NodeLookup {
  const nodes: Record<string, NodeData> = {}
  ids.forEach((id, i) => {
    nodes[id] = node(id, i + 1 < ids.length ? nid(ids[i + 1]) : ROOT_NODE_ID)
  })
  return lookupIn(nodes)
}

const idsOf = (gen: Iterable<NodeData>) => [...gen].map((n) => n.id)

describe('ancestorsOf', () => {
  it('yields ancestors nearest first', () => {
    expect(idsOf(ancestorsOf(chain('c', 'b', 'a'), nid('c')))).toEqual(['b', 'a'])
  })

  it('excludes the starting node by default', () => {
    expect(idsOf(ancestorsOf(chain('c', 'b', 'a'), nid('c')))).not.toContain('c')
  })

  it('includes it when asked', () => {
    expect(idsOf(ancestorsOf(chain('c', 'b', 'a'), nid('c'), { includeSelf: true }))).toEqual(['c', 'b', 'a'])
  })

  it('yields nothing for a top-level node', () => {
    expect(idsOf(ancestorsOf(chain('a'), nid('a')))).toEqual([])
  })

  it('yields only itself for a top-level node when including self', () => {
    expect(idsOf(ancestorsOf(chain('a'), nid('a'), { includeSelf: true }))).toEqual(['a'])
  })

  it('never yields the root, which is not a node', () => {
    expect(idsOf(ancestorsOf(chain('b', 'a'), nid('b')))).not.toContain(ROOT_NODE_ID)
  })

  describe('a malformed graph', () => {
    // parentId comes from client messages and from a state file that survives
    // crashes, and one consumer is the script API — reachable by any mod. An
    // unguarded walk here does not corrupt anything; it hangs the server.

    it('terminates on a two-node cycle', () => {
      const nodes = { a: node('a', nid('b')), b: node('b', nid('a')) }
      expect(idsOf(ancestorsOf(lookupIn(nodes), nid('a')))).toEqual(['b'])
    })

    it('terminates on a longer cycle', () => {
      const nodes = { a: node('a', nid('b')), b: node('b', nid('c')), c: node('c', nid('a')) }
      expect(idsOf(ancestorsOf(lookupIn(nodes), nid('a')))).toEqual(['b', 'c'])
    })

    it('does not report the starting node as its own ancestor', () => {
      // A cycle back through the start must stop there, not list it again.
      const nodes = { a: node('a', nid('b')), b: node('b', nid('a')) }
      expect(idsOf(ancestorsOf(lookupIn(nodes), nid('a')))).not.toContain('a')
    })

    it('handles a node that is its own parent', () => {
      const nodes = { a: node('a', nid('a')) }
      expect(idsOf(ancestorsOf(lookupIn(nodes), nid('a')))).toEqual([])
    })

    it('stops at a dangling parent rather than throwing', () => {
      // A partial chain is a better answer than an exception in a path that
      // runs during startup reconciliation.
      const nodes = { a: node('a', nid('gone')) }
      expect(idsOf(ancestorsOf(lookupIn(nodes), nid('a')))).toEqual([])
    })

    it('yields what it found before hitting a dangling parent', () => {
      const nodes = { a: node('a', nid('b')), b: node('b', nid('gone')) }
      expect(idsOf(ancestorsOf(lookupIn(nodes), nid('a')))).toEqual(['b'])
    })

    it('yields nothing for a node that does not exist', () => {
      expect(idsOf(ancestorsOf(lookupIn({}), nid('ghost')))).toEqual([])
      expect(idsOf(ancestorsOf(lookupIn({}), nid('ghost'), { includeSelf: true }))).toEqual([])
    })
  })

  it('is lazy — a consumer that stops early does not walk the rest', () => {
    const visited: NodeId[] = []
    const nodes: Record<string, NodeData> = {
      a: node('a', nid('b')), b: node('b', nid('c')), c: node('c', nid('d')), d: node('d')
    }
    const spying: NodeLookup = (id) => { visited.push(id); return nodes[id] }

    for (const _ of ancestorsOf(spying, nid('a'), { includeSelf: true })) break
    expect(visited).toEqual([nid('a')])
  })
})

describe('findAncestor', () => {
  it('returns the first match, nearest first', () => {
    const nodes: Record<string, NodeData> = {
      a: node('a', nid('b')), b: node('b', nid('c')), c: node('c')
    }
    expect(findAncestor(lookupIn(nodes), nid('a'), (n) => n.id !== nid('a'))?.id).toBe('b')
  })

  it('returns undefined when nothing matches', () => {
    expect(findAncestor(chain('b', 'a'), nid('b'), () => false)).toBeUndefined()
  })

  it('can match the starting node when including self', () => {
    expect(findAncestor(chain('a'), nid('a'), () => true, { includeSelf: true })?.id).toBe('a')
  })

  it('skips the starting node by default even if it matches', () => {
    // "My nearest terminal ancestor" must not answer with me.
    expect(findAncestor(chain('a'), nid('a'), () => true)).toBeUndefined()
  })

  it('terminates on a cycle where nothing matches', () => {
    const nodes = { a: node('a', nid('b')), b: node('b', nid('a')) }
    expect(findAncestor(lookupIn(nodes), nid('a'), () => false)).toBeUndefined()
  })
})

describe('lookupIn', () => {
  it('reads from the record', () => {
    expect(lookupIn({ a: node('a') })(nid('a'))?.id).toBe('a')
  })

  it('returns undefined for a missing key', () => {
    expect(lookupIn({})(nid('a'))).toBeUndefined()
  })
})
