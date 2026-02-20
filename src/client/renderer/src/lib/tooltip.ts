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

  // Word-wrap measurement
  let lineCount = 1
  let lineWidth = 0
  let maxLineWidth = 0
  const spaceWidth = c.measureText(' ').width

  for (const word of words) {
    const wordWidth = c.measureText(word).width
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
  document.addEventListener('mouseover', (e) => {
    const target = (e.target as HTMLElement).closest?.('[data-tooltip]') as HTMLElement | null
    if (target) {
      show(target)
    } else if (currentTarget) {
      hide()
    }
  })

  document.addEventListener('mouseout', (e) => {
    if (!currentTarget) return
    const related = e.relatedTarget as HTMLElement | null
    if (!related || !currentTarget.contains(related)) {
      hide()
    }
  })
}
