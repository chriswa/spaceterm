import type { CardChromeFacet } from './theme/facets'

/**
 * Whether a theme's cards let the canvas show through them.
 *
 * ## What this is for
 *
 * `CanvasBackground` draws a quad per markdown and title card using the
 * *background* shader, painting over the tree edges that pass behind them. That
 * pass exists for translucent chrome, where an edge crossing under a card would
 * otherwise be visible through it. Against opaque chrome it draws pixels the
 * card's own DOM covers completely — one full re-evaluation of the background
 * shader per card, per frame, for nothing. On the default theme, whose
 * `--card-surface` is a flat `#1e1e2e`, that was most of the canvas's cost.
 *
 * ## Why it is derived and not declared
 *
 * A `translucent: true` flag on the facet would be one line and would be wrong
 * the first time someone edited a colour without editing the flag — and the
 * symptom is edges vanishing from behind cards that no longer hide them, which
 * nobody would connect to a boolean. The colours are already in the facet, so
 * the answer is already there.
 *
 * The parse therefore **fails safe**: anything it cannot prove opaque counts as
 * translucent and gets the mask. A mod using `color-mix()` or a `var()`
 * indirection loses the optimisation and keeps the correct picture, which is the
 * right way round.
 */

/** CSS colour keywords that are not opaque. Everything else named is. */
const TRANSPARENT_KEYWORDS = new Set(['transparent', 'none'])

/**
 * True when `css` is *definitely* fully opaque.
 *
 * Deliberately conservative: `false` means "not proven opaque", which includes
 * every syntax this does not recognise.
 */
export function isOpaqueColor(css: string): boolean {
  const value = css.trim().toLowerCase()
  if (value === '') return false
  if (TRANSPARENT_KEYWORDS.has(value)) return false

  if (value.startsWith('#')) {
    const hex = value.slice(1)
    // #rgb and #rrggbb carry no alpha channel, so they are opaque by syntax.
    if (/^[0-9a-f]{3}$/.test(hex) || /^[0-9a-f]{6}$/.test(hex)) return true
    // #rgba / #rrggbbaa — opaque only if the alpha nibble(s) are maxed.
    if (/^[0-9a-f]{4}$/.test(hex)) return hex[3] === 'f'
    if (/^[0-9a-f]{8}$/.test(hex)) return hex.slice(6) === 'ff'
    return false
  }

  // rgb() / rgba() / hsl() / hsla(), in either the comma or the slash form.
  const fn = /^(?:rgba?|hsla?)\(([^)]*)\)$/.exec(value)
  if (fn) {
    const alpha = alphaOf(fn[1])
    // No alpha component at all means opaque; `rgb()` and `rgba()` are
    // interchangeable in modern CSS, so the function name says nothing.
    return alpha === null ? true : alpha >= 1
  }

  // A bare keyword (`black`, `rebeccapurple`). Enumerating all 148 to prove
  // what none of them are — transparent — is not worth it: any keyword that
  // reaches here is opaque, and `transparent` was excluded above.
  if (/^[a-z]+$/.test(value)) return true

  return false
}

/**
 * The alpha component of a colour function's argument list, or `null` when it
 * has none. Returns `NaN`-free numbers only; an unparseable alpha reads as 0 so
 * the caller treats it as translucent.
 */
function alphaOf(args: string): number | null {
  // Both `r, g, b, a` and `r g b / a` are legal; the slash form puts alpha last
  // either way.
  const parts = args.includes('/')
    ? args.split('/')
    : args.split(',')
  if (args.includes('/')) {
    if (parts.length !== 2) return 0
    return percentOrNumber(parts[1])
  }
  if (parts.length === 3) return null
  if (parts.length !== 4) return 0
  return percentOrNumber(parts[3])
}

function percentOrNumber(raw: string): number {
  const text = raw.trim()
  const value = Number.parseFloat(text)
  if (Number.isNaN(value)) return 0
  return text.endsWith('%') ? value / 100 : value
}

/**
 * Does this chrome need the edge-masking pass?
 *
 * Both surfaces count: the header covers only the top strip of a card, so a
 * translucent header over an opaque body still shows the edges underneath it.
 *
 * A chrome that names neither surface has not overridden the default look and
 * is treated as needing the mask — the same fail-safe direction as the parse.
 */
export function chromeNeedsEdgeMask(chrome: CardChromeFacet): boolean {
  const surfaces = ['--card-surface', '--card-head-surface']
  return surfaces.some((name) => {
    const value = chrome.vars[name]
    return value === undefined || !isOpaqueColor(value)
  })
}
