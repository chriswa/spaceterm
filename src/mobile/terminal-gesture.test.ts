import { describe, it, expect } from 'vitest'
import { TerminalGesture, LONG_PRESS_MS, EXIT_DISTANCE_PX } from './terminal-gesture'

describe('TerminalGesture', () => {
  it('a quick touch without movement is a tap', () => {
    const g = new TerminalGesture()
    g.begin(100, 100, 0)
    g.move(103, 104)
    expect(g.end(120)).toBe('tap')
  })

  it('holding still past the threshold is a long press', () => {
    const g = new TerminalGesture()
    g.begin(100, 100, 0)
    expect(g.isStill()).toBe(true)
    expect(g.end(LONG_PRESS_MS + 1)).toBe('long-press')
  })

  it('a vertical drag scrolls by how far the finger moved, finger-up positive', () => {
    const g = new TerminalGesture()
    g.begin(100, 300, 0)
    expect(g.move(100, 285)).toEqual({ kind: 'scroll', deltaY: 15 })
    expect(g.move(102, 260)).toEqual({ kind: 'scroll', deltaY: 25 })
    expect(g.move(100, 270)).toEqual({ kind: 'scroll', deltaY: -10 })
    // Neither a tap nor a press once it has scrolled, however long it took.
    expect(g.end(5000)).toBe('none')
  })

  it('stays a scroll once it is one, even if the finger drifts sideways', () => {
    const g = new TerminalGesture()
    g.begin(100, 300, 0)
    g.move(100, 280)
    expect(g.move(300, 280).kind).toBe('scroll')
    expect(g.end(100)).toBe('none')
  })

  it('a long horizontal drag leaves, in either direction', () => {
    for (const sign of [1, -1]) {
      const g = new TerminalGesture()
      g.begin(200, 300, 0)
      g.move(200 + sign * 40, 302)
      g.move(200 + sign * (EXIT_DISTANCE_PX + 5), 305)
      expect(g.end(2000)).toBe('exit')
    }
  })

  it('a short horizontal flick leaves; the same distance dragged slowly does not', () => {
    const quick = new TerminalGesture()
    quick.begin(200, 300, 0)
    quick.move(140, 300)
    expect(quick.end(80)).toBe('exit')

    const slow = new TerminalGesture()
    slow.begin(200, 300, 0)
    slow.move(140, 300)
    expect(slow.end(1000)).toBe('none')
  })

  it('reports how far a swipe has gone, for feedback while dragging', () => {
    const g = new TerminalGesture()
    g.begin(200, 300, 0)
    expect(g.move(170, 302)).toEqual({ kind: 'swipe', dx: -30 })
  })
})
