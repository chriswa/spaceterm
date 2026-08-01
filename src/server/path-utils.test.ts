import { describe, expect, it } from 'vitest'
import { homedir } from 'os'
import * as path from 'path'
import { resolveFilePath, getAncestorCwd } from './path-utils'
import type { NodeData } from '../shared/state'
import { asNodeId as nid } from '../shared/ids'

/**
 * getAncestorCwd walks the parent chain, so tests only need the fields it reads.
 * Building complete node records would obscure what each case is actually about.
 */
/** Minimal node fixtures. Ids stay plain strings here — the cast at the end is
 *  what asserts the whole map is NodeData, so branding each literal buys nothing. */
function nodes(...entries: Array<[string, { type: string; parentId: string; cwd?: string }]>): Record<string, NodeData> {
  return Object.fromEntries(entries) as unknown as Record<string, NodeData>
}

describe('resolveFilePath', () => {
  it('returns an absolute path unchanged', () => {
    expect(resolveFilePath('/etc/hosts')).toBe('/etc/hosts')
  })

  it('expands a bare tilde', () => {
    expect(resolveFilePath('~')).toBe(homedir())
  })

  it('expands a tilde path', () => {
    expect(resolveFilePath('~/notes.md')).toBe(path.join(homedir(), '/notes.md'))
  })

  it('resolves a relative path against the given cwd', () => {
    expect(resolveFilePath('src/index.ts', '/repo')).toBe('/repo/src/index.ts')
  })

  it('expands a tilde in the cwd before resolving against it', () => {
    expect(resolveFilePath('a.txt', '~/proj')).toBe(path.join(homedir(), 'proj', 'a.txt'))
  })

  it('normalizes a relative path that walks upward', () => {
    expect(resolveFilePath('../b.txt', '/repo/src')).toBe('/repo/b.txt')
  })

  it('leaves a relative path alone when no cwd is given', () => {
    expect(resolveFilePath('relative.txt')).toBe('relative.txt')
  })

  it('prefers the tilde expansion over the cwd', () => {
    // A tilde path is already absolute after expansion, so cwd must not apply.
    expect(resolveFilePath('~/x', '/repo')).toBe(path.join(homedir(), '/x'))
  })
})

describe('getAncestorCwd', () => {
  it('returns the cwd of the node itself when it has one', () => {
    const map = nodes(['a', { type: 'terminal', parentId: 'root', cwd: '/here' }])
    expect(getAncestorCwd(map, nid('a'))).toBe('/here')
  })

  it('walks up to the nearest ancestor with a cwd', () => {
    const map = nodes(
      ['child', { type: 'markdown', parentId: 'mid' }],
      ['mid', { type: 'markdown', parentId: 'top' }],
      ['top', { type: 'directory', parentId: 'root', cwd: '/top' }],
    )
    expect(getAncestorCwd(map, nid('child'))).toBe('/top')
  })

  it('accepts a directory node as the cwd source', () => {
    const map = nodes(
      ['child', { type: 'file', parentId: 'dir' }],
      ['dir', { type: 'directory', parentId: 'root', cwd: '/dir' }],
    )
    expect(getAncestorCwd(map, nid('child'))).toBe('/dir')
  })

  it('returns the closest cwd, not the furthest', () => {
    const map = nodes(
      ['child', { type: 'markdown', parentId: 'near' }],
      ['near', { type: 'terminal', parentId: 'far', cwd: '/near' }],
      ['far', { type: 'directory', parentId: 'root', cwd: '/far' }],
    )
    expect(getAncestorCwd(map, nid('child'))).toBe('/near')
  })

  it('skips a terminal whose cwd is unset', () => {
    const map = nodes(
      ['child', { type: 'terminal', parentId: 'top' }],
      ['top', { type: 'directory', parentId: 'root', cwd: '/top' }],
    )
    expect(getAncestorCwd(map, nid('child'))).toBe('/top')
  })

  it('returns undefined when nothing in the chain has a cwd', () => {
    const map = nodes(
      ['child', { type: 'markdown', parentId: 'top' }],
      ['top', { type: 'markdown', parentId: 'root' }],
    )
    expect(getAncestorCwd(map, nid('child'))).toBeUndefined()
  })

  it('returns undefined for an unknown node', () => {
    expect(getAncestorCwd(nodes(), nid('missing'))).toBeUndefined()
  })

  it('stops at the root sentinel', () => {
    const map = nodes(['a', { type: 'markdown', parentId: 'root' }])
    expect(getAncestorCwd(map, nid('a'))).toBeUndefined()
  })

  it('terminates on a parent cycle instead of looping forever', () => {
    const map = nodes(
      ['a', { type: 'markdown', parentId: 'b' }],
      ['b', { type: 'markdown', parentId: 'a' }],
    )
    expect(getAncestorCwd(map, nid('a'))).toBeUndefined()
  })

  it('terminates on a self-referencing parent', () => {
    const map = nodes(['a', { type: 'markdown', parentId: 'a' }])
    expect(getAncestorCwd(map, nid('a'))).toBeUndefined()
  })

  it('stops when the chain points at a missing node', () => {
    const map = nodes(['a', { type: 'markdown', parentId: 'gone' }])
    expect(getAncestorCwd(map, nid('a'))).toBeUndefined()
  })
})
