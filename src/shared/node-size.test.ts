import { describe, it, expect } from 'vitest'
import {
  clampTerminalSize,
  terminalPixelSize,
  terminalSizeFromCorner,
  resizeDraftSize,
  DEFAULT_COLS,
  DEFAULT_ROWS,
  MIN_COLS,
  MIN_ROWS,
  MAX_COLS,
  MAX_ROWS
} from './node-size'

describe('clampTerminalSize', () => {
  it('leaves a size inside the limits alone', () => {
    expect(clampTerminalSize(DEFAULT_COLS, DEFAULT_ROWS)).toEqual({ cols: DEFAULT_COLS, rows: DEFAULT_ROWS })
  })

  it('clamps to the limits rather than rejecting', () => {
    expect(clampTerminalSize(1, 1)).toEqual({ cols: MIN_COLS, rows: MIN_ROWS })
    expect(clampTerminalSize(99999, 99999)).toEqual({ cols: MAX_COLS, rows: MAX_ROWS })
  })

  it('rounds to whole cells — a PTY has no fractional columns', () => {
    expect(clampTerminalSize(100.4, 30.6)).toEqual({ cols: 100, rows: 31 })
  })

  it('turns values that would wrap the daemon\'s uint16 cast into the floor', () => {
    // pty-daemon casts to uint16 without checking, so NaN/Infinity/negatives
    // must never reach it.
    expect(clampTerminalSize(NaN, NaN)).toEqual({ cols: MIN_COLS, rows: MIN_ROWS })
    expect(clampTerminalSize(Infinity, -Infinity)).toEqual({ cols: MAX_COLS, rows: MIN_ROWS })
    expect(clampTerminalSize(-5, -5)).toEqual({ cols: MIN_COLS, rows: MIN_ROWS })
  })

  it('always produces integers within the limits, whatever it is given', () => {
    const inputs = [0, 0.5, -1e9, 1e9, 80.5, 161.49, NaN, Infinity]
    for (const c of inputs) {
      for (const r of inputs) {
        const { cols, rows } = clampTerminalSize(c, r)
        expect(Number.isInteger(cols)).toBe(true)
        expect(Number.isInteger(rows)).toBe(true)
        expect(cols).toBeGreaterThanOrEqual(MIN_COLS)
        expect(cols).toBeLessThanOrEqual(MAX_COLS)
        expect(rows).toBeGreaterThanOrEqual(MIN_ROWS)
        expect(rows).toBeLessThanOrEqual(MAX_ROWS)
      }
    }
  })
})

describe('terminalSizeFromCorner', () => {
  const center = { x: 1000, y: 500 }

  /** Where the bottom-right corner of a card of this size sits, centred on `center`. */
  function cornerOf(cols: number, rows: number): { x: number; y: number } {
    const { width, height } = terminalPixelSize(cols, rows)
    return { x: center.x + width / 2, y: center.y + height / 2 }
  }

  it('inverts terminalPixelSize — the corner of a size maps back to that size', () => {
    for (const [cols, rows] of [[DEFAULT_COLS, DEFAULT_ROWS], [100, 30], [MIN_COLS, MIN_ROWS], [MAX_COLS, MAX_ROWS]]) {
      expect(terminalSizeFromCorner(center, cornerOf(cols, rows))).toEqual({ cols, rows })
    }
  })

  it('grows in both directions — the card is centre-anchored', () => {
    const before = terminalSizeFromCorner(center, cornerOf(120, 40))
    const { width } = terminalPixelSize(before.cols, before.rows)
    // Push the cursor out by one cell; the card gains two columns, one per side.
    const after = terminalSizeFromCorner(center, { x: center.x + width / 2 + 8.4375, y: center.y })
    expect(after.cols).toBe(before.cols + 2)
  })

  it('never returns a fractional size, wherever the cursor lands', () => {
    for (let dx = -50; dx <= 2000; dx += 37) {
      for (let dy = -50; dy <= 900; dy += 41) {
        const { cols, rows } = terminalSizeFromCorner(center, { x: center.x + dx, y: center.y + dy })
        expect(Number.isInteger(cols)).toBe(true)
        expect(Number.isInteger(rows)).toBe(true)
      }
    }
  })

  it('clamps a cursor dragged past the limits, including behind the centre', () => {
    expect(terminalSizeFromCorner(center, { x: center.x - 5000, y: center.y - 5000 }))
      .toEqual({ cols: MIN_COLS, rows: MIN_ROWS })
    expect(terminalSizeFromCorner(center, { x: center.x + 99999, y: center.y + 99999 }))
      .toEqual({ cols: MAX_COLS, rows: MAX_ROWS })
  })

  it('snaps to the default when the modifier is held, wherever the pointer is', () => {
    // An exact target, not a nearest-default heuristic: "put it back how it
    // was" is worth having precisely, and a snap you can miss by a pixel is
    // not a snap.
    for (const dx of [-500, 0, 137, 5000]) {
      expect(resizeDraftSize(center, { x: center.x + dx, y: center.y + dx }, true))
        .toEqual({ cols: DEFAULT_COLS, rows: DEFAULT_ROWS })
    }
  })

  it('follows the pointer when the modifier is not held', () => {
    const cursor = cornerOf(120, 40)
    expect(resizeDraftSize(center, cursor, false)).toEqual({ cols: 120, rows: 40 })
  })

  it('is monotonic — dragging out never shrinks the surface', () => {
    let prev = 0
    for (let dx = 0; dx <= 3000; dx += 25) {
      const { cols } = terminalSizeFromCorner(center, { x: center.x + dx, y: center.y })
      expect(cols).toBeGreaterThanOrEqual(prev)
      prev = cols
    }
  })
})
