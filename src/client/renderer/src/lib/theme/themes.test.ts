import { describe, it, expect } from 'vitest'
import {
  BACKGROUNDS,
  DEFAULT_FACETS,
  EDGES,
  FACET_IDS,
  type BackgroundFacet,
  type EdgeFacet,
  type FacetId,
} from './facets'
import { EDGE_VERT_SRC } from './shaders'
import { DEFAULT_THEME_ID, themes, resolveFacet, resolveFacets, resolveTheme } from './themes'

/**
 * The facet model's invariants.
 *
 * All of these are the kind of thing that breaks silently: a theme that stops
 * being sparse, a facet added to the type but not to the defaults, an id
 * renamed out from under `localStorage`. None of them would fail a build.
 */

describe('the default theme', () => {
  it('overrides nothing — it *is* DEFAULT_FACETS, not a copy of it', () => {
    // This is what stops the default look and the fall-through drifting apart.
    // If a facet is ever added here, delete it and change DEFAULT_FACETS.
    expect(resolveTheme(DEFAULT_THEME_ID).facets).toEqual({})
  })

  it('resolves to exactly the defaults', () => {
    expect(resolveFacets(DEFAULT_THEME_ID)).toEqual(DEFAULT_FACETS)
  })

  it('exists', () => {
    expect(themes().some(t => t.id === DEFAULT_THEME_ID)).toBe(true)
  })
})

describe('every facet', () => {
  it('has a default implementation', () => {
    for (const facet of FACET_IDS) {
      expect(DEFAULT_FACETS[facet], `no default for facet "${facet}"`).toBeDefined()
    }
  })

  it('is listed in FACET_IDS — the runtime list matches the type', () => {
    // `keyof ThemeFacets` does not survive to runtime, so FACET_IDS is a
    // hand-maintained copy. This is what catches forgetting to extend it.
    expect([...FACET_IDS].sort()).toEqual(Object.keys(DEFAULT_FACETS).sort())
  })
})

describe('sparse override', () => {
  it('takes the theme\'s facet where it has one', () => {
    const nebula = resolveFacets('nebula')
    expect(nebula.background.id).toBe('nebula')
    expect(nebula.rootNode.id).toBe('orb')
    expect(nebula.cardChrome.id).toBe('hairline')
  })

  it('falls through to the default where it does not', () => {
    // Nebula says nothing about node tint, so it keeps the default.
    expect(resolveTheme('nebula').facets.nodeTint).toBeUndefined()
    expect(resolveFacet('nebula', 'nodeTint')).toBe(DEFAULT_FACETS.nodeTint)
  })

  it('is a real fall-through, not a coincidence of matching ids', () => {
    // Guards the trap this test fell into once: asserting on a facet id that
    // the default happens to share makes a broken lookup pass. Identity, and a
    // theme whose override differs from the default, are what actually check it.
    const concentric = resolveFacets('concentric')
    expect(concentric.nodeTint).not.toBe(DEFAULT_FACETS.nodeTint)
    expect(concentric.nodeTint.id).toBe('neutral')
    expect(concentric.background.id).toBe('concentric')
  })
})

describe('the edges facet', () => {
  it('lets a theme replace the vertex shader, and most do not', () => {
    // The chevron scroll lives in the vertex stage, so "still edges" is only
    // expressible as a different vertex shader.
    expect(resolveFacet('concentric', 'edges').vert).toBeTruthy()
    expect(resolveFacet('default', 'edges').vert).toBeUndefined()
    expect(resolveFacet('nebula', 'edges').vert).toBeUndefined()
  })
})

/**
 * `static` is a *promise* the renderer acts on: `CanvasFrameGate` stops drawing
 * entirely when every facet in play declares it. A facet that claims it and
 * then reads a clock does not look slightly wrong — it freezes. Nothing in the
 * type system can check the claim, so these read the shader source instead.
 */
describe('the static promise', () => {
  // Widened from the `as const` literals on purpose: an optional property is
  // absent from the narrowed type of a facet that omits it, so reading
  // `.static` off the literals would not compile — and, worse, would let these
  // tests only ever see the facets that already declare it.
  const backgrounds: readonly BackgroundFacet[] = Object.values(BACKGROUNDS)
  const edges: readonly EdgeFacet[] = Object.values(EDGES)

  it('is kept by every background that makes it', () => {
    for (const facet of backgrounds) {
      if (!facet.static) continue
      expect(facet.frag, `background "${facet.id}"`).not.toMatch(/\biTime\b/)
    }
  })

  it('is kept by every edge facet that makes it', () => {
    for (const facet of edges) {
      if (!facet.static) continue
      // The default vertex shader scrolls vUV with uTime, so a static edge
      // facet has to bring its own — its fragment shader cannot opt out.
      expect(facet.vert, `edge "${facet.id}" vert`).toBeTruthy()
      expect(facet.vert, `edge "${facet.id}" vert`).not.toBe(EDGE_VERT_SRC)
      expect(facet.vert, `edge "${facet.id}" vert`).not.toMatch(/\buTime\b/)
      // ...and it must not sample the animated background either, which is
      // what makes the nebula's edges non-static despite holding still.
      expect(facet.frag, `edge "${facet.id}" frag`).not.toMatch(/\buBgTime\b/)
    }
  })

  it('defaults to animated, so an undeclared facet is never frozen', () => {
    // The safe direction for a facet from a mod that has not considered this.
    const animated = [...backgrounds, ...edges].filter((f) => f.id !== 'concentric')
    expect(animated).not.toHaveLength(0)
    for (const facet of animated) {
      expect(facet.static, `facet "${facet.id}"`).toBeUndefined()
    }
  })

  it('is what the concentric theme is for', () => {
    // Both halves, or the gate cannot skip a frame: the edges composite over
    // the background, so neither repaints alone.
    expect(resolveFacet('concentric', 'background').static).toBe(true)
    expect(resolveFacet('concentric', 'edges').static).toBe(true)
  })
})

describe('node tint', () => {
  it('gives every node the same neutral preset under the concentric theme', () => {
    const tint = resolveFacet('concentric', 'nodeTint')
    expect(tint.presetFor(0, 0)).toBe(tint.presetFor(9999, -4321))
  })

  it('varies by position under the default theme', () => {
    const tint = resolveFacet('default', 'nodeTint')
    expect(tint.borderColor(1000, 0)).not.toBe(tint.borderColor(0, 1000))
  })
})

describe('resolution of an unknown theme', () => {
  it('falls back to the default rather than throwing', () => {
    // Stale `localStorage` after a theme is renamed or removed.
    expect(resolveTheme('no-such-theme').id).toBe(DEFAULT_THEME_ID)
    expect(resolveFacets('no-such-theme')).toEqual(DEFAULT_FACETS)
  })
})

describe('the registry', () => {
  it('has unique theme ids', () => {
    const ids = themes().map(t => t.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('gives every theme a label and a blurb for the picker', () => {
    for (const theme of themes()) {
      expect(theme.label, `theme "${theme.id}" has no label`).toBeTruthy()
      expect(theme.blurb, `theme "${theme.id}" has no blurb`).toBeTruthy()
    }
  })

  it('only overrides facets that exist', () => {
    const known = new Set<string>(FACET_IDS)
    for (const theme of themes()) {
      for (const facet of Object.keys(theme.facets)) {
        expect(known.has(facet), `theme "${theme.id}" overrides unknown facet "${facet}"`).toBe(true)
      }
    }
  })

  it('names every facet implementation it uses', () => {
    for (const theme of themes()) {
      for (const [id, facet] of Object.entries(theme.facets)) {
        expect(facet?.id, `${theme.id}/${id} has no facet id`).toBeTruthy()
        expect(facet?.label, `${theme.id}/${id} has no facet label`).toBeTruthy()
      }
    }
  })
})

describe('shader facets', () => {
  it('supply GLSL that declares a main()', () => {
    for (const themeId of themes().map(t => t.id)) {
      for (const facet of ['background', 'edges'] as const satisfies readonly FacetId[]) {
        expect(resolveFacet(themeId, facet).frag, `${themeId}/${facet}`).toContain('void main()')
      }
    }
  })
})
