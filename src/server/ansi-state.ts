/**
 * Tracks the cumulative ANSI state a terminal stream has established, so that a
 * truncated scrollback can be replayed into a fresh terminal without losing it.
 *
 * Why this exists: ScrollbackBuffer evicts the oldest half of the buffer once it
 * passes 1MB. Terminal state is cumulative — an SGR colour, an alternate-screen
 * switch, a scroll region, a charset shift — stays in effect until something
 * changes it. Cutting the stream at a byte offset silently discards any such
 * sequence that was still active, and every byte after the cut was written by
 * the application assuming it was still set. See ANSI_PRESERVATION_BUG.md for
 * the failure cascade this produces with full-screen (react-ink) applications.
 *
 * The approach: fold the discarded prefix into a small state record, then re-emit
 * that state ahead of the surviving tail. This preserves what was set, unlike
 * prepending a bare RIS reset (option A in the bug doc), and needs nothing from
 * the headless xterm (options B-D), so it stays a pure function of the bytes.
 *
 * Scope: only *cumulative* state is modelled. Cursor position is deliberately
 * not — the replayed tail repositions the cursor itself, and a stale absolute
 * position would be worse than none.
 *
 * IMPORTANT: `renderAnsiState` output is only valid as a prefix to a replay into
 * a *fresh* terminal (which is how getContents() is used — a client attaching
 * gets it before any other bytes). Several of these sequences are not safe to
 * re-apply to a terminal that already has the state: `?1049h` clears the
 * alternate screen as a side effect, so re-sending it to a live terminal would
 * wipe it. Do not repurpose this as a "resync" for an already-attached client.
 */

/** A colour is stored as the raw SGR parameter text, e.g. "31", "38;5;208". */
type Sgr = {
  bold: boolean
  dim: boolean
  italic: boolean
  underline: boolean
  blink: boolean
  inverse: boolean
  hidden: boolean
  strike: boolean
  fg: string | null
  bg: string | null
}

export interface AnsiState {
  sgr: Sgr
  /** DEC private modes (`\x1b[?Nh` / `\x1b[?Nl`) that are currently set. */
  privateModes: ReadonlyMap<number, boolean>
  /** Scroll region as [top, bottom], 1-based inclusive, or null for full screen. */
  scrollRegion: readonly [number, number] | null
  /** G0 charset designator: '0' for DEC line drawing, 'B' for ASCII. */
  charsetG0: string | null
}

const EMPTY_SGR: Sgr = {
  bold: false, dim: false, italic: false, underline: false,
  blink: false, inverse: false, hidden: false, strike: false,
  fg: null, bg: null,
}

export const INITIAL_ANSI_STATE: AnsiState = {
  sgr: EMPTY_SGR,
  privateModes: new Map(),
  scrollRegion: null,
  charsetG0: null,
}

/**
 * DEC private modes worth carrying across a truncation. Restricted to modes whose
 * loss visibly corrupts the session: anything else re-establishes itself on the
 * application's next redraw, and re-emitting an unknown mode is riskier than
 * dropping it.
 */
const TRACKED_PRIVATE_MODES = new Set([
  1,    // application cursor keys
  7,    // autowrap
  25,   // cursor visibility
  47, 1047, 1049, // alternate screen buffer
  1000, 1002, 1003, 1004, 1005, 1006, 1015, // mouse reporting
  2004, // bracketed paste
])

/**
 * Matches the escape sequences we care about:
 *   CSI  \x1b[ <params> <final>   — SGR (m), scroll region (r), DEC modes (h/l)
 *   SCS  \x1b( <char>             — G0 charset designation
 *   RIS  \x1bc                    — full reset
 * Everything else (cursor moves, erases, OSC) carries no cumulative state.
 */
const SEQUENCE_RE = /\x1b(?:\[([0-9;?]*)([a-zA-Z])|\(([\dB])|c)/g

function applySgrParams(sgr: Sgr, params: string): Sgr {
  // A bare `\x1b[m` means `\x1b[0m`.
  const parts = (params === '' ? '0' : params).split(';')
  let next: Sgr = { ...sgr }

  for (let i = 0; i < parts.length; i++) {
    const code = Number(parts[i] === '' ? '0' : parts[i])
    switch (true) {
      case code === 0: next = { ...EMPTY_SGR }; break
      case code === 1: next.bold = true; break
      case code === 2: next.dim = true; break
      case code === 3: next.italic = true; break
      case code === 4: next.underline = true; break
      case code === 5: next.blink = true; break
      case code === 7: next.inverse = true; break
      case code === 8: next.hidden = true; break
      case code === 9: next.strike = true; break
      case code === 22: next.bold = false; next.dim = false; break
      case code === 23: next.italic = false; break
      case code === 24: next.underline = false; break
      case code === 25: next.blink = false; break
      case code === 27: next.inverse = false; break
      case code === 28: next.hidden = false; break
      case code === 29: next.strike = false; break
      // Extended colour: 38/48 followed by 5;N (256-colour) or 2;R;G;B (truecolor).
      // Consume the sub-parameters so they are not misread as separate codes.
      case code === 38 || code === 48: {
        const isFg = code === 38
        const mode = Number(parts[i + 1])
        let consumed = 0
        if (mode === 5) consumed = 2
        else if (mode === 2) consumed = 4
        if (consumed > 0) {
          const value = parts.slice(i, i + consumed + 1).join(';')
          if (isFg) next.fg = value
          else next.bg = value
          i += consumed
        }
        break
      }
      case code === 39: next.fg = null; break
      case code === 49: next.bg = null; break
      case (code >= 30 && code <= 37) || (code >= 90 && code <= 97):
        next.fg = String(code); break
      case (code >= 40 && code <= 47) || (code >= 100 && code <= 107):
        next.bg = String(code); break
      default: break
    }
  }
  return next
}

/** Fold `text` into `state`, returning the state in effect after it. Pure. */
export function applyAnsi(state: AnsiState, text: string): AnsiState {
  let sgr = state.sgr
  const privateModes = new Map(state.privateModes)
  let scrollRegion = state.scrollRegion
  let charsetG0 = state.charsetG0

  SEQUENCE_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = SEQUENCE_RE.exec(text)) !== null) {
    const [whole, params, final, charset] = match

    if (whole === '\x1bc') {
      sgr = EMPTY_SGR
      privateModes.clear()
      scrollRegion = null
      charsetG0 = null
      continue
    }

    if (charset !== undefined) {
      charsetG0 = charset
      continue
    }

    if (final === 'm') {
      sgr = applySgrParams(sgr, params.startsWith('?') ? '' : params)
    } else if (final === 'h' || final === 'l') {
      if (!params.startsWith('?')) continue // ANSI (non-private) modes are not tracked
      for (const raw of params.slice(1).split(';')) {
        const mode = Number(raw)
        if (!Number.isFinite(mode) || !TRACKED_PRIVATE_MODES.has(mode)) continue
        privateModes.set(mode, final === 'h')
      }
    } else if (final === 'r' && !params.startsWith('?')) {
      // DECSTBM. `\x1b[r` with no parameters resets to the full screen.
      if (params === '') {
        scrollRegion = null
      } else {
        const [top, bottom] = params.split(';').map(Number)
        scrollRegion = Number.isFinite(top) && Number.isFinite(bottom) ? [top, bottom] : null
      }
    }
  }

  return { sgr, privateModes, scrollRegion, charsetG0 }
}

/**
 * Render `state` as the sequences that re-establish it on a fresh terminal.
 * Returns '' when the state is already the terminal default, so an untruncated
 * or state-free stream is byte-for-byte unchanged.
 *
 * Order matters: the alternate-screen switch clears the buffer, so it has to
 * precede the scroll region and pen attributes rather than undo them.
 */
export function renderAnsiState(state: AnsiState): string {
  let out = ''

  for (const [mode, enabled] of state.privateModes) {
    out += `\x1b[?${mode}${enabled ? 'h' : 'l'}`
  }

  if (state.charsetG0 !== null) out += `\x1b(${state.charsetG0}`

  if (state.scrollRegion) out += `\x1b[${state.scrollRegion[0]};${state.scrollRegion[1]}r`

  const { sgr } = state
  const codes: string[] = []
  if (sgr.bold) codes.push('1')
  if (sgr.dim) codes.push('2')
  if (sgr.italic) codes.push('3')
  if (sgr.underline) codes.push('4')
  if (sgr.blink) codes.push('5')
  if (sgr.inverse) codes.push('7')
  if (sgr.hidden) codes.push('8')
  if (sgr.strike) codes.push('9')
  if (sgr.fg) codes.push(sgr.fg)
  if (sgr.bg) codes.push(sgr.bg)
  if (codes.length > 0) out += `\x1b[0;${codes.join(';')}m`

  return out
}
