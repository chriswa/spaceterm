import { useEffect, useRef, type RefObject } from 'react'
import type { Terminal } from '@xterm/xterm'
import { CELL_WIDTH, CELL_HEIGHT } from '../lib/constants'
import { useFontStore, type FontTheme } from '../stores/fontStore'
import { DEFAULT_BG } from '../../../../shared/theme'
import { resolveFg, resolveBg } from '../../../../shared/terminal-colors'

interface Span {
  text: string
  startCol: number    // terminal column where this span starts
  colCount: number    // number of terminal columns this span covers
  fg: string
  bg: string
  bold: boolean
  boxDrawing: boolean // true = box-drawing chars, always rendered at grid positions
}

interface RowData {
  spans: Span[]
}

/** Box-drawing characters (U+2500–U+257F) should always snap to the monospace grid. */
export function isBoxDrawing(ch: string): boolean {
  const c = ch.charCodeAt(0)
  return c >= 0x2500 && c <= 0x257F
}

/** Classify a box-drawing character's horizontal alignment within its grid cell.
 *  - 'full':   has both left+right connections (─, ┬, ┴, ┼) — no offset
 *  - 'center': vertical only (│) — centered in cell
 *  - 'right':  right connection only (┌, └, ├) — right-aligned
 *  - 'left':   left connection only (┐, ┘, ┤) — left-aligned */
export function boxDrawingAlignment(ch: string): 'full' | 'center' | 'left' | 'right' {
  const c = ch.charCodeAt(0)

  // Vertical lines — center
  if (c === 0x2502 || c === 0x2503) return 'center'                    // │ ┃
  if (c === 0x2506 || c === 0x2507) return 'center'                    // ┆ ┇
  if (c === 0x250A || c === 0x250B) return 'center'                    // ┊ ┋
  if (c === 0x2551) return 'center'                                    // ║
  if (c === 0x2575 || c === 0x2577 || c === 0x2579 || c === 0x257B) return 'center' // ╵╷╹╻
  if (c === 0x257D || c === 0x257F) return 'center'                    // ╽╿

  // Down-right corners — right-align
  if (c >= 0x250C && c <= 0x250F) return 'right'                       // ┌┍┎┏
  // Up-right corners — right-align
  if (c >= 0x2514 && c <= 0x2517) return 'right'                       // └┕┖┗
  // T-right pieces — right-align
  if (c >= 0x251C && c <= 0x2523) return 'right'                       // ├┝┞┟┠┡┢┣

  // Down-left corners — left-align
  if (c >= 0x2510 && c <= 0x2513) return 'left'                        // ┐┑┒┓
  // Up-left corners — left-align
  if (c >= 0x2518 && c <= 0x251B) return 'left'                        // ┘┙┚┛
  // T-left pieces — left-align
  if (c >= 0x2524 && c <= 0x252B) return 'left'                        // ┤┥┦┧┨┩┪┫

  // Double-line variants
  if (c >= 0x2552 && c <= 0x2554) return 'right'                       // ╒╓╔
  if (c >= 0x2555 && c <= 0x2557) return 'left'                        // ╕╖╗
  if (c >= 0x2558 && c <= 0x255A) return 'right'                       // ╘╙╚
  if (c >= 0x255B && c <= 0x255D) return 'left'                        // ╛╜╝
  if (c >= 0x255E && c <= 0x2560) return 'right'                       // ╞╟╠
  if (c >= 0x2561 && c <= 0x2563) return 'left'                        // ╡╢╣

  // Rounded corners
  if (c === 0x256D || c === 0x2570) return 'right'                     // ╭╰
  if (c === 0x256E || c === 0x256F) return 'left'                      // ╮╯

  // Half-lines
  if (c === 0x2574 || c === 0x2578) return 'left'                      // ╴╸
  if (c === 0x2576 || c === 0x257A) return 'right'                     // ╶╺

  // Everything else: horizontal lines, T-down/up, crosses → full width
  return 'full'
}

/** Draw a single box-drawing character at the correct alignment within its grid cell. */
function drawBoxChar(
  ctx: CanvasRenderingContext2D,
  ch: string,
  cx: number,
  rowY: number,
  fg: string,
  verticalOffset: number,
) {
  if (ch === ' ') return
  const align = boxDrawingAlignment(ch)
  let drawX = cx
  if (align === 'center') {
    drawX = cx + (CELL_WIDTH - ctx.measureText(ch).width) / 2
  } else if (align === 'right') {
    drawX = cx + CELL_WIDTH - ctx.measureText(ch).width
  }
  ctx.fillStyle = fg
  ctx.textBaseline = 'top'
  ctx.fillText(ch, drawX, rowY + verticalOffset)
}

/** Read visible viewport rows from xterm buffer, grouping cells into styled spans.
 *  Box-drawing characters are isolated into separate spans so they can be
 *  anchored to their monospace grid positions during painting. */
function readViewport(term: Terminal): RowData[] {
  const buffer = term.buffer.active
  const rowData: RowData[] = []

  for (let y = 0; y < term.rows; y++) {
    const line = buffer.getLine(buffer.viewportY + y)
    if (!line) {
      rowData.push({ spans: [] })
      continue
    }

    const spans: Span[] = []
    let cur: Span | null = null

    for (let x = 0; x < term.cols; x++) {
      const cell = line.getCell(x)
      if (!cell) {
        // Null cell: append space, never box-drawing
        if (cur && !cur.boxDrawing) { cur.text += ' '; cur.colCount++ }
        else {
          cur = { text: ' ', startCol: x, colCount: 1, fg: '', bg: DEFAULT_BG, bold: false, boxDrawing: false }
          spans.push(cur)
        }
        continue
      }

      const ch = cell.getChars() || ' '
      const inverse = !!(cell.isInverse && cell.isInverse())
      let fg = resolveFg(cell)
      let bg = resolveBg(cell)
      if (inverse) { const tmp = fg; fg = bg; bg = tmp }
      const bold = !!(cell.isBold && cell.isBold())
      const box = isBoxDrawing(ch)

      // Merge into current span only if attributes match AND box-drawing mode matches
      if (cur && cur.fg === fg && cur.bg === bg && cur.bold === bold && cur.boxDrawing === box) {
        cur.text += ch
        cur.colCount++
      } else {
        cur = { text: ch, startCol: x, colCount: 1, fg, bg, bold, boxDrawing: box }
        spans.push(cur)
      }
    }

    rowData.push({ spans })
  }

  return rowData
}

/** Build a CSS font string from a theme and bold flag. */
function fontString(theme: FontTheme, bold: boolean): string {
  const weight = bold ? theme.boldWeight : theme.fontWeight
  return `${weight} ${theme.fontSize}px ${theme.fontFamily}`
}

/** Test if a character is a letter or digit — the trigger to switch from
 *  fixed-width indentation to proportional text.
 *  Explicitly enumerates script ranges so symbols (box-drawing, dingbats,
 *  miscellaneous technical, etc.) stay in fixed-width mode. */
export function isAlphanumeric(ch: string): boolean {
  const c = ch.charCodeAt(0)
  return (c >= 0x30 && c <= 0x39)       // 0-9
      || (c >= 0x41 && c <= 0x5A)       // A-Z
      || (c >= 0x61 && c <= 0x7A)       // a-z
      || (c >= 0xC0 && c <= 0x024F      // Latin Extended (à é ñ ü ...)
          && c !== 0xD7 && c !== 0xF7)   //   minus × ÷
      || (c >= 0x0370 && c <= 0x03FF)   // Greek
      || (c >= 0x0400 && c <= 0x052F)   // Cyrillic + Cyrillic Supplement
      || (c >= 0x0530 && c <= 0x058F)   // Armenian
      || (c >= 0x0590 && c <= 0x05FF)   // Hebrew
      || (c >= 0x0600 && c <= 0x06FF)   // Arabic
      || (c >= 0x3040 && c <= 0x30FF)   // Hiragana + Katakana
      || (c >= 0x4E00 && c <= 0x9FFF)   // CJK Unified Ideographs
      || (c >= 0xAC00 && c <= 0xD7AF)   // Hangul Syllables
}

/** Find the index of the first alphanumeric character in a string, or -1. */
export function findFirstAlnum(text: string): number {
  for (let i = 0; i < text.length; i++) {
    if (isAlphanumeric(text[i])) return i
  }
  return -1
}


/** Minimum columns a background color must cover to be considered structural
 *  (full-line diff bands). Prevents small elements like cursors or short
 *  highlights from being grid-positioned. */
const STRUCTURAL_BG_MIN_COLS = 8

/** Find the dominant (most-used) non-default background color on a row.
 *  Returns '' if no color covers at least STRUCTURAL_BG_MIN_COLS columns. */
function findStructuralBg(spans: Span[], termBg: string): string {
  const counts = new Map<string, number>()
  for (const span of spans) {
    if (span.bg !== DEFAULT_BG && span.bg !== termBg) {
      counts.set(span.bg, (counts.get(span.bg) ?? 0) + span.colCount)
    }
  }
  let best = ''
  let bestCount = 0
  for (const [bg, count] of counts) {
    if (count > bestCount) { bestCount = count; best = bg }
  }
  return bestCount >= STRUCTURAL_BG_MIN_COLS ? best : ''
}

/** Paint text to the overlay canvas using three-layer rendering per row:
 *  Layer 1 (bottom): structural backgrounds at monospace grid positions — the
 *    dominant bg color on each row tiles seamlessly for clean diff bands.
 *  Layer 2 (middle): contextual backgrounds at proportional positions — inline
 *    highlights (non-dominant bg) track the text they annotate.
 *  Layer 3 (top): text using hybrid spacing (fixed prefix + proportional +
 *    box-drawing anchors). */
function paint(
  ctx: CanvasRenderingContext2D,
  rowData: RowData[],
  cols: number,
  rows: number,
  termBg: string,
  theme: FontTheme,
) {
  const cw = Math.ceil(cols * CELL_WIDTH)
  const ch = Math.ceil(rows * CELL_HEIGHT)
  const rowHeight = CELL_HEIGHT * theme.lineHeight

  ctx.fillStyle = termBg
  ctx.fillRect(0, 0, cw, ch)

  // --- Layer 1: structural backgrounds at monospace grid positions ---
  for (let y = 0; y < rowData.length; y++) {
    const rowY = y * rowHeight
    const structBg = findStructuralBg(rowData[y].spans, termBg)
    if (!structBg) continue
    // Fill structural bg for ALL non-default spans (not just matching ones),
    // since contextual-bg spans sit within the structural band and Layer 2
    // will overpaint them at proportional positions.
    ctx.fillStyle = structBg
    for (const span of rowData[y].spans) {
      if (span.bg !== DEFAULT_BG && span.bg !== termBg) {
        ctx.fillRect(span.startCol * CELL_WIDTH, rowY, span.colCount * CELL_WIDTH, rowHeight)
      }
    }
  }

  // --- Layers 2+3: contextual backgrounds + text (interleaved per span) ---
  for (let y = 0; y < rowData.length; y++) {
    let xOffset = 0
    let proportional = false
    const rowY = y * rowHeight
    const structBg = findStructuralBg(rowData[y].spans, termBg)

    for (const span of rowData[y].spans) {
      ctx.font = fontString(theme, span.bold)

      // Determine proportional width for this span (used for contextual bg + xOffset)
      let spanPxWidth: number

      if (span.boxDrawing) {
        // Box-drawing: always snap to monospace grid position
        xOffset = span.startCol * CELL_WIDTH
        spanPxWidth = span.text.length * CELL_WIDTH
      } else if (proportional) {
        spanPxWidth = ctx.measureText(span.text).width
      } else {
        const match = findFirstAlnum(span.text)
        if (match === -1) {
          spanPxWidth = span.text.length * CELL_WIDTH
        } else {
          // prefix is fixed, rest is proportional — compute combined width
          spanPxWidth = match * CELL_WIDTH + ctx.measureText(span.text.slice(match)).width
        }
      }

      // Layer 2: contextual background (non-structural, non-default)
      const isContextualBg = span.bg !== DEFAULT_BG && span.bg !== termBg && span.bg !== structBg
      if (isContextualBg) {
        ctx.fillStyle = span.bg
        ctx.fillRect(xOffset, rowY, spanPxWidth, rowHeight)
      }

      // Layer 3: text
      if (span.boxDrawing) {
        for (let i = 0; i < span.text.length; i++) {
          drawBoxChar(ctx, span.text[i], xOffset + i * CELL_WIDTH, rowY, span.fg, theme.verticalOffset)
        }
        xOffset += spanPxWidth
      } else if (proportional) {
        if (span.text.trim().length > 0) {
          ctx.fillStyle = span.fg
          ctx.textBaseline = 'top'
          ctx.fillText(span.text, xOffset, rowY + theme.verticalOffset)
        }
        xOffset += spanPxWidth
      } else {
        const match = findFirstAlnum(span.text)
        if (match === -1) {
          for (let i = 0; i < span.text.length; i++) {
            if (isBoxDrawing(span.text[i])) {
              drawBoxChar(ctx, span.text[i], xOffset + i * CELL_WIDTH, rowY, span.fg, theme.verticalOffset)
            } else if (span.text[i] !== ' ') {
              ctx.fillStyle = span.fg
              ctx.textBaseline = 'top'
              ctx.fillText(span.text[i], xOffset + i * CELL_WIDTH, rowY + theme.verticalOffset)
            }
          }
          xOffset += spanPxWidth
        } else {
          for (let i = 0; i < match; i++) {
            if (isBoxDrawing(span.text[i])) {
              drawBoxChar(ctx, span.text[i], xOffset + i * CELL_WIDTH, rowY, span.fg, theme.verticalOffset)
            } else if (span.text[i] !== ' ') {
              ctx.fillStyle = span.fg
              ctx.textBaseline = 'top'
              ctx.fillText(span.text[i], xOffset + i * CELL_WIDTH, rowY + theme.verticalOffset)
            }
          }
          xOffset += match * CELL_WIDTH
          const rest = span.text.slice(match)
          if (rest.trim().length > 0) {
            ctx.fillStyle = span.fg
            ctx.textBaseline = 'top'
            ctx.fillText(rest, xOffset, rowY + theme.verticalOffset)
          }
          xOffset += ctx.measureText(rest).width
          proportional = true
        }
      }
    }
  }
}

/**
 * When enabled, hides xterm's canvas and paints a proportional-font overlay
 * that reads from xterm's buffer. All input and terminal state is still handled
 * by xterm — we only replace the visual output.
 */
export function useProportionalOverlay(
  terminalRef: RefObject<Terminal | null>,
  canvasRef: RefObject<HTMLCanvasElement | null>,
  enabled: boolean,
  cols: number,
  rows: number,
  termBg: string,
): void {
  const disposableRef = useRef<{ dispose(): void } | null>(null)
  // Subscribe to theme changes so we repaint when the user picks a new theme
  const theme = useFontStore(s => s.theme)

  useEffect(() => {
    const term = terminalRef.current
    const canvas = canvasRef.current
    if (!enabled || !term || !canvas) {
      // Cleanup if previously enabled
      disposableRef.current?.dispose()
      disposableRef.current = null
      return
    }

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    // Render at high-DPI: backing store at dpr × CSS size for crisp text
    const dpr = (window.devicePixelRatio || 1) * 1.25
    const cw = Math.ceil(cols * CELL_WIDTH)
    const ch = Math.ceil(rows * CELL_HEIGHT)
    const bw = Math.ceil(cw * dpr)
    const bh = Math.ceil(ch * dpr)
    if (canvas.width !== bw || canvas.height !== bh) {
      canvas.width = bw
      canvas.height = bh
    }

    const repaint = () => {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      const rowData = readViewport(term)
      paint(ctx, rowData, cols, rows, termBg, theme)
    }

    // Initial paint
    repaint()

    // Repaint on every xterm render (new data, scroll, cursor move, etc.)
    const onRenderDisposable = term.onRender(repaint)
    disposableRef.current = onRenderDisposable

    return () => {
      onRenderDisposable.dispose()
      disposableRef.current = null
    }
  }, [enabled, cols, rows, termBg, theme])
}
