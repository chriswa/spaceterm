import { describe, expect, it } from 'vitest'
import { applyAnsi, renderAnsiState, INITIAL_ANSI_STATE } from './ansi-state'

/**
 * Tests for the cumulative-ANSI-state tracker that lets a truncated scrollback
 * be replayed without losing state set before the cut. See ansi-state.ts and
 * ANSI_PRESERVATION_BUG.md for what each of these categories corrupts when lost.
 */

/** Fold text into the initial state and render what would be re-emitted. */
function carried(text: string): string {
  return renderAnsiState(applyAnsi(INITIAL_ANSI_STATE, text))
}

describe('applyAnsi / renderAnsiState', () => {
  it('emits nothing for text that sets no cumulative state', () => {
    expect(carried('plain output\nwith newlines\n')).toBe('')
  })

  it('emits nothing for sequences that carry no cumulative state', () => {
    // Cursor moves and erases are position-relative; the replayed tail redoes them.
    expect(carried('\x1b[2J\x1b[10;5H\x1b[Ktext')).toBe('')
  })

  it('carries a basic foreground colour', () => {
    expect(carried('\x1b[31mred')).toBe('\x1b[0;31m')
  })

  it('carries the last colour when several are set', () => {
    expect(carried('\x1b[31ma\x1b[32mb\x1b[34mc')).toBe('\x1b[0;34m')
  })

  it('drops all attributes after a reset', () => {
    expect(carried('\x1b[1;31mstyled\x1b[0mplain')).toBe('')
  })

  it('treats a bare ESC[m as a reset', () => {
    expect(carried('\x1b[1;31mstyled\x1b[mplain')).toBe('')
  })

  it('carries combined attributes and both colours', () => {
    expect(carried('\x1b[1m\x1b[4m\x1b[31m\x1b[42m')).toBe('\x1b[0;1;4;31;42m')
  })

  it('turns individual attributes back off', () => {
    expect(carried('\x1b[1;4mboth\x1b[24munderline off')).toBe('\x1b[0;1m')
  })

  it('treats 22 as clearing both bold and dim', () => {
    expect(carried('\x1b[1;2m\x1b[22m')).toBe('')
  })

  it('carries a 256-colour foreground without misreading its sub-parameters', () => {
    // 5 and 208 are parameters of 38, not separate blink/unknown codes.
    expect(carried('\x1b[38;5;208m')).toBe('\x1b[0;38;5;208m')
  })

  it('carries a truecolor background without misreading its sub-parameters', () => {
    expect(carried('\x1b[48;2;10;20;30m')).toBe('\x1b[0;48;2;10;20;30m')
  })

  it('carries extended colours combined with attributes in one sequence', () => {
    expect(carried('\x1b[1;38;2;1;2;3;4m')).toBe('\x1b[0;1;4;38;2;1;2;3m')
  })

  it('resets colour to default on 39 and 49', () => {
    expect(carried('\x1b[31;42m\x1b[39;49m')).toBe('')
  })

  it('carries the alternate screen buffer', () => {
    expect(carried('\x1b[?1049h')).toBe('\x1b[?1049h')
  })

  it('drops the alternate screen buffer once it is left', () => {
    expect(carried('\x1b[?1049h\x1b[?1049l')).toBe('\x1b[?1049l')
  })

  it('carries the scroll region', () => {
    expect(carried('\x1b[2;24r')).toBe('\x1b[2;24r')
  })

  it('clears the scroll region on a parameterless DECSTBM', () => {
    expect(carried('\x1b[2;24r\x1b[r')).toBe('')
  })

  it('carries the DEC line-drawing charset', () => {
    expect(carried('\x1b(0')).toBe('\x1b(0')
  })

  it('carries a switch back to the ASCII charset', () => {
    expect(carried('\x1b(0\x1b(B')).toBe('\x1b(B')
  })

  it('carries cursor visibility and bracketed paste', () => {
    expect(carried('\x1b[?25l\x1b[?2004h')).toBe('\x1b[?25l\x1b[?2004h')
  })

  it('carries mouse reporting modes', () => {
    expect(carried('\x1b[?1003h\x1b[?1006h')).toBe('\x1b[?1003h\x1b[?1006h')
  })

  it('handles several private modes set in one sequence', () => {
    expect(carried('\x1b[?1000;1006h')).toBe('\x1b[?1000h\x1b[?1006h')
  })

  it('ignores private modes outside the tracked set', () => {
    // Re-emitting an unrecognised mode is riskier than dropping it.
    expect(carried('\x1b[?9999h')).toBe('')
  })

  it('does not treat a private-mode sequence as SGR', () => {
    expect(carried('\x1b[?25h')).toBe('\x1b[?25h')
  })

  it('clears everything on RIS', () => {
    expect(carried('\x1b[1;31m\x1b[?1049h\x1b[2;24r\x1b(0\x1bc')).toBe('')
  })

  it('orders the alternate-screen switch before the scroll region and pen', () => {
    // ?1049h clears the buffer, so emitting it after the scroll region or SGR
    // would undo them on the replaying client.
    const out = carried('\x1b[31m\x1b[2;24r\x1b[?1049h')
    expect(out.indexOf('\x1b[?1049h')).toBeLessThan(out.indexOf('\x1b[2;24r'))
    expect(out.indexOf('\x1b[2;24r')).toBeLessThan(out.indexOf('m'))
  })

  it('accumulates across successive applyAnsi calls', () => {
    // This is how ScrollbackBuffer folds state forward over repeated trims.
    const first = applyAnsi(INITIAL_ANSI_STATE, '\x1b[?1049h')
    const second = applyAnsi(first, '\x1b[31m')
    expect(renderAnsiState(second)).toBe('\x1b[?1049h\x1b[0;31m')
  })

  it('lets a later chunk override an earlier chunk', () => {
    const first = applyAnsi(INITIAL_ANSI_STATE, '\x1b[31m')
    const second = applyAnsi(first, '\x1b[0m')
    expect(renderAnsiState(second)).toBe('')
  })

  it('does not mutate the state passed in', () => {
    const before = applyAnsi(INITIAL_ANSI_STATE, '\x1b[31m')
    const rendered = renderAnsiState(before)
    applyAnsi(before, '\x1b[32m\x1b[?1049h')
    expect(renderAnsiState(before)).toBe(rendered)
  })
})
