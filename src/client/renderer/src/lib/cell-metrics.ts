import type { Terminal } from '@xterm/xterm'
import { CELL_WIDTH } from './constants'

/**
 * Hold a live xterm to the grid the rest of the app draws on.
 *
 * `CELL_WIDTH` is the unit every terminal-shaped thing in this app is sized
 * from: the card box (`terminalPixelSize`), the snapshot canvas, the resize
 * ghost and the proportional-font overlay. Nothing here measures a cell — they
 * all multiply. So the one thing that *does* have its own opinion, xterm's
 * renderer, has to be brought onto the same unit, or the two step at different
 * rates and the difference accumulates across the row.
 *
 * That is not hypothetical. xterm measures Menlo 14px at 8.4375px per column;
 * the DOM renderer honours the fraction, but the WebGL renderer floors each
 * cell to whole device pixels and draws 8.0. Sizing the card from 8.4375 while
 * the terminal drew 8.0 left a black bar down the right-hand side — 35px at 80
 * columns, 140px at 320 — which is the bug this module exists to prevent
 * recurring, whichever renderer wins and whatever display the window is on.
 */

/**
 * The cell width xterm's active renderer is currently drawing at, in CSS px.
 *
 * xterm exposes no public API for this — `Terminal.options` describes the font
 * that was asked for, not the grid the renderer rounded it to — so it comes out
 * of the render service. Returns null when there is nothing to read: before the
 * renderer has measured, in jsdom where the measure element has no width, or if
 * a future xterm moves the field.
 */
export function renderedCellWidth(term: Terminal): number | null {
  const dimensions = (term as unknown as {
    _core?: { _renderService?: { dimensions?: { css?: { cell?: { width?: number } } } } }
  })._core?._renderService?.dimensions
  const width = dimensions?.css?.cell?.width
  return typeof width === 'number' && Number.isFinite(width) && width > 0 ? width : null
}

/**
 * The `letterSpacing` that pulls a rendered cell onto the grid.
 *
 * Both renderers compute `cell = round(glyph advance) + Math.round(letterSpacing)`
 * in *device* pixels, so letterSpacing is the one knob that can correct their
 * rounding, and it is denominated in device pixels — hence the `dpr` factor.
 * It is a correction to whatever spacing is already in force, not an absolute,
 * because `rendered` was produced with that spacing applied.
 */
export function letterSpacingForCellWidth(
  current: number,
  rendered: number,
  dpr: number,
  target: number = CELL_WIDTH
): number {
  if (!Number.isFinite(rendered) || rendered <= 0) return current
  if (!Number.isFinite(dpr) || dpr <= 0) return current
  return current + Math.round((target - rendered) * dpr)
}

/**
 * Bring `term`'s grid onto `CELL_WIDTH`, and say so if it could not.
 *
 * Idempotent and cheap — it reads the rendered width and returns early when it
 * already agrees — so it is safe to call again whenever the rounding could have
 * changed underneath it (a new renderer, a new display).
 *
 * A residual is possible and is reported rather than hidden: the DOM renderer
 * keeps a fractional cell width that whole-device-pixel spacing cannot always
 * land exactly on. It is bounded by half a device pixel per column, against the
 * 0.4375px per column that went uncorrected before, and the DOM renderer is the
 * fallback path — reached only where WebGL2 is unavailable.
 */
export function alignTerminalCellWidth(term: Terminal, log?: (message: string) => void): void {
  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1
  const before = renderedCellWidth(term)
  // No renderer to align — say nothing, since this is also the jsdom case.
  if (before === null) return
  if (before === CELL_WIDTH) return

  const current = term.options.letterSpacing ?? 0
  const corrected = letterSpacingForCellWidth(current, before, dpr)
  if (corrected !== current) term.options.letterSpacing = corrected

  const after = renderedCellWidth(term) ?? before
  const detail = `cellWidth ${before} -> ${after} (target ${CELL_WIDTH}, letterSpacing ${current} -> ${corrected}, dpr ${dpr})`
  log?.(after === CELL_WIDTH ? `[CellMetrics] aligned: ${detail}` : `[CellMetrics] RESIDUAL: ${detail}`)
}

/**
 * Call `onChange` when the window lands on a display with a different pixel
 * ratio; returns a disposer.
 *
 * The ratio is what the renderers round against, so a move between a retina and
 * a non-retina display re-rounds every cell and invalidates the alignment. A
 * media query only fires when the ratio it was built for stops matching, so the
 * query has to be rebuilt around the new ratio each time — that re-arming is
 * the whole reason this is not two lines at the call site.
 */
export function watchDevicePixelRatio(onChange: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {}

  let query: MediaQueryList | null = null
  const handle = (): void => {
    query?.removeEventListener('change', handle)
    query = armResolutionQuery(handle)
    onChange()
  }

  query = armResolutionQuery(handle)
  return () => {
    query?.removeEventListener('change', handle)
    query = null
  }
}

/** A query that stops matching the moment the window's pixel ratio changes. */
function armResolutionQuery(listener: () => void): MediaQueryList | null {
  try {
    const query = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
    query.addEventListener('change', listener)
    return query
  } catch {
    // jsdom and older engines parse `resolution` queries poorly. Losing the
    // re-alignment on a display change is not worth taking a terminal down.
    return null
  }
}
