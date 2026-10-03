import { describe, it, expect } from 'vitest'
import { layoutRadial, pickRadial, BUBBLE, DEAD_ZONE, RADIUS } from './radial-menu'

const SCREEN = { width: 402, height: 874 }

describe('layoutRadial', () => {
  it('fans the options out above the thumb, centred on it when there is room', () => {
    const menu = layoutRadial(2, { x: 200, y: 500 }, SCREEN)
    expect(menu.center).toEqual({ x: 200, y: 500 })
    for (const item of menu.items) {
      expect(item.y).toBeLessThan(500)
      expect(Math.hypot(item.x - 200, item.y - 500)).toBeCloseTo(RADIUS)
    }
    expect(menu.items[0].x).toBeLessThan(200)
    expect(menu.items[1].x).toBeGreaterThan(200)
  })

  it('stays whole on screen when the thumb is at an edge or the top', () => {
    for (const at of [{ x: 5, y: 500 }, { x: 398, y: 500 }, { x: 200, y: 10 }]) {
      const menu = layoutRadial(2, at, SCREEN)
      for (const item of menu.items) {
        expect(item.x - BUBBLE / 2).toBeGreaterThanOrEqual(0)
        expect(item.x + BUBBLE / 2).toBeLessThanOrEqual(SCREEN.width)
        expect(item.y - BUBBLE / 2).toBeGreaterThanOrEqual(0)
      }
    }
  })
})

describe('pickRadial', () => {
  const menu = layoutRadial(2, { x: 200, y: 500 }, SCREEN)

  it('picks nothing for a thumb that has not moved, so a plain long press does nothing', () => {
    expect(pickRadial(menu, { x: 200, y: 500 })).toBeNull()
    expect(pickRadial(menu, { x: 200 + DEAD_ZONE - 1, y: 500 })).toBeNull()
  })

  it('picks by direction: towards an option is enough', () => {
    expect(pickRadial(menu, { x: 160, y: 460 })).toBe(0)
    expect(pickRadial(menu, { x: 240, y: 460 })).toBe(1)
  })

  it('picks nothing pointing away from every option', () => {
    expect(pickRadial(menu, { x: 200, y: 600 })).toBeNull()
  })

  it('near an edge the thumb may already be pointing at one, and releasing picks it', () => {
    const atEdge = layoutRadial(2, { x: 4, y: 500 }, SCREEN)
    expect(pickRadial(atEdge, { x: 4, y: 500 })).not.toBeNull()
  })
})
