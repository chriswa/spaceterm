import { useEffect, useSyncExternalStore } from 'react'
import { useThemeStore } from '../stores/themeStore'
import { resolveFacet, resolveModFacet } from '../lib/theme/themes'
import type { FacetId, ThemeFacets } from '../lib/theme/facets'
import type { ModFacetId } from '../lib/theme/registry'
import { allThemes, subscribeThemes } from '../lib/theme/theme-registry'
import type { Theme } from '../lib/theme/themes'

/**
 * The active theme's implementation of one facet, re-rendering when it changes.
 *
 * Selecting on the resolved facet rather than on the theme id means a
 * component only re-renders when *its* facet actually changes: switching
 * between two themes that share a root node does not touch the root node.
 */
export function useFacet<K extends FacetId>(facet: K): ThemeFacets[K] {
  return useThemeStore(s => resolveFacet(s.themeId, facet))
}

/**
 * The same, outside React.
 *
 * For imperative code that runs between renders — a rAF loop painting a glow,
 * a pointer handler restyling an element it holds a reference to. Reading the
 * store at the moment of use is deliberately *not* equivalent to `useFacet`:
 * it cannot go stale in a closure, and it cannot re-render anything either, so
 * whatever it paints must be repainted by its own loop.
 */
export function currentFacet<K extends FacetId>(facet: K): ThemeFacets[K] {
  return resolveFacet(useThemeStore.getState().themeId, facet)
}

/**
 * A mod-supplied facet, by namespaced id.
 *
 * `V` is supplied by the caller because the base has no way to know it — the
 * type belongs to whichever mod registered the facet. A mod is expected to
 * wrap this once and export the wrapper, so its own consumers never write the
 * type parameter or the raw id:
 *
 * ```ts
 * export const useBubbleFacet = () => useModFacet<BubbleFacet>(BUBBLE_FACET)!
 * ```
 *
 * Returns `undefined` when nothing has registered that id, which is what a
 * caller sees if the owning mod failed to load. A mod reading its *own* facet
 * can assert non-null — its registration ran at import — but a consumer
 * reading another mod's facet should handle the absence.
 */
export function useModFacet<V>(facetId: ModFacetId): V | undefined {
  return useThemeStore(s => resolveModFacet(s.themeId, facetId) as V | undefined)
}

/** `useModFacet` outside React. See `currentFacet` for when that is right. */
export function currentModFacet<V>(facetId: ModFacetId): V | undefined {
  return resolveModFacet(useThemeStore.getState().themeId, facetId) as V | undefined
}

/**
 * Publish the `cardChrome` facet's custom properties on the document root.
 *
 * Card chrome is the one facet that is neither a shader nor a component — it
 * is a handful of values that CSS rules already written in `index.css` read
 * through `var()`. Pushing them onto `:root` is how a facet reaches stylesheet
 * rules it does not own, and it is why those rules keep working unchanged when
 * a theme has nothing to say about chrome.
 *
 * Call once, from the app root.
 */
export function useCardChromeVars(): void {
  const chrome = useFacet('cardChrome')

  useEffect(() => {
    const root = document.documentElement
    for (const [name, value] of Object.entries(chrome.vars)) {
      root.style.setProperty(name, value)
    }
    return () => {
      // Removed rather than left behind: a facet that drops a property should
      // fall back to the stylesheet's own value, not to the last theme's.
      for (const name of Object.keys(chrome.vars)) root.style.removeProperty(name)
    }
  }, [chrome])
}

/**
 * Every registered theme, re-rendering when a mod adds one.
 *
 * `useSyncExternalStore` rather than a zustand store because the theme
 * registry is plain module state that non-React code also reads — the store
 * would be a second source of truth for the same list.
 */
export function useThemes(): readonly Theme[] {
  return useSyncExternalStore(subscribeThemes, allThemes, allThemes)
}
