import { afterEach, describe, expect, it, vi } from 'vitest'
import { MIN_PRESSED_MS, installPressFeedback } from './press-feedback'

afterEach(() => { vi.useRealTimers(); document.body.innerHTML = '' })

function bar() {
  document.body.innerHTML = '<div class="m-bar"><button id="mic"><svg><circle id="icon"/></svg></button></div><button id="other"></button>'
  return { mic: document.getElementById('mic')!, icon: document.getElementById('icon')!, other: document.getElementById('other')! }
}

const press = (el: Element, type: string) => el.dispatchEvent(new Event(type, { bubbles: true }))

describe('a press acknowledged at once', () => {
  it('marks the button the moment a finger lands, even on its icon, before any click', () => {
    const { mic, icon } = bar()
    const off = installPressFeedback(document, '.m-bar button')
    press(icon, 'pointerdown')
    expect(mic.hasAttribute('data-pressed')).toBe(true)
    off()
  })

  it('keeps a quick tap visible for MIN_PRESSED_MS, then lets it go', () => {
    vi.useFakeTimers()
    const { mic } = bar()
    let t = 0
    const off = installPressFeedback(document, '.m-bar button', () => t)
    press(mic, 'pointerdown')
    t = 20
    press(mic, 'pointerup')
    expect(mic.hasAttribute('data-pressed')).toBe(true)
    vi.advanceTimersByTime(MIN_PRESSED_MS)
    expect(mic.hasAttribute('data-pressed')).toBe(false)
    off()
  })

  it('leaves buttons outside the selector alone', () => {
    const { other } = bar()
    const off = installPressFeedback(document, '.m-bar button')
    press(other, 'pointerdown')
    expect(other.hasAttribute('data-pressed')).toBe(false)
    off()
  })
})
