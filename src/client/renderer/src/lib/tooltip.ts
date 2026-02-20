let el: HTMLDivElement | null = null
let currentTarget: HTMLElement | null = null

function show(target: HTMLElement) {
  const text = target.getAttribute('data-tooltip')
  if (!text) return

  if (!el) {
    el = document.createElement('div')
    el.className = 'tooltip'
    document.body.appendChild(el)
  }

  el.textContent = text
  // Reset visibility so we can measure
  el.style.opacity = '0'
  el.style.display = 'block'
  currentTarget = target

  const placement = (target.getAttribute('data-tooltip-placement') ?? 'top') as 'top' | 'bottom'
  const gap = 6
  const margin = 4
  const rect = target.getBoundingClientRect()
  const tw = el.offsetWidth
  const th = el.offsetHeight
  const vw = document.documentElement.clientWidth
  const vh = document.documentElement.clientHeight

  // Center horizontally on target, clamp to viewport
  let x = rect.left + rect.width / 2 - tw / 2
  x = Math.max(margin, Math.min(x, vw - tw - margin))

  // Place on preferred side, flip if it would overflow
  let y: number
  if (placement === 'top') {
    y = rect.top - th - gap
    if (y < margin) y = rect.bottom + gap // flip to bottom
  } else {
    y = rect.bottom + gap
    if (y + th > vh - margin) y = rect.top - th - gap // flip to top
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
