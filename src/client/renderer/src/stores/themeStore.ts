import { create } from 'zustand'
import { DEFAULT_THEME_ID } from '../lib/theme/themes'

const STORAGE_KEY = 'toolbar.themeId'
/** The boolean this setting used to be: `true` meant the full nebula shader. */
const LEGACY_GOOD_GFX_KEY = 'toolbar.goodGfx'

/**
 * Ids that have been renamed, old → new.
 *
 * `Theme.id` is persisted, and `resolveTheme` falls back to the default for an
 * id it does not recognise — which is right for a mod theme that has not
 * registered yet, and wrong for one this repo renamed, where the user would
 * just find themselves back on the default with no explanation. Renaming a
 * built-in theme means adding a line here.
 *
 * Applied on read rather than rewritten in place: the old value is harmless,
 * and a migration that writes on load would fire for every window that opens.
 */
const RENAMED_THEME_IDS: Readonly<Record<string, string>> = {
  // Was a logarithmic grid; now concentric rings hung off the root node.
  grid: 'concentric',
}

export function migrateThemeId(id: string): string {
  return RENAMED_THEME_IDS[id] ?? id
}

function loadThemeId(): string {
  // Kept even if no theme by that id is registered yet: a mod theme registers
  // after this runs, and `resolveTheme` falls back until it does. Dropping the
  // id here would silently forget the user's choice on every launch.
  const saved = localStorage.getItem(STORAGE_KEY)
  if (saved !== null && saved.length > 0) return migrateThemeId(saved)
  // Migrate the old two-state toggle rather than silently resetting anyone who
  // had turned "Good Gfx" on.
  if (localStorage.getItem(LEGACY_GOOD_GFX_KEY) === 'true') return 'nebula'
  return DEFAULT_THEME_ID
}

interface ThemeState {
  themeId: string
  setThemeId: (id: string) => void
}

/**
 * Which theme is active. Read facets from it with `useFacet`.
 *
 * A store rather than `App.tsx` state because its consumers are scattered —
 * the canvas, the root node, the card chrome, the toolbar picker — and none of
 * them are near each other in the tree. It is also what lets the picker be a
 * *standalone* toolbar widget, with no props from the host at all.
 */
export const useThemeStore = create<ThemeState>((set) => ({
  themeId: loadThemeId(),
  setThemeId: (id: string) => {
    localStorage.setItem(STORAGE_KEY, id)
    set({ themeId: id })
  }
}))
