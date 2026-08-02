import { describe, it, expect, afterEach, beforeAll } from 'vitest'
import { registerTheme, resetThemeRegistryForTests } from './theme-registry'
import { registerFacet } from './registry'
import { resolveModFacet, resolveTheme, themes, type Theme } from './themes'

/**
 * What a mod is promised about themes.
 *
 * The case worth protecting is the awkward one: mod A ships a theme that
 * restyles a facet owned by mod B, where the only thing they share is the
 * string key. Neither imports the other, neither is required to be installed,
 * and neither knows the other's load order.
 */

// Snapshot and re-register rather than re-importing: `vi.resetModules()` would
// give the dynamic import a *different* registry module from the one this
// file's static imports already bound to.
let builtIns: readonly Theme[] = []
beforeAll(() => { builtIns = themes() })
afterEach(() => {
  resetThemeRegistryForTests()
  for (const theme of builtIns) registerTheme(theme)
})

describe('theme namespacing', () => {
  it('rejects a malformed namespaced id', () => {
    expect(() => registerTheme({ id: 'a:b:c', label: 'x', blurb: 'x', facets: {} }))
      .toThrow(/more than one/)
    expect(() => registerTheme({ id: ':midnight', label: 'x', blurb: 'x', facets: {} }))
      .toThrow(/non-empty/)
  })

  it('lets two mods ship a theme of the same name', () => {
    registerTheme({ id: 'mod-a:midnight', label: 'Midnight', blurb: 'a', facets: {} })
    registerTheme({ id: 'mod-b:midnight', label: 'Midnight', blurb: 'b', facets: {} })
    expect(resolveTheme('mod-a:midnight').blurb).toBe('a')
    expect(resolveTheme('mod-b:midnight').blurb).toBe('b')
  })
})

describe('a mod theme joins the same list as the built-ins', () => {
  it('appears alongside them', () => {
    const before = themes().length
    registerTheme({ id: 'mod-a:midnight', label: 'Midnight', blurb: '', facets: {} })
    expect(themes().length).toBe(before + 1)
    expect(themes().some(t => t.id === 'mod-a:midnight')).toBe(true)
  })

  it('can be selected by an id persisted before it registered', () => {
    // The launch-order case: the store reads `localStorage` long before a mod
    // runs, so an unknown id has to survive as the default and then start
    // working rather than being discarded.
    expect(resolveTheme('mod-a:midnight').id).toBe('default')
    registerTheme({ id: 'mod-a:midnight', label: 'Midnight', blurb: '', facets: {} })
    expect(resolveTheme('mod-a:midnight').id).toBe('mod-a:midnight')
  })
})

describe('a theme from one mod styling a facet from another', () => {
  const BUBBLE = 'mod-b:indicator'

  it('works with nothing shared but the string key', () => {
    // Mod B owns a facet. It has never heard of mod A.
    registerFacet({ id: BUBBLE, defaultValue: { look: 'b-default' } })

    // Mod A ships a theme that dresses it, naming it by string alone.
    registerTheme({
      id: 'mod-a:midnight',
      label: 'Midnight',
      blurb: '',
      facets: {},
      modFacets: { [BUBBLE]: { look: 'a-restyled' } },
    })

    expect(resolveModFacet('mod-a:midnight', BUBBLE)).toEqual({ look: 'a-restyled' })
    // …and mod B's own default still applies everywhere else.
    expect(resolveModFacet('default', BUBBLE)).toEqual({ look: 'b-default' })
  })

  it('does not break when the facet\'s mod is not installed', () => {
    registerTheme({
      id: 'mod-a:midnight',
      label: 'Midnight',
      blurb: '',
      facets: {},
      modFacets: { 'never-installed:thing': { look: 'x' } },
    })
    // Selecting the theme is fine; the orphaned entry is simply never read.
    expect(resolveTheme('mod-a:midnight').id).toBe('mod-a:midnight')
    expect(resolveModFacet('mod-a:midnight', 'never-installed:thing')).toEqual({ look: 'x' })
  })

  it('does not care which mod loaded first', () => {
    // Theme before facet.
    registerTheme({
      id: 'mod-a:midnight',
      label: 'Midnight',
      blurb: '',
      facets: {},
      modFacets: { [BUBBLE]: { look: 'a-restyled' } },
    })
    registerFacet({ id: BUBBLE, defaultValue: { look: 'b-default' } })
    expect(resolveModFacet('mod-a:midnight', BUBBLE)).toEqual({ look: 'a-restyled' })
  })
})
