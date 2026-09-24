import { describe, it, expect } from 'vitest'
import type { NodeData } from '../../../../shared/state'
import { asNodeId } from '../../../../shared/ids'
import { hasLiveChildren, getDescendantIds, getAncestorCwd } from './tree-utils'

/**
 * `hasLiveChildren` decides whether archiving asks first: a node with live
 * children takes its whole subtree, so the gesture opens a confirmation instead
 * of archiving outright. Both answers matter. It reads only `parentId`, so the
 * fixtures carry nothing else.
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

/**
 * `getAncestorCwd` decides where a new card starts. It mirrors the server's
 * walk of the same name, and the two must agree: this one picks the cwd a
 * surface launches with, the server's decides whether it has since wandered.
 */
describe('getAncestorCwd', () => {
  const NO_LIVE_CWDS = new Map<string, string>()

  const withCwds = (...entries: [id: string, parentId: string, cwd?: string][]): Record<string, NodeData> =>
    Object.fromEntries(entries.map(([id, parentId, cwd]) => [
      id,
      { id: asNodeId(id), parentId: asNodeId(parentId), type: cwd ? 'directory' : 'markdown', cwd } as NodeData
    ]))

  it('returns the nearest ancestor cwd', () => {
    const tree = withCwds(['a', 'dir'], ['dir', 'root', '/repo'])
    expect(getAncestorCwd(tree, 'a', NO_LIVE_CWDS)).toBe('/repo')
  })

  it('prefers a live pty cwd over the stored one', () => {
    const tree = withCwds(['dir', 'root', '/repo'])
    expect(getAncestorCwd(tree, 'dir', new Map([['dir', '/moved']]))).toBe('/moved')
  })

  it('is undefined at the root when no default is set', () => {
    const tree = withCwds(['a', 'root'])
    expect(getAncestorCwd(tree, 'a', NO_LIVE_CWDS)).toBeUndefined()
  })

  it('falls back to the root default once the walk reaches the root', () => {
    const tree = withCwds(['a', 'root'])
    expect(getAncestorCwd(tree, 'a', NO_LIVE_CWDS, '~/research')).toBe('~/research')
  })

  it('does not override a cwd the chain supplies', () => {
    const tree = withCwds(['a', 'dir'], ['dir', 'root', '/repo'])
    expect(getAncestorCwd(tree, 'a', NO_LIVE_CWDS, '~/research')).toBe('/repo')
  })

  it('falls back to the root default off a dangling parent', () => {
    const tree = withCwds(['a', 'gone'])
    expect(getAncestorCwd(tree, 'a', NO_LIVE_CWDS, '~/research')).toBe('~/research')
  })
})
