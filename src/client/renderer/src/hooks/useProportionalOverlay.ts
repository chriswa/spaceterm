import { useEffect, useRef, type RefObject } from 'react'
import type { Terminal } from '@xterm/xterm'
import { CELL_WIDTH, CELL_HEIGHT } from '../lib/constants'
import { useFontStore, type FontTheme } from '../stores/fontStore'
import { DEFAULT_BG } from '../../../../shared/theme'
import { resolveFg, resolveBg } from '../../../../shared/terminal-colors'

interface Span {
  text: string
  fg: string
  bg: string
  bold: boolean
}

/** Read visible viewport rows from xterm buffer and group cells into styled spans. */
function readViewport(term: Terminal): Span[][] {
  const buffer = term.buffer.active
  const rows: Span[][] = []

  for (let y = 0; y < term.rows; y++) {
    const line = buffer.getLine(buffer.viewportY + y)
    if (!line) {
      rows.push([])
      continue
    }

    const spans: Span[] = []
    let cur: Span | null = null

    for (let x = 0; x < term.cols; x++) {
      const cell = line.getCell(x)
      if (!cell) {
        if (cur) cur.text += ' '
        else { cur = { text: ' ', fg: '', bg: DEFAULT_BG, bold: false }; spans.push(cur) }
        continue
      }

      const ch = cell.getChars() || ' '
      const inverse = !!(cell.isInverse && cell.isInverse())
      let fg = resolveFg(cell)
      let bg = resolveBg(cell)
      if (inverse) { const tmp = fg; fg = bg; bg = tmp }
      const bold = !!(cell.isBold && cell.isBold())

      if (cur && cur.fg === fg && cur.bg === bg && cur.bold === bold) {
        cur.text += ch
      } else {
        cur = { text: ch, fg, bg, bold }
        spans.push(cur)
      }
    }

    rows.push(spans)
  }

  return rows
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
function isAlphanumeric(ch: string): boolean {
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

/** Draw a span segment with fixed-width character spacing (CELL_WIDTH per char).
 *  Used for leading indentation / box-drawing / symbols. */
function drawFixed(
  ctx: CanvasRenderingContext2D,
  text: string,
  xOffset: number,
  rowY: number,
  rowHeight: number,
  fg: string,
  bg: string,
  termBg: string,
  verticalOffset: number,
) {
  for (let i = 0; i < text.length; i++) {
    const cx = xOffset + i * CELL_WIDTH
    if (bg !== DEFAULT_BG && bg !== termBg) {
      ctx.fillStyle = bg
      ctx.fillRect(cx, rowY, CELL_WIDTH, rowHeight)
    }
    if (text[i] !== ' ') {
      ctx.fillStyle = fg
      ctx.textBaseline = 'top'
      ctx.fillText(text[i], cx, rowY + verticalOffset)
    }
  }
}

/** Draw a span segment with proportional (natural) character spacing.
 *  Used for actual text content after the indentation prefix. */
function drawProportional(
  ctx: CanvasRenderingContext2D,
  text: string,
  xOffset: number,
  rowY: number,
  rowHeight: number,
  fg: string,
  bg: string,
  termBg: string,
  verticalOffset: number,
): number {
  const textWidth = ctx.measureText(text).width
  if (bg !== DEFAULT_BG && bg !== termBg) {
    ctx.fillStyle = bg
    ctx.fillRect(xOffset, rowY, textWidth, rowHeight)
  }
  if (text.trim().length > 0) {
    ctx.fillStyle = fg
    ctx.textBaseline = 'top'
    ctx.fillText(text, xOffset, rowY + verticalOffset)
  }
  return textWidth
}

/** Paint text to the overlay canvas using hybrid spacing:
 *  - Leading non-alphanumeric characters (indentation, box-drawing, symbols)
 *    are rendered at fixed CELL_WIDTH spacing to preserve alignment.
 *  - Once the first letter or digit is encountered on a row, the remainder
 *    of that row is rendered with proportional (natural) spacing. */
function paint(
  ctx: CanvasRenderingContext2D,
  spans: Span[][],
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

  for (let y = 0; y < spans.length; y++) {
    let xOffset = 0
    let proportional = false // flips to true at first letter/digit on this row
    const rowY = y * rowHeight

    for (const span of spans[y]) {
      ctx.font = fontString(theme, span.bold)

      if (proportional) {
        // Entire span is proportional
        xOffset += drawProportional(ctx, span.text, xOffset, rowY, rowHeight,
          span.fg, span.bg, termBg, theme.verticalOffset)
      } else {
        // Scan for the first alphanumeric character in this span
        const match = findFirstAlnum(span.text)

        if (match === -1) {
          // Entire span is fixed-width prefix
          drawFixed(ctx, span.text, xOffset, rowY, rowHeight,
            span.fg, span.bg, termBg, theme.verticalOffset)
          xOffset += span.text.length * CELL_WIDTH
        } else {
          // Split: fixed-width prefix, then proportional remainder
          if (match > 0) {
            const prefix = span.text.slice(0, match)
            drawFixed(ctx, prefix, xOffset, rowY, rowHeight,
              span.fg, span.bg, termBg, theme.verticalOffset)
            xOffset += prefix.length * CELL_WIDTH
          }
          const rest = span.text.slice(match)
          xOffset += drawProportional(ctx, rest, xOffset, rowY, rowHeight,
            span.fg, span.bg, termBg, theme.verticalOffset)
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
      const spans = readViewport(term)
      paint(ctx, spans, cols, rows, termBg, theme)
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
