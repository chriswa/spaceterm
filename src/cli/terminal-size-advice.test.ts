import { describe, it, expect } from 'vitest'
import { parseSizeArg, sizeThatFitsHere } from './terminal-size-advice'
import { MIN_COLS, MIN_ROWS, MAX_COLS, MAX_ROWS } from '../shared/node-size'

/**
 * The two pure pieces of the emergency terminal's resize escape hatch.
 *
 * A surface can be made larger than any physical terminal, so "your window is
 * too small" is a reachable dead end. What gets someone out of it is the size
 * this computes and prints as a ready-to-run command — so it has to be a size
 * the server will actually accept, and it has to be honest when no size helps.
 */

describe('parseSizeArg', () => {
  it('accepts COLSxROWS', () => {
    expect(parseSizeArg('120x39')).toEqual({ cols: 120, rows: 39 })
  })

  it('tolerates the shapes a person actually types', () => {
    expect(parseSizeArg('120X39')).toEqual({ cols: 120, rows: 39 })
    expect(parseSizeArg(' 120x39 ')).toEqual({ cols: 120, rows: 39 })
    expect(parseSizeArg('120×39')).toEqual({ cols: 120, rows: 39 })
  })

  it('rejects anything else rather than guessing', () => {
    // A silent "no resize" would connect at the old size and hit the same
    // fatal, which reads as the flag not working.
    for (const bad of ['120', 'x39', '120x', 'wide', '120*39', '', '-120x39', '12.5x39']) {
      expect(parseSizeArg(bad), bad).toBeNull()
    }
  })
})

describe('sizeThatFitsHere', () => {
  it('leaves tmux its status row', () => {
    expect(sizeThatFitsHere(200, 60)).toMatchObject({ cols: 200, rows: 59, fits: true })
  })

  it('suggests only sizes the server would accept', () => {
    const huge = sizeThatFitsHere(10_000, 10_000)
    expect(huge.cols).toBe(MAX_COLS)
    expect(huge.rows).toBe(MAX_ROWS)
  })

  it('says so when the window cannot hold the minimum, instead of suggesting a lie', () => {
    // Clamping alone would hand back 80x24 for a 40x10 window — a command that
    // runs, then fails exactly as before.
    expect(sizeThatFitsHere(40, 10).fits).toBe(false)
    expect(sizeThatFitsHere(MIN_COLS - 1, MIN_ROWS + 5).fits).toBe(false)
    expect(sizeThatFitsHere(MIN_COLS, MIN_ROWS).fits).toBe(false) // the status row costs one
    expect(sizeThatFitsHere(MIN_COLS, MIN_ROWS + 1).fits).toBe(true)
  })
})
