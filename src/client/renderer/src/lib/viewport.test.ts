import { describe, it, expect } from 'vitest'
import { isCardOnScreen, VIEWPORT_MARGIN, type WorldRect } from './viewport'
import type { Camera } from './camera'

const VIEW = { width: 1000, height: 800 }
const IDENTITY: Camera = { x: 0, y: 0, z: 1 }

/** A card whose centre sits at the given world point. */
function card(x: number, y: number, width = 200, height = 100): WorldRect {
  return { x, y, width, height }
}

describe('isCardOnScreen', () => {
  it('sees a card under the camera origin', () => {
    expect(isCardOnScreen(card(100, 100), IDENTITY, VIEW)).toBe(true)
  })

  it('culls a card far beyond the margin', () => {
    // Margin is one viewport, so anything past ~2 viewports out is gone.
    expect(isCardOnScreen(card(9000, 100), IDENTITY, VIEW)).toBe(false)
    expect(isCardOnScreen(card(100, -9000), IDENTITY, VIEW)).toBe(false)
  })

  it('keeps a card just outside the viewport but inside the margin', () => {
    // Centre one viewport-width to the right of the visible area: off screen,
    // but within the one-screen slack that covers an in-progress pan.
    const justOutside = card(VIEW.width + 300, 400)
    expect(isCardOnScreen(justOutside, IDENTITY, VIEW)).toBe(true)
    expect(isCardOnScreen(justOutside, IDENTITY, VIEW, 0)).toBe(false)
  })

  it('accounts for the card being centred on its position, not anchored', () => {
    // A wide card whose centre is off screen can still have an edge on screen.
    const wide = card(-400, 400, 1000, 100)
    expect(isCardOnScreen(wide, IDENTITY, VIEW, 0)).toBe(true)
    // The same centre with a narrow card is not.
    expect(isCardOnScreen(card(-400, 400, 100, 100), IDENTITY, VIEW, 0)).toBe(false)
  })

  it('follows the camera pan', () => {
    const far = card(5000, 400)
    expect(isCardOnScreen(far, IDENTITY, VIEW, 0)).toBe(false)
    // Pan the camera so that world x=5000 lands mid-screen.
    expect(isCardOnScreen(far, { x: -4500, y: 0, z: 1 }, VIEW, 0)).toBe(true)
  })

  it('follows the camera zoom', () => {
    const far = card(5000, 400)
    expect(isCardOnScreen(far, IDENTITY, VIEW, 0)).toBe(false)
    // Zoomed out far enough, the same card falls inside the viewport.
    expect(isCardOnScreen(far, { x: 0, y: 0, z: 0.05 }, VIEW, 0)).toBe(true)
  })

  it('treats a degenerate viewport as all-visible rather than none', () => {
    // A zero-size window must not freeze every card's canvas.
    expect(isCardOnScreen(card(99999, 99999), IDENTITY, { width: 0, height: 0 })).toBe(true)
  })

  it('leaves at least a screen of slack by default', () => {
    expect(VIEWPORT_MARGIN).toBeGreaterThanOrEqual(1)
  })
})
