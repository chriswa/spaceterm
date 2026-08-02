import {
  BACKGROUNDS,
  CARD_CHROMES,
  DEFAULT_FACETS,
  EDGES,
  NODE_TINTS,
  ROOT_NODES,
  type FacetId,
  type ThemeFacets,
} from './facets'
import { resolveRegisteredFacet, type ModFacetId } from './registry'
import { allThemes, getRegisteredTheme, registerTheme } from './theme-registry'

/**
 * The themes, as data.
 *
 * A theme names the facets it changes and nothing else. Everything unnamed
 * comes from `DEFAULT_FACETS`, so a theme is a diff against the default look
 * rather than a full description of one — which is what keeps adding a facet
 * from being an edit to every theme.
 */
export interface Theme {
  /** Stable id. Persisted to `localStorage`, so renaming one resets the user. */
  readonly id: string
  readonly label: string
  /** One line under the label in the picker. Say what it costs. */
  readonly blurb: string
  /** The core facets this theme overrides. Absent keys fall through to the default. */
  readonly facets: Partial<ThemeFacets>
  /**
   * Overrides for namespaced facets supplied by mods, e.g.
   * `{ 'summary-chat:bubble': … }`.
   *
   * Separate from `facets`, and `unknown`-valued, because it is the half the
   * base cannot type-check: the value's shape belongs to the mod. Keeping the
   * two apart means the core half stays fully checked instead of both halves
   * degrading to the weaker guarantee.
   *
   * An entry naming a facet no mod has registered is inert rather than an
   * error — a theme should not break when a mod is uninstalled. Most themes
   * will leave this empty and let mods dress themselves through
   * `FacetDefinition.byTheme`, which needs no cooperation from the theme.
   */
  readonly modFacets?: Readonly<Record<string, unknown>>
}

/**
 * The themes this repo ships. Registered below into the same runtime registry
 * a mod uses, so `allThemes()` is the single list and mod themes appear in the
 * picker alongside these.
 *
 * Ordered cheapest first, since the default leads and the rest are departures
 * from it.
 *
 * `default` deliberately overrides *nothing*: it is `DEFAULT_FACETS` given a
 * name. That is the whole reason the default look and the fall-through cannot
 * disagree — there is only one copy of it, in `./facets`.
 */
export const DEFAULT_THEME_ID = 'default'

/**
 * The one theme that must always exist.
 *
 * Held as its own constant so `resolveTheme` can be *total*: it is both the
 * registered default and the last-resort return value, so no lookup path ends
 * in `undefined`. That matters more now that registration is open — a mod that
 * clears or fails to populate the registry should degrade to plain defaults,
 * not crash the renderer on the next frame.
 */
const FALLBACK_THEME: Theme = {
  id: DEFAULT_THEME_ID,
  label: 'Default',
  blurb: 'Radial glow, drifting chevrons — cheapest to draw',
  facets: {},
}

const BUILT_IN_THEMES: readonly Theme[] = [
  FALLBACK_THEME,
  {
    id: 'grid',
    label: 'Grid',
    blurb: 'Logarithmic grid, still chevrons, colour only where you set it',
    facets: {
      background: BACKGROUNDS.grid,
      edges: EDGES.grid,
      rootNode: ROOT_NODES.reticle,
      cardChrome: CARD_CHROMES.technical,
      nodeTint: NODE_TINTS.neutral,
    },
  },
  {
    id: 'nebula',
    label: 'Nebula',
    blurb: '7 octaves of 3D noise, twice per edge pixel — animated orb',
    facets: {
      background: BACKGROUNDS.nebula,
      edges: EDGES.nebula,
      rootNode: ROOT_NODES.orb,
      cardChrome: CARD_CHROMES.hairline,
    },
  },
]

for (const theme of BUILT_IN_THEMES) registerTheme(theme)

/**
 * Every theme on offer: this repo's, plus any a mod has registered.
 *
 * Read live rather than captured, so a mod that registers after this module
 * loads still shows up. `useThemes` is the React-facing version.
 */
export function themes(): readonly Theme[] {
  return allThemes()
}

/**
 * The named theme, or the default if the id is unknown.
 *
 * Unknown covers two cases that behave the same and should: a stale
 * `localStorage` naming a theme that was renamed, and a mod theme whose mod has
 * not registered yet or is no longer installed. In the second case the user
 * silently gets the default now and their real theme back the moment the mod
 * registers, because resolution reads the registry on every call.
 */
export function resolveTheme(id: string): Theme {
  return getRegisteredTheme(id) ?? getRegisteredTheme(DEFAULT_THEME_ID) ?? FALLBACK_THEME
}

/**
 * One facet of a theme, falling through to the default when unset.
 *
 * The generic is what makes this worth having over a property access: asking
 * for `'rootNode'` gives back a `RootNodeFacet`, not a union of every facet
 * type, so a caller cannot read `.frag` off a component.
 */
export function resolveFacet<K extends FacetId>(themeId: string, facet: K): ThemeFacets[K] {
  return resolveTheme(themeId).facets[facet] ?? DEFAULT_FACETS[facet]
}

/** Every core facet of a theme at once, with defaults filled in. */
export function resolveFacets(themeId: string): ThemeFacets {
  return { ...DEFAULT_FACETS, ...resolveTheme(themeId).facets }
}

/**
 * A mod-supplied facet's value for a theme, or `undefined` if no mod has
 * registered that id.
 *
 * Untyped here on purpose: the shape belongs to the mod, so the mod is what
 * hands out a typed accessor (see `useModFacet`). The base only routes.
 */
export function resolveModFacet(themeId: string, facetId: ModFacetId): unknown {
  return resolveRegisteredFacet(facetId, themeId, resolveTheme(themeId).modFacets?.[facetId])
}
