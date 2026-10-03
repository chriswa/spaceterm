import { describe, it, expect, beforeAll } from 'vitest'
import { initTooltips } from './tooltip'

/**
 * jsdom has no PointerEvent constructor; the handler reads only these fields.
 * The mouse case is not covered here: showing measures text on a canvas, which
 * jsdom does not have.
 */
function pointerOver(target: Element, pointerType: string): void {
  const event = new Event('pointerover', { bubbles: true })
  Object.defineProperty(event, 'pointerType', { value: pointerType })
  target.dispatchEvent(event)
}

const shownTooltip = () => Array.from(document.querySelectorAll<HTMLElement>('.tooltip')).find((t) => t.style.display !== 'none' && t.textContent)

describe('tooltips', () => {
  beforeAll(() => initTooltips())

  it('a touch shows none — iOS sends one for every tap, and nothing ever hides it', () => {
    const button = document.createElement('button')
    button.dataset.tooltip = 'Archive'
    document.body.appendChild(button)
    pointerOver(button, 'touch')
    expect(shownTooltip()).toBeUndefined()
  })
})
