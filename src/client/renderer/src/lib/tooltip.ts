let el: HTMLDivElement | null = null
let currentTarget: HTMLElement | null = null

// Constants matching .tooltip CSS
const FONT = '500 11px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
const LINE_HEIGHT = 11 * 1.4 // font-size × line-height multiplier
const PAD_X = 8
const PAD_Y = 4
const MAX_WIDTH = 220
const MAX_TEXT_WIDTH = MAX_WIDTH - PAD_X * 2
const GAP = 6
const MARGIN = 4

let ctx: CanvasRenderingContext2D | null = null

function getCtx(): CanvasRenderingContext2D {
  if (!ctx) {
    const canvas = document.createElement('canvas')
    ctx = canvas.getContext('2d')!
    ctx.font = FONT
  }
  return ctx
}

/** Estimate how many lines a single "word" (no internal spaces) occupies
 *  when CSS `word-wrap: break-word` forces it to wrap at MAX_TEXT_WIDTH. */
function measureWordBreakLines(c: CanvasRenderingContext2D, word: string): { lines: number; maxWidth: number } {
  const fullWidth = c.measureText(word).width
  if (fullWidth <= MAX_TEXT_WIDTH) return { lines: 1, maxWidth: fullWidth }

  // Approximate character-level wrapping: measure average char width
  // and compute how many lines the word spans.
  const avgCharWidth = fullWidth / word.length
  const charsPerLine = Math.max(1, Math.floor(MAX_TEXT_WIDTH / avgCharWidth))
  const lines = Math.ceil(word.length / charsPerLine)
  return { lines, maxWidth: Math.min(fullWidth, MAX_TEXT_WIDTH) }
}

function measureTooltip(text: string): { width: number; height: number } {
  const c = getCtx()
  const words = text.split(/\s+/)

  // Fast path: fits on one line
  const fullWidth = c.measureText(text).width
  if (fullWidth <= MAX_TEXT_WIDTH) {
    return {
      width: Math.ceil(fullWidth) + PAD_X * 2,
      height: Math.ceil(LINE_HEIGHT) + PAD_Y * 2,
    }
  }

  // Word-wrap measurement, accounting for word-wrap: break-word
  let lineCount = 1
  let lineWidth = 0
  let maxLineWidth = 0
  const spaceWidth = c.measureText(' ').width

  for (const word of words) {
    const wordWidth = c.measureText(word).width

    // If a single word exceeds MAX_TEXT_WIDTH, CSS break-word will split it
    // across multiple lines. Account for this.
    if (wordWidth > MAX_TEXT_WIDTH) {
      if (lineWidth > 0) {
        // Finish current line first
        maxLineWidth = Math.max(maxLineWidth, lineWidth)
        lineCount++
        lineWidth = 0
      }
      const wb = measureWordBreakLines(c, word)
      lineCount += wb.lines - 1 // -1 because the last fragment starts a new "current line"
      maxLineWidth = Math.max(maxLineWidth, wb.maxWidth)
      // Estimate remaining width on the last line of the broken word
      const lastLineChars = word.length % Math.max(1, Math.floor(MAX_TEXT_WIDTH / (wordWidth / word.length)))
      lineWidth = lastLineChars > 0 ? c.measureText(word.slice(-lastLineChars)).width : wb.maxWidth
      continue
    }

    if (lineWidth > 0) {
      const testWidth = lineWidth + spaceWidth + wordWidth
      if (testWidth > MAX_TEXT_WIDTH) {
        maxLineWidth = Math.max(maxLineWidth, lineWidth)
        lineCount++
        lineWidth = wordWidth
      } else {
        lineWidth = testWidth
      }
    } else {
      lineWidth = wordWidth
    }
  }
  maxLineWidth = Math.max(maxLineWidth, lineWidth)

  return {
    width: Math.ceil(maxLineWidth) + PAD_X * 2,
    height: Math.ceil(lineCount * LINE_HEIGHT) + PAD_Y * 2,
  }
}

function show(target: HTMLElement) {
  const text = target.getAttribute('data-tooltip')
  if (!text) return

  if (!el) {
    el = document.createElement('div')
    el.className = 'tooltip'
    document.body.appendChild(el)
  }

  el.textContent = text
  currentTarget = target

  const placement = (target.getAttribute('data-tooltip-placement') ?? 'top') as 'top' | 'bottom'
  const noFlip = target.hasAttribute('data-tooltip-no-flip')
  const rect = target.getBoundingClientRect()
  const { width: tw, height: th } = measureTooltip(text)
  const vw = document.documentElement.clientWidth
  const vh = document.documentElement.clientHeight

  // Center horizontally on target, clamp to viewport
  let x = rect.left + rect.width / 2 - tw / 2
  x = Math.max(MARGIN, Math.min(x, vw - tw - MARGIN))

  // Place on preferred side, flip if it would overflow (unless no-flip)
  let y: number
  if (placement === 'top') {
    y = rect.top - th - GAP
    if (y < MARGIN && !noFlip) y = rect.bottom + GAP
  } else {
    y = rect.bottom + GAP
    if (y + th > vh - MARGIN && !noFlip) y = rect.top - th - GAP
  }

  el.style.left = `${x}px`
  el.style.top = `${y}px`
  el.style.opacity = '1'
}

function hide() {
  if (el) {
    el.style.opacity = '0'
  }
  currentTarget = null
}

export function initTooltips(): void {
  // Watch for data-tooltip attribute changes while a tooltip is visible.
  // This handles cases where React re-renders a button mid-hover (e.g. toggle
  // buttons) and changes the attribute without triggering a new mouseover event.
  const observer = new MutationObserver(() => {
    if (currentTarget) {
      show(currentTarget)
    }
  })

  document.addEventListener('mouseover', (e) => {
    const target = (e.target as HTMLElement).closest?.('[data-tooltip]') as HTMLElement | null
    if (target) {
      observer.disconnect()
      observer.observe(target, { attributeFilter: ['data-tooltip'] })
      show(target)
    } else if (currentTarget) {
      hide()
    }
  })

  document.addEventListener('mouseout', (e) => {
    if (!currentTarget) return
    const related = e.relatedTarget as HTMLElement | null
    if (!related || !currentTarget.contains(related)) {
      observer.disconnect()
      hide()
    }
  })
}
