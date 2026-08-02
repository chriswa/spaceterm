import { describe, it, expect } from 'vitest'
import { resolveModFacet } from '../../lib/theme/themes'
import { SUMMARY_BUBBLE_FACET, SUMMARY_BUBBLES, type SummaryBubbleFacet } from './bubble-facet'
import { themes } from '../../lib/theme/themes'

/**
 * The mod side of the facet contract, end to end through the real registry and
 * the real theme list — no test doubles, because what is being checked is that
 * a mod registering itself at import time actually reaches theme resolution.
 */

const bubbleFor = (themeId: string) =>
  resolveModFacet(themeId, SUMMARY_BUBBLE_FACET) as SummaryBubbleFacet

describe('the summary-chat bubble facet', () => {
  it('resolves for every theme, including ones the mod says nothing about', () => {
    for (const theme of themes()) {
      expect(bubbleFor(theme.id), theme.id).toBeDefined()
      expect(typeof bubbleFor(theme.id).Component).toBe('function')
    }
  })

  it('gives the grid theme the mod\'s own variant', () => {
    // The mod names the theme; the theme knows nothing about the mod.
    expect(bubbleFor('grid')).toBe(SUMMARY_BUBBLES.technical)
  })

  it('gives every other theme the default', () => {
    expect(bubbleFor('default')).toBe(SUMMARY_BUBBLES.speech)
    expect(bubbleFor('nebula')).toBe(SUMMARY_BUBBLES.speech)
  })

  it('does not appear among the core facets', () => {
    // A mod facet must not leak into the typed core set, or uninstalling the
    // mod would leave a hole in ThemeFacets.
    expect(SUMMARY_BUBBLE_FACET).toContain(':')
  })
})
