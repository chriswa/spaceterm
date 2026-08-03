import { describe, it, expect } from 'vitest'
import type { Terminal } from '@xterm/xterm'
import { letterSpacingForCellWidth, renderedCellWidth, watchDevicePixelRatio } from './cell-metrics'
import { CELL_WIDTH } from './constants'

/**
 * How xterm's WebGL renderer turns a measured glyph advance into a cell.
 *
 * Lifted from `addon-webgl`'s `_updateDimensions`: the advance is floored to
 * whole device pixels *before* letterSpacing is added, which is the rounding
 * that has to be corrected and the reason the correction is in device pixels.
 */
function webglCellWidth(advance: number, dpr: number, letterSpacing: number): number {
  return (Math.floor(advance * dpr) + Math.round(letterSpacing)) / dpr
}

/** xterm's measurement of Menlo 14px: `offsetWidth` 270 for 32 columns. */
const MENLO_14 = 8.4375

/** Every ratio the app can realistically be rendered at. */
const RATIOS = [1, 1.25, 1.5, 2, 2.5, 3]

function fakeTerminal(cellWidth: unknown): Terminal {
  return { _core: { _renderService: { dimensions: { css: { cell: { width: cellWidth } } } } } } as unknown as Terminal
}

describe('letterSpacingForCellWidth', () => {
  it('lands the rendered cell exactly on the grid unit, at every ratio', () => {
    for (const dpr of RATIOS) {
      const rendered = webglCellWidth(MENLO_14, dpr, 0)
      const spacing = letterSpacingForCellWidth(0, rendered, dpr)
      expect(webglCellWidth(MENLO_14, dpr, spacing)).toBe(CELL_WIDTH)
    }
  })

  it('asks for nothing where the font already lands on the grid', () => {
    // Menlo 14px floors to 8.0 at both dpr 1 and dpr 2 — the ratios this app
    // actually runs at — so the fix is a guard there, not a visual change.
    for (const dpr of [1, 2]) {
      expect(webglCellWidth(MENLO_14, dpr, 0)).toBe(CELL_WIDTH)
      expect(letterSpacingForCellWidth(0, CELL_WIDTH, dpr)).toBe(0)
    }
  })

  it('corrects a ratio where the floor leaves the cell too wide', () => {
    // dpr 3: floor(8.4375 * 3) / 3 = 25/3, a third of a pixel over.
    const rendered = webglCellWidth(MENLO_14, 3, 0)
    expect(rendered).toBeGreaterThan(CELL_WIDTH)
    expect(letterSpacingForCellWidth(0, rendered, 3)).toBe(-1)
  })

  it('corrects the spacing already in force rather than replacing it', () => {
    // It is handed what the renderer drew *with* the current spacing applied,
    // so the result has to be a delta on top of it.
    const dpr = 2
    const rendered = webglCellWidth(MENLO_14, dpr, 3)
    const spacing = letterSpacingForCellWidth(3, rendered, dpr)
    expect(spacing).toBe(0)
    expect(webglCellWidth(MENLO_14, dpr, spacing)).toBe(CELL_WIDTH)
  })

  it('leaves the spacing alone when there is nothing meaningful to measure', () => {
    for (const rendered of [0, -1, NaN, Infinity]) {
      expect(letterSpacingForCellWidth(2, rendered, 2)).toBe(2)
    }
    for (const dpr of [0, -1, NaN]) {
      expect(letterSpacingForCellWidth(2, CELL_WIDTH + 1, dpr)).toBe(2)
    }
  })
})

describe('renderedCellWidth', () => {
  it('reads the width the active renderer settled on', () => {
    expect(renderedCellWidth(fakeTerminal(8.4375))).toBe(8.4375)
  })

  it('reports nothing rather than a bogus width when there is no measurement', () => {
    // Before the renderer has measured, in jsdom where the measure element has
    // no width, or if a future xterm moves the field — all cases where the
    // caller must skip the correction, not apply one computed from zero.
    expect(renderedCellWidth({} as Terminal)).toBeNull()
    expect(renderedCellWidth(fakeTerminal(0))).toBeNull()
    expect(renderedCellWidth(fakeTerminal(NaN))).toBeNull()
    expect(renderedCellWidth(fakeTerminal(undefined))).toBeNull()
  })
})

describe('watchDevicePixelRatio', () => {
  it('returns a working disposer even where the query cannot be built', () => {
    // jsdom parses `(resolution: 2dppx)` poorly; a terminal must still mount
    // and tear down cleanly there.
    const stop = watchDevicePixelRatio(() => {})
    expect(() => stop()).not.toThrow()
    expect(() => stop()).not.toThrow()
  })
})
