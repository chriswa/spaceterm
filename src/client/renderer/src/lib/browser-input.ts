import { BROWSER_MODIFIERS, type BrowserInput } from '../../../../shared/browser'

/**
 * Turning DOM input on a browser card into input for its page.
 *
 * A frame is drawn scaled to fit its box and centred (`object-fit: contain`),
 * since the page may be showing a size it was lent — the phone's — rather
 * than the card's own. A point maps back through that fit.
 */

export interface Box {
  left: number
  top: number
  width: number
  height: number
}

/** Where a client point lands on the page, in its CSS pixels, or null if it is outside the frame. */
export function pagePoint(clientX: number, clientY: number, box: Box, frame: { width: number; height: number }): { x: number; y: number } | null {
  if (frame.width <= 0 || frame.height <= 0 || box.width <= 0 || box.height <= 0) return null
  const fit = Math.min(box.width / frame.width, box.height / frame.height)
  const offsetX = (box.width - frame.width * fit) / 2
  const offsetY = (box.height - frame.height * fit) / 2
  const x = (clientX - box.left - offsetX) / fit
  const y = (clientY - box.top - offsetY) / fit
  if (x < 0 || y < 0 || x > frame.width || y > frame.height) return null
  return { x, y }
}

export function modifiersOf(e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): number {
  return (e.altKey ? BROWSER_MODIFIERS.alt : 0) |
    (e.ctrlKey ? BROWSER_MODIFIERS.ctrl : 0) |
    (e.metaKey ? BROWSER_MODIFIERS.meta : 0) |
    (e.shiftKey ? BROWSER_MODIFIERS.shift : 0)
}

export function mouseButtonOf(button: number): 'left' | 'middle' | 'right' {
  return button === 1 ? 'middle' : button === 2 ? 'right' : 'left'
}

/**
 * A key, as the page should get it. Printable keys type their character
 * unless ⌘ or Ctrl is held (then they are shortcuts); Enter types a carriage
 * return, which is what submits a form or breaks a line in a textarea.
 */
export function keyInput(
  e: { key: string; code: string; keyCode: number; altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean },
  type: 'keyDown' | 'keyUp'
): BrowserInput {
  const shortcut = e.metaKey || e.ctrlKey
  const text = e.key === 'Enter' ? '\r' : e.key.length === 1 && !shortcut ? e.key : undefined
  return {
    kind: 'key',
    type,
    key: e.key,
    code: e.code,
    keyCode: e.keyCode,
    modifiers: modifiersOf(e),
    ...(type === 'keyDown' && text !== undefined ? { text } : {})
  }
}
