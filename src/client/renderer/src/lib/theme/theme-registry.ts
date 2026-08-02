import type { Theme } from './themes'

/**
 * The runtime theme registry — what lets a mod contribute a theme.
 *
 * `THEMES` used to be a `const` array, and MODDING.md's standing advice is not
 * to make a registry dynamic until something needs it. A mod shipping a whole
 * look is that something, and so is the case this was really built for: a mod
 * whose theme dresses a facet belonging to *a different mod*.
 *
 * ## Why that case works with no coupling
 *
 * A theme names facets by string. `Theme.modFacets` is keyed by facet id and
 * valued `unknown`, so a theme from mod A can carry an entry for
 * `mod-b:indicator` without importing anything from mod B, without mod B being
 * installed, and without either mod knowing the other exists at build time.
 * The only shared knowledge is the string key — which is exactly the surface a
 * mod author would document for others to target.
 *
 * If mod B is absent the entry is inert. If mod B is present it wins over mod
 * B's own default, because a theme's explicit override sits above the facet
 * owner's `byTheme` in the resolution order (see `./registry`).
 *
 * ## Registration order
 *
 * Registration is expected in a mod's *theme phase*, before its main body
 * runs, so the picker and a persisted theme id both see a complete list. But
 * nothing here depends on that: resolution reads the registry live, and
 * registering a theme notifies subscribers, so a theme that arrives late still
 * appears — and if it is the one the user had selected, it takes effect. That
 * makes the phase an optimisation rather than a correctness requirement, which
 * is the right way round for something a third party controls.
 */

const themes = new Map<string, Theme>()
const listeners = new Set<() => void>()

/**
 * Cached so `useSyncExternalStore` sees a stable identity between changes —
 * returning a fresh array each call would re-render every subscriber forever.
 */
let snapshot: readonly Theme[] = []

function refreshSnapshot(): void {
  snapshot = [...themes.values()]
  for (const listener of listeners) listener()
}

/**
 * Add or replace a theme.
 *
 * Mod themes must namespace their id (`my-mod:midnight`) for the same reason
 * facets do: two mods may both want `midnight`, and a mod must not be able to
 * take over a built-in id. Base themes use bare ids.
 *
 * @throws if a namespaced id is malformed.
 */
export function registerTheme(theme: Theme): void {
  const parts = theme.id.split(':')
  if (parts.length > 2) {
    throw new Error(`theme id "${theme.id}" has more than one ":" — use <modId>:<themeName>`)
  }
  if (parts.length === 2 && (!parts[0] || !parts[1])) {
    throw new Error(`theme id "${theme.id}" must be <modId>:<themeName>, both non-empty`)
  }
  themes.set(theme.id, theme)
  refreshSnapshot()
}

/** Every registered theme, in registration order. Base themes first. */
export function allThemes(): readonly Theme[] {
  return snapshot
}

export function getRegisteredTheme(id: string): Theme | undefined {
  return themes.get(id)
}

/** Subscribe to registrations. Returns an unsubscribe. */
export function subscribeThemes(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Test seam: forget everything. Never call this from app code. */
export function resetThemeRegistryForTests(): void {
  themes.clear()
  refreshSnapshot()
}
