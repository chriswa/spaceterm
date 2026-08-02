import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  isModFacetId,
  isFacetRegistered,
  registerFacet,
  registeredFacetIds,
  resetFacetRegistryForTests,
  resolveRegisteredFacet,
} from './registry'
import { FACET_IDS } from './facets'

/**
 * What a mod is promised about facets.
 *
 * These are the guarantees a mod author would rely on and could not verify
 * from inside their own package: that their id is theirs, that their default
 * survives a theme that says nothing, that a theme naming their facet wins,
 * and that none of it breaks when the mod is not installed.
 */

describe('namespacing', () => {
  beforeEach(resetFacetRegistryForTests)
  afterEach(resetFacetRegistryForTests)

  it('treats a colon as the mark of a mod facet', () => {
    expect(isModFacetId('summary-chat:bubble')).toBe(true)
    expect(isModFacetId('background')).toBe(false)
  })

  it('rejects an id with more than one colon', () => {
    expect(() => registerFacet({ id: 'a:b:c', defaultValue: 1 })).toThrow(/more than one/)
  })

  it('rejects a half-empty namespace', () => {
    expect(() => registerFacet({ id: ':bubble', defaultValue: 1 })).toThrow(/non-empty/)
    expect(() => registerFacet({ id: 'summary-chat:', defaultValue: 1 })).toThrow(/non-empty/)
  })

  it('lets two mods use the same facet name under different namespaces', () => {
    registerFacet({ id: 'summary-chat:bubble', defaultValue: 'a' })
    registerFacet({ id: 'weather:bubble', defaultValue: 'b' })
    expect(resolveRegisteredFacet('summary-chat:bubble', 'default', undefined)).toBe('a')
    expect(resolveRegisteredFacet('weather:bubble', 'default', undefined)).toBe('b')
  })
})

describe('resolution', () => {
  beforeEach(() => {
    resetFacetRegistryForTests()
    registerFacet({
      id: 'summary-chat:bubble',
      defaultValue: 'speech',
      byTheme: { grid: 'technical' },
    })
  })
  afterEach(resetFacetRegistryForTests)

  it('falls back to the default for a theme the mod has never heard of', () => {
    expect(resolveRegisteredFacet('summary-chat:bubble', 'nebula', undefined)).toBe('speech')
  })

  it('uses the mod\'s own per-theme variant when it has one', () => {
    // The dependency arrow: the mod names a base theme, never the reverse.
    expect(resolveRegisteredFacet('summary-chat:bubble', 'grid', undefined)).toBe('technical')
  })

  it('lets a theme override beat the mod\'s variant', () => {
    expect(resolveRegisteredFacet('summary-chat:bubble', 'grid', 'custom')).toBe('custom')
  })
})

describe('a facet whose mod is not installed', () => {
  beforeEach(resetFacetRegistryForTests)
  afterEach(resetFacetRegistryForTests)

  it('resolves to undefined rather than throwing', () => {
    expect(isFacetRegistered('never-installed:thing')).toBe(false)
    expect(resolveRegisteredFacet('never-installed:thing', 'default', undefined)).toBeUndefined()
  })

  it('still honours a theme override, so registration order does not matter', () => {
    // A theme is parsed long before a mod may register; the override has to
    // survive that gap rather than being dropped on the floor.
    expect(resolveRegisteredFacet('later:thing', 'default', 'from-theme')).toBe('from-theme')
    registerFacet({ id: 'later:thing', defaultValue: 'from-mod' })
    expect(resolveRegisteredFacet('later:thing', 'default', 'from-theme')).toBe('from-theme')
    expect(resolveRegisteredFacet('later:thing', 'default', undefined)).toBe('from-mod')
  })
})

describe('core facets', () => {
  it('are in the same registry, with bare ids', async () => {
    // Imported fresh so the module-load registration in facets.ts is present:
    // the suites above clear the registry.
    resetFacetRegistryForTests()
    const facets = await import('./facets')
    for (const id of facets.FACET_IDS) {
      expect(isModFacetId(id)).toBe(false)
    }
    expect(FACET_IDS.length).toBeGreaterThan(0)
  })

  it('expose their ids for anything that needs to enumerate them', () => {
    resetFacetRegistryForTests()
    registerFacet({ id: 'background', defaultValue: 1 })
    registerFacet({ id: 'summary-chat:bubble', defaultValue: 2 })
    expect(registeredFacetIds()).toEqual(['background', 'summary-chat:bubble'])
  })
})
