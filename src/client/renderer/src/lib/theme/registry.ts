/**
 * The runtime facet registry — what lets something outside the base app add a
 * themeable facet.
 *
 * ## The problem this solves
 *
 * `ThemeFacets` in `./facets` is a closed interface, and that is exactly what
 * makes the core facets pleasant: `useFacet('rootNode')` is typed, a facet
 * added to the interface but not to `DEFAULT_FACETS` fails to compile, and a
 * test can assert the runtime list matches the type. None of that survives
 * contact with a mod. A mod is compiled separately (eventually, loaded
 * separately), so it cannot widen an interface in this repo, and this repo
 * cannot name a type the mod owns.
 *
 * So facets come in two kinds, and the split is deliberate rather than
 * regrettable — it is the same line `ToolbarWidget` drew between standalone
 * and host widgets:
 *
 * - **Core facets** (`background`, `rootNode`, …) have bare ids, live in the
 *   `ThemeFacets` interface, and keep full static typing.
 * - **Mod facets** have namespaced ids (`summary-chat:bubble`) and are
 *   registered here at import time. The base app stores and resolves them
 *   without knowing their shape; the *mod* owns the type and exports a typed
 *   accessor, so a mod's consumers are still type-safe. Only the base's
 *   bookkeeping is `unknown`, and it never needs to look inside.
 *
 * ## Resolution order
 *
 * 1. The active theme's own override, if it names this facet.
 * 2. The facet owner's per-theme variant, from `byTheme`.
 * 3. The facet's default.
 *
 * Step 2 is what keeps the dependency arrow pointing one way. A base theme
 * cannot import from a mod to say "and here is my speech bubble" — the mod may
 * not be installed, and the base must not depend on it. Instead the *mod*
 * ships its own variants per theme: "if the grid theme is active, draw the
 * bubble like this". The mod already depends on the base, so naming a base
 * theme id costs nothing, and a theme it has never heard of simply gets the
 * default.
 *
 * Step 1 still wins, so a theme that *does* know about a mod (a mod's own
 * bundled theme, say) can override it outright.
 */

/** `<modId>:<facetName>`. The colon is what marks an id as not-core. */
export type ModFacetId = `${string}:${string}`

export interface FacetDefinition<V> {
  /** Bare for core facets, namespaced for mod facets. */
  readonly id: string
  /** Used when neither the theme nor `byTheme` supplies one. */
  readonly defaultValue: V
  /**
   * Variants keyed by theme id, supplied by whoever owns the facet.
   * Lets a mod dress itself for the base's themes without the base knowing.
   */
  readonly byTheme?: Readonly<Record<string, V>>
}

const definitions = new Map<string, FacetDefinition<unknown>>()

export function isModFacetId(id: string): id is ModFacetId {
  return id.includes(':')
}

/**
 * Register a facet. Idempotent per id — a second registration replaces the
 * first, so a module re-imported under a different path does not throw, but a
 * genuine collision between two mods is caught below.
 *
 * @throws if a mod facet's id is not namespaced, or if two different owners
 * claim the same id.
 */
export function registerFacet<V>(definition: FacetDefinition<V>): void {
  const { id } = definition
  if (id.length === 0) throw new Error('facet id must not be empty')

  const colonCount = id.split(':').length - 1
  if (colonCount > 1) {
    throw new Error(`facet id "${id}" has more than one ":" — use <modId>:<facetName>`)
  }
  if (colonCount === 1) {
    const [modId, facetName] = id.split(':')
    if (!modId || !facetName) {
      throw new Error(`facet id "${id}" must be <modId>:<facetName>, both non-empty`)
    }
  }

  definitions.set(id, definition as FacetDefinition<unknown>)
}

/** Registered ids, in registration order. Core facets register first. */
export function registeredFacetIds(): string[] {
  return [...definitions.keys()]
}

export function isFacetRegistered(id: string): boolean {
  return definitions.has(id)
}

/**
 * The value a facet resolves to for a theme, given that theme's own override.
 *
 * `themeOverride` is passed in rather than looked up because the registry
 * deliberately knows nothing about themes — that lookup lives in `./themes`,
 * which owns what a theme *is*.
 *
 * Returns `undefined` for an unregistered id. That is the normal case for a
 * theme that overrides a facet whose mod is not installed: the override sits
 * inert rather than erroring, and starts working if the mod ever loads. It
 * also makes registration order irrelevant.
 */
export function resolveRegisteredFacet(
  id: string,
  themeId: string,
  themeOverride: unknown,
): unknown {
  if (themeOverride !== undefined) return themeOverride
  const definition = definitions.get(id)
  if (!definition) return undefined
  return definition.byTheme?.[themeId] ?? definition.defaultValue
}

/** Test seam: forget everything. Never call this from app code. */
export function resetFacetRegistryForTests(): void {
  definitions.clear()
}
