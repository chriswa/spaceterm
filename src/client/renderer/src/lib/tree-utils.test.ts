import { describe, it, expect } from 'vitest'
import type { NodeData } from '../../../../shared/state'
import { asNodeId } from '../../../../shared/ids'
import { hasLiveChildren, getDescendantIds } from './tree-utils'

/**
 * `hasLiveChildren` guards a destructive action: archiving is refused (and the X
 * button greys out) for any node that still has live children, so both answers
 * matter. It reads only `parentId`, so the fixtures carry nothing else.
 */
const nodes = (...edges: [id: string, parentId: string][]): Record<string, NodeData> =>
  Object.fromEntries(
    edges.map(([id, parentId]) => [id, { parentId: asNodeId(parentId) } as NodeData])
  )

describe('hasLiveChildren', () => {
  it('is false for a leaf', () => {
    const tree = nodes(['a', 'root'], ['b', 'root'])
    expect(hasLiveChildren(tree, asNodeId('a'))).toBe(false)
    expect(hasLiveChildren(tree, asNodeId('b'))).toBe(false)
  })

  it('is true for a node with a direct child', () => {
    const tree = nodes(['parent', 'root'], ['child', 'parent'])
    expect(hasLiveChildren(tree, asNodeId('parent'))).toBe(true)
  })

  it('is true for a node whose only descendants are grandchildren', () => {
    // Even with an intermediate node, the direct child makes it non-leaf.
    const tree = nodes(['parent', 'root'], ['child', 'parent'], ['grandchild', 'child'])
    expect(hasLiveChildren(tree, asNodeId('parent'))).toBe(true)
    expect(hasLiveChildren(tree, asNodeId('grandchild'))).toBe(false)
  })

  it('agrees with getDescendantIds on leaf-ness', () => {
    const tree = nodes(['parent', 'root'], ['child', 'parent'])
    for (const id of ['parent', 'child']) {
      expect(hasLiveChildren(tree, asNodeId(id))).toBe(
        getDescendantIds(tree, asNodeId(id)).length > 0
      )
    }
  })
})
