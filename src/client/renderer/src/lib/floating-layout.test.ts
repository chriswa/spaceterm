import { describe, it, expect } from 'vitest'
import { shiftIntoView, buttonsPerRow, EDGE_PAD } from './floating-layout'

describe('shiftIntoView', () => {
  it('leaves a toolbar that fits where it is', () => {
    expect(shiftIntoView(100, 200, 400)).toBe(0)
  })

  it('pulls one poking off either side back to the edge', () => {
    expect(shiftIntoView(-60, 140, 400)).toBe(60 + EDGE_PAD)
    expect(shiftIntoView(300, 450, 400)).toBe(400 - EDGE_PAD - 450)
  })

  it('centres one wider than the room', () => {
    expect(shiftIntoView(0, 500, 400)).toBe(-50)
  })
})

describe('buttonsPerRow', () => {
  it('keeps one row while it fits', () => {
    expect(buttonsPerRow(9, 300, 380)).toBeNull()
  })

  it('splits evenly: nine buttons a little too wide are five and four, not eight and one', () => {
    expect(buttonsPerRow(9, 400, 380)).toBe(5)
  })

  it('uses as many rows as the width needs', () => {
    expect(buttonsPerRow(12, 1000, 380)).toBe(4)
  })
})
