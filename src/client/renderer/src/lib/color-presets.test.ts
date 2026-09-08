import { describe, expect, it } from 'vitest'
import { CARD_SURFACE_ALPHA, COLOR_PRESET_MAP, DEFAULT_PRESET, cardSurfaceColor, hexToRgba } from './color-presets'

describe('cardSurfaceColor', () => {
  it('is the preset terminal background at the card surface alpha', () => {
    const teal = COLOR_PRESET_MAP.teal
    expect(cardSurfaceColor(teal)).toBe(hexToRgba(teal.terminalBg, CARD_SURFACE_ALPHA))
  })

  it('falls back to the default preset before a node has resolved one', () => {
    expect(cardSurfaceColor(undefined)).toBe(cardSurfaceColor(DEFAULT_PRESET))
  })

  it('stays translucent so the canvas reads through the card', () => {
    for (const preset of Object.values(COLOR_PRESET_MAP)) {
      expect(cardSurfaceColor(preset)).toMatch(/^rgba\(\d+, \d+, \d+, 0\.5\)$/)
    }
  })
})

describe('hexToRgba', () => {
  it('splits a #rrggbb string into its channels', () => {
    expect(hexToRgba('#04a1ff', 0.25)).toBe('rgba(4, 161, 255, 0.25)')
  })
})
