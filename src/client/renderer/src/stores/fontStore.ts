import { create } from 'zustand'

export const MONO_FONT = 'Menlo, Monaco, "Courier New", monospace'

export interface FontTheme {
  id: string
  label: string
  fontFamily: string
  fontSize: number
  fontWeight: number
  boldWeight: number
  lineHeight: number   // multiplier applied to CELL_HEIGHT
  verticalOffset: number // px nudge for text baseline alignment
}

export const FONT_THEMES: FontTheme[] = [
  {
    id: 'system',
    label: 'System Sans',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
    fontSize: 14,
    fontWeight: 400,
    boldWeight: 700,
    lineHeight: 1.0,
    verticalOffset: 1,
  },
  {
    id: 'compact',
    label: 'Compact',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
    fontSize: 12,
    fontWeight: 400,
    boldWeight: 600,
    lineHeight: 1.0,
    verticalOffset: 2,
  },
  {
    id: 'serif',
    label: 'Serif',
    fontFamily: 'Georgia, "Times New Roman", Times, serif',
    fontSize: 14,
    fontWeight: 400,
    boldWeight: 700,
    lineHeight: 1.0,
    verticalOffset: 1,
  },
  {
    id: 'readable',
    label: 'Large Readable',
    fontFamily: 'Charter, "Bitstream Charter", "Sitka Text", Cambria, serif',
    fontSize: 16,
    fontWeight: 400,
    boldWeight: 700,
    lineHeight: 1.0,
    verticalOffset: 0,
  },
  {
    id: 'tight',
    label: 'Tight Sans',
    fontFamily: '"SF Pro Text", "Helvetica Neue", Helvetica, Arial, sans-serif',
    fontSize: 13,
    fontWeight: 300,
    boldWeight: 600,
    lineHeight: 1.0,
    verticalOffset: 2,
  },
]

const DEFAULT_THEME_ID = 'system'

function loadThemeId(): string {
  return localStorage.getItem('toolbar.fontThemeId') ?? DEFAULT_THEME_ID
}

function resolveTheme(id: string): FontTheme {
  return FONT_THEMES.find(t => t.id === id) ?? FONT_THEMES[0]
}

interface FontState {
  proportional: boolean
  themeId: string
  theme: FontTheme
  toggle: () => void
  setThemeId: (id: string) => void
}

export const useFontStore = create<FontState>((set, get) => ({
  proportional: localStorage.getItem('toolbar.proportionalFont') === 'true',
  themeId: loadThemeId(),
  theme: resolveTheme(loadThemeId()),
  toggle: () => {
    const next = !get().proportional
    localStorage.setItem('toolbar.proportionalFont', String(next))
    set({ proportional: next })
  },
  setThemeId: (id: string) => {
    localStorage.setItem('toolbar.fontThemeId', id)
    set({ themeId: id, theme: resolveTheme(id) })
  },
}))

/** Convenience: the currently active proportional font family (for imports that just need the string). */
export const PROPORTIONAL_FONT = FONT_THEMES[0].fontFamily
