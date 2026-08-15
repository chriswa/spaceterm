import { describe, it, expect } from 'vitest'
import { chromeNeedsEdgeMask, isOpaqueColor } from './card-surface'
import { CARD_CHROMES } from './theme/facets'
import type { CardChromeFacet } from './theme/facets'

describe('isOpaqueColor', () => {
  it('reads the hex forms that carry no alpha as opaque', () => {
    expect(isOpaqueColor('#1e1e2e')).toBe(true)
    expect(isOpaqueColor('#FFF')).toBe(true)
    expect(isOpaqueColor('  #14161c  ')).toBe(true)
  })

  it('reads the alpha nibble of the hex forms that carry one', () => {
    expect(isOpaqueColor('#1e1e2eff')).toBe(true)
    expect(isOpaqueColor('#1e1e2ecc')).toBe(false)
    expect(isOpaqueColor('#abcf')).toBe(true)
    expect(isOpaqueColor('#abc8')).toBe(false)
  })

  it('reads the alpha argument of a colour function', () => {
    expect(isOpaqueColor('rgba(24, 24, 37, 0.86)')).toBe(false)
    expect(isOpaqueColor('rgba(24, 24, 37, 1)')).toBe(true)
    expect(isOpaqueColor('rgb(24, 24, 37)')).toBe(true)
    expect(isOpaqueColor('hsla(240, 21%, 12%, 0.5)')).toBe(false)
    // `rgb()` and `rgba()` are interchangeable, so the name proves nothing.
    expect(isOpaqueColor('rgb(24 24 37 / 0.5)')).toBe(false)
    expect(isOpaqueColor('rgb(24 24 37 / 100%)')).toBe(true)
  })

  it('knows the one keyword that is not opaque', () => {
    expect(isOpaqueColor('transparent')).toBe(false)
    expect(isOpaqueColor('black')).toBe(true)
    expect(isOpaqueColor('rebeccapurple')).toBe(true)
  })

  /**
   * The direction the whole optimisation has to fail in. Claiming opacity it
   * cannot prove would drop the masking pass on a theme that needs it, and the
   * symptom — tree edges showing through cards — would look like a renderer bug
   * rather than a parse that met a syntax it did not know.
   */
  it('refuses to guess, and calls anything it cannot parse translucent', () => {
    expect(isOpaqueColor('color-mix(in oklab, #000, #fff)')).toBe(false)
    expect(isOpaqueColor('var(--something)')).toBe(false)
    expect(isOpaqueColor('#12345')).toBe(false)
    expect(isOpaqueColor('')).toBe(false)
    expect(isOpaqueColor('rgba(1, 2, 3)')).toBe(true) // three args: no alpha
    expect(isOpaqueColor('rgba(1, 2, 3, 4, 5)')).toBe(false)
  })
})

describe('chromeNeedsEdgeMask', () => {
  it('is false for the default chrome — which is where the saving is', () => {
    // `standard` is flat `#1e1e2e`, so the mask quads it was drawing were one
    // full evaluation of the background shader per card, under an opaque card.
    expect(chromeNeedsEdgeMask(CARD_CHROMES.standard)).toBe(false)
    expect(chromeNeedsEdgeMask(CARD_CHROMES.technical)).toBe(false)
  })

  it('is true for the translucent chrome that the pass exists for', () => {
    expect(chromeNeedsEdgeMask(CARD_CHROMES.hairline)).toBe(true)
  })

  it('counts a translucent header over an opaque body', () => {
    // The header covers only the top strip, so an edge crossing under it shows.
    const chrome: CardChromeFacet = {
      id: 'test',
      label: 'Test',
      vars: { '--card-surface': '#1e1e2e', '--card-head-surface': 'rgba(0,0,0,0.5)' },
    }
    expect(chromeNeedsEdgeMask(chrome)).toBe(true)
  })

  it('masks for a chrome that names no surface at all', () => {
    expect(chromeNeedsEdgeMask({ id: 'bare', label: 'Bare', vars: {} })).toBe(true)
  })
})
