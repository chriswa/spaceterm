import { describe, it, expect } from 'vitest'
import { MOD_CAPABILITIES, isModCapability, parseModManifest } from './mod-manifest'

/**
 * A manifest comes off disk, written by someone else, possibly by hand. Every
 * test here is a way it can be wrong that should produce a legible complaint
 * about one mod rather than an exception in the loader.
 */

const VALID = {
  id: 'summary-chat',
  name: 'Summary Chat',
  version: '1.0.0',
  protocolVersion: 1,
  capabilities: ['read-nodes', 'emit-mod'],
}

describe('a valid manifest', () => {
  it('parses', () => {
    const parsed = parseModManifest(VALID)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.manifest).toMatchObject({ id: 'summary-chat', capabilities: ['read-nodes', 'emit-mod'] })
  })

  it('defaults the name to the id and the version to 0.0.0', () => {
    const parsed = parseModManifest({ id: 'weather', protocolVersion: 1, capabilities: [] })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.manifest.name).toBe('weather')
    expect(parsed.manifest.version).toBe('0.0.0')
  })

  it('drops duplicate capabilities', () => {
    const parsed = parseModManifest({ ...VALID, capabilities: ['read-nodes', 'read-nodes'] })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.manifest.capabilities).toEqual(['read-nodes'])
  })
})

describe('a manifest that cannot be trusted', () => {
  it.each([
    ['not an object', 'must be an object', null],
    ['no id', 'id must match', { protocolVersion: 1, capabilities: [] }],
    ['an id with a colon', 'id must match', { ...VALID, id: 'my:mod' }],
    ['an id starting with a digit', 'id must match', { ...VALID, id: '1mod' }],
    ['an uppercase id', 'id must match', { ...VALID, id: 'SummaryChat' }],
    ['no protocolVersion', 'protocolVersion', { id: 'x', capabilities: [] }],
    ['a fractional protocolVersion', 'protocolVersion', { ...VALID, protocolVersion: 1.5 }],
    ['no capabilities', 'capabilities must be an array', { id: 'x', protocolVersion: 1 }],
    ['an unknown capability', 'unknown capability', { ...VALID, capabilities: ['rm-rf'] }],
    ['peers as an array', 'peers must be an object', { ...VALID, peers: ['a'] }],
    ['a non-string peer range', 'version range', { ...VALID, peers: { a: 1 } }],
    ['an empty command', 'command must not be empty', { ...VALID, command: [] }],
    ['a non-string command', 'array of strings', { ...VALID, command: ['node', 3] }],
  ])('rejects %s', (_label, expected, input) => {
    const parsed = parseModManifest(input)
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.error).toContain(expected)
  })

  it('requires capabilities rather than defaulting to none', () => {
    // Silently getting a mod that can do nothing is a worse afternoon than
    // being told the field is missing.
    const parsed = parseModManifest({ id: 'x', protocolVersion: 1 })
    expect(parsed.ok).toBe(false)
  })
})

describe('the capability list', () => {
  it('recognises exactly what it declares', () => {
    for (const capability of MOD_CAPABILITIES) expect(isModCapability(capability)).toBe(true)
    expect(isModCapability('read-everything')).toBe(false)
  })
})
