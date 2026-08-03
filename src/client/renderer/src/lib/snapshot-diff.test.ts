import { describe, it, expect } from 'vitest'
import { sameRow, planRepaint, type PaintedState } from './snapshot-diff'
import type { SnapshotRow } from '../../../../shared/protocol'

const row = (...spans: SnapshotRow): SnapshotRow => spans

/** A screen of `n` rows, each holding its own index as text. */
function screen(n: number): SnapshotRow[] {
  return Array.from({ length: n }, (_, i) => row({ text: `line ${i}`, fg: '#fff', bg: '#000' }))
}

const painted = (lines: SnapshotRow[], key = 'k'): PaintedState => ({ key, lines })

describe('planRepaint', () => {
  it('paints everything when there is nothing on the canvas yet', () => {
    expect(planRepaint(null, 'k', screen(3))).toEqual({ kind: 'full' })
  })

  it('paints everything when the drawing conditions changed', () => {
    // Same rows, different key — a font or background change under identical text.
    const lines = screen(3)
    expect(planRepaint(painted(lines, 'old'), 'new', lines)).toEqual({ kind: 'full' })
  })

  it('paints everything when the caller says the bitmap was blanked', () => {
    const lines = screen(3)
    expect(planRepaint(painted(lines), 'k', lines, true)).toEqual({ kind: 'full' })
  })

  it('paints nothing when an identical snapshot arrives', () => {
    // The common case: the server re-serializes the whole screen every tick, so
    // an unchanged terminal still delivers a full set of fresh row objects.
    const before = screen(40)
    expect(planRepaint(painted(before), 'k', screen(40))).toEqual({ kind: 'rows', rows: [] })
  })

  it('paints only the rows that changed', () => {
    const before = screen(40)
    const after = screen(40)
    after[7] = row({ text: 'changed', fg: '#fff', bg: '#000' })
    after[31] = row({ text: 'also changed', fg: '#fff', bg: '#000' })

    const plan = planRepaint(painted(before), 'k', after)
    expect(plan).toEqual({ kind: 'rows', rows: [7, 31] })
  })

  it('catches a change that only touches colour', () => {
    const before = screen(5)
    const after = screen(5)
    after[2] = row({ text: 'line 2', fg: '#f00', bg: '#000' })
    expect(planRepaint(painted(before), 'k', after)).toEqual({ kind: 'rows', rows: [2] })
  })
})

describe('sameRow', () => {
  it('matches structurally equal rows built from different objects', () => {
    expect(sameRow(
      row({ text: 'hello', fg: '#fff', bg: '#000' }),
      row({ text: 'hello', fg: '#fff', bg: '#000' })
    )).toBe(true)
  })

  it('is true for the identical reference', () => {
    const r = row({ text: 'x', fg: '#fff', bg: '#000' })
    expect(sameRow(r, r)).toBe(true)
  })

  it('detects a text change', () => {
    expect(sameRow(
      row({ text: 'hello', fg: '#fff', bg: '#000' }),
      row({ text: 'hellp', fg: '#fff', bg: '#000' })
    )).toBe(false)
  })

  it('detects colour changes with identical text', () => {
    const base = row({ text: 'hi', fg: '#fff', bg: '#000' })
    expect(sameRow(base, row({ text: 'hi', fg: '#f00', bg: '#000' }))).toBe(false)
    expect(sameRow(base, row({ text: 'hi', fg: '#fff', bg: '#111' }))).toBe(false)
  })

  it('detects attribute changes with identical text and colour', () => {
    const base = row({ text: 'hi', fg: '#fff', bg: '#000' })
    expect(sameRow(base, row({ text: 'hi', fg: '#fff', bg: '#000', bold: true }))).toBe(false)
    expect(sameRow(base, row({ text: 'hi', fg: '#fff', bg: '#000', italic: true }))).toBe(false)
    expect(sameRow(base, row({ text: 'hi', fg: '#fff', bg: '#000', underline: true }))).toBe(false)
  })

  it('treats an absent attribute and an explicit false as the same', () => {
    // The server omits falsy attributes, but a row that has been through a
    // round of JSON may carry either shape; they paint identically.
    expect(sameRow(
      row({ text: 'hi', fg: '#fff', bg: '#000' }),
      row({ text: 'hi', fg: '#fff', bg: '#000', bold: false, italic: false, underline: false })
    )).toBe(true)
  })

  it('detects a re-split of the same text into different spans', () => {
    // Same painted characters, but the span boundaries carry the colour, so a
    // different split is a different row.
    expect(sameRow(
      row({ text: 'ab', fg: '#fff', bg: '#000' }),
      row({ text: 'a', fg: '#fff', bg: '#000' }, { text: 'b', fg: '#fff', bg: '#000' })
    )).toBe(false)
  })

  it('handles empty rows and missing rows', () => {
    expect(sameRow([], [])).toBe(true)
    expect(sameRow(undefined, [])).toBe(false)
    expect(sameRow([], undefined)).toBe(false)
    expect(sameRow(undefined, undefined)).toBe(true)
  })
})
