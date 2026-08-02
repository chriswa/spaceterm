import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { ModRegistry } from './mod-registry'

/**
 * Reading manifests off disk. The property that matters is that one bad mod
 * disables itself and nothing else — a loader that throws takes the server
 * with it, and the server is what the user actually wanted.
 */

let home: string
let logs: string[]
let registry: ModRegistry

const writeMod = (dir: string, contents: unknown | string): void => {
  mkdirSync(join(home, 'mods', dir), { recursive: true })
  writeFileSync(
    join(home, 'mods', dir, 'mod.json'),
    typeof contents === 'string' ? contents : JSON.stringify(contents),
  )
}

const manifest = (id: string, extra: Record<string, unknown> = {}) => ({
  id, name: id, version: '1.0.0', protocolVersion: 1, capabilities: ['read-nodes'], ...extra,
})

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'spaceterm-mods-'))
  logs = []
  registry = new ModRegistry((line) => logs.push(line))
})
afterEach(() => { rmSync(home, { recursive: true, force: true }) })

describe('loading', () => {
  it('is a no-op when there is no mods directory', () => {
    registry.loadFrom(home)
    expect(registry.all()).toEqual([])
  })

  it('loads a well-formed manifest', () => {
    writeMod('weather', manifest('weather'))
    registry.loadFrom(home)
    expect(registry.all().map((m) => m.id)).toEqual(['weather'])
    expect(registry.capabilitiesFor('weather')).toEqual(['read-nodes'])
  })

  it('reports an unknown mod as null rather than empty', () => {
    // Empty would mean "declared nothing", which is a different thing from
    // "never declared" and gets scoped instead of running unscoped.
    registry.loadFrom(home)
    expect(registry.capabilitiesFor('nobody')).toBeNull()
  })

  it('skips a directory with no mod.json', () => {
    mkdirSync(join(home, 'mods', 'empty'), { recursive: true })
    registry.loadFrom(home)
    expect(registry.all()).toEqual([])
  })
})

describe('one bad mod does not stop the others', () => {
  it('survives unparseable JSON', () => {
    writeMod('broken', '{ not json')
    writeMod('good', manifest('good'))
    registry.loadFrom(home)
    expect(registry.all().map((m) => m.id)).toEqual(['good'])
    expect(logs.join('\n')).toContain('broken')
  })

  it('survives an invalid manifest', () => {
    writeMod('broken', { id: 'broken', protocolVersion: 1, capabilities: ['rm-rf'] })
    writeMod('good', manifest('good'))
    registry.loadFrom(home)
    expect(registry.all().map((m) => m.id)).toEqual(['good'])
    expect(logs.join('\n')).toContain('unknown capability')
  })

  it('rejects a manifest whose id disagrees with its directory', () => {
    // Otherwise `ls mods/` lies about what is installed, and two directories
    // could claim the same id.
    writeMod('weather', manifest('something-else'))
    registry.loadFrom(home)
    expect(registry.all()).toEqual([])
    expect(logs.join('\n')).toContain('must match')
  })
})

describe('peers', () => {
  it('reports a named peer that is not installed', () => {
    writeMod('themer', manifest('themer', { peers: { 'summary-chat': '^1' } }))
    registry.loadFrom(home)
    expect(registry.missingPeers()).toEqual([
      { modId: 'themer', peer: 'summary-chat', range: '^1' },
    ])
  })

  it('says nothing when the peer is installed', () => {
    writeMod('themer', manifest('themer', { peers: { 'summary-chat': '^1' } }))
    writeMod('summary-chat', manifest('summary-chat'))
    registry.loadFrom(home)
    expect(registry.missingPeers()).toEqual([])
  })

  it('does not stop a mod loading when its peer is absent', () => {
    // Advisory, not enforced: a mod that degrades gracefully without its peer
    // is the behaviour worth encouraging.
    writeMod('themer', manifest('themer', { peers: { 'summary-chat': '^1' } }))
    registry.loadFrom(home)
    expect(registry.capabilitiesFor('themer')).toEqual(['read-nodes'])
  })
})

describe('mod-provided capabilities', () => {
  it('finds the provider of a capability', () => {
    writeMod('summary-chat', manifest('summary-chat', { provides: ['summary-chat:speak'] }))
    registry.loadFrom(home)
    expect(registry.providerOf('summary-chat:speak')).toBe('summary-chat')
  })

  it('reports a requested capability nobody provides', () => {
    writeMod('narrator', manifest('narrator', { capabilities: ['summary-chat:speak'] }))
    registry.loadFrom(home)
    expect(registry.unprovidedCapabilities()).toEqual([
      { modId: 'narrator', capability: 'summary-chat:speak' },
    ])
  })

  it('says nothing once the provider is installed', () => {
    writeMod('narrator', manifest('narrator', { capabilities: ['summary-chat:speak'] }))
    writeMod('summary-chat', manifest('summary-chat', { provides: ['summary-chat:speak'] }))
    registry.loadFrom(home)
    expect(registry.unprovidedCapabilities()).toEqual([])
  })

  it('does not report base capabilities as unprovided', () => {
    // Those always exist; only namespaced ones can be missing.
    writeMod('reader', manifest('reader', { capabilities: ['read-nodes'] }))
    registry.loadFrom(home)
    expect(registry.unprovidedCapabilities()).toEqual([])
  })

  it('answers whether a caller declared a capability', () => {
    // What a provider asks before handing over its API. Information, not a
    // gate: a caller that ignores it and imports directly still gets through.
    writeMod('narrator', manifest('narrator', { capabilities: ['summary-chat:speak'] }))
    registry.loadFrom(home)
    expect(registry.declares('narrator', 'summary-chat:speak')).toBe(true)
    expect(registry.declares('narrator', 'summary-chat:shush')).toBe(false)
    expect(registry.declares('nobody', 'summary-chat:speak')).toBe(false)
  })

  it('still loads a mod whose requested capability is unprovided', () => {
    writeMod('narrator', manifest('narrator', { capabilities: ['summary-chat:speak'] }))
    registry.loadFrom(home)
    expect(registry.all().map((m) => m.id)).toEqual(['narrator'])
  })
})
