import { describe, it, expect } from 'vitest'
import { TerminalGesture, LONG_PRESS_MS, EXIT_DISTANCE_PX, FLICK_DISTANCE_PX, PINCH_EXIT_SCALE } from './terminal-gesture'

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
    // The first scroll includes the travel before the direction was decided.
    expect(g.move(100, 280)).toEqual({ kind: 'scroll', deltaY: 20 })
    expect(g.move(102, 255)).toEqual({ kind: 'scroll', deltaY: 25 })
    expect(g.move(100, 265)).toEqual({ kind: 'scroll', deltaY: -10 })
    // Neither a tap nor a press once it has scrolled, however long it took.
    expect(g.end(5000)).toBe('none')
  })

  it('a thumb arc that starts out sideways is still a scroll', () => {
    // 25 across and 18 up at the decision point — far from flat enough to be a swipe.
    const g = new TerminalGesture()
    g.begin(100, 300, 0)
    expect(g.move(125, 282).kind).toBe('scroll')
    g.move(140, 200)
    expect(g.end(150)).toBe('none')
  })

  it('a swipe that drifts into a vertical drag does not leave', () => {
    const g = new TerminalGesture()
    g.begin(300, 300, 0)
    expect(g.move(270, 305).kind).toBe('swipe')
    g.move(150, 200)
    expect(g.end(100)).toBe('none')
  })

  it('stays a scroll once it is one, even if the finger drifts sideways', () => {
    const g = new TerminalGesture()
    g.begin(100, 300, 0)
    g.move(100, 280)
    expect(g.move(300, 280).kind).toBe('scroll')
    expect(g.end(100)).toBe('none')
  })

  it('a long horizontal drag leaves as it gets there, in either direction, and is then done', () => {
    for (const sign of [1, -1]) {
      const g = new TerminalGesture()
      g.begin(200, 300, 0)
      expect(g.move(200 + sign * 40, 302).kind).toBe('swipe')
      expect(g.move(200 + sign * (EXIT_DISTANCE_PX + 5), 305)).toEqual({ kind: 'exit' })
      // The rest of the touch belongs to the canvas.
      expect(g.move(200 + sign * 300, 305).kind).toBe('none')
      expect(g.end(2000)).toBe('none')
    }
  })

  it('a quick horizontal flick leaves; the same distance dragged slowly does not', () => {
    const quick = new TerminalGesture()
    quick.begin(200, 300, 0)
    quick.move(200 - FLICK_DISTANCE_PX - 5, 302)
    expect(quick.end(100)).toBe('exit')

    const slow = new TerminalGesture()
    slow.begin(200, 300, 0)
    slow.move(200 - FLICK_DISTANCE_PX - 5, 302)
    expect(slow.end(1000)).toBe('none')
  })

  it('a short quick sideways nudge does not leave', () => {
    const g = new TerminalGesture()
    g.begin(200, 300, 0)
    g.move(200 - (FLICK_DISTANCE_PX - 15), 301)
    expect(g.end(60)).toBe('none')
  })

  it('movement past the slop that never picks a direction is neither a tap nor a press', () => {
    const g = new TerminalGesture()
    g.begin(100, 100, 0)
    g.move(108, 108)
    expect(g.isStill()).toBe(false)
    expect(g.end(LONG_PRESS_MS + 100)).toBe('none')
  })

  it('reports how far a swipe has gone, for feedback while dragging', () => {
    const g = new TerminalGesture()
    g.begin(200, 300, 0)
    expect(g.move(170, 303)).toEqual({ kind: 'swipe', dx: -30 })
  })

  it('pinching in past the threshold leaves then and there', () => {
    const g = new TerminalGesture()
    g.begin(150, 300, 0)
    g.pinch(200)
    expect(g.pinchMove(190)).toEqual({ kind: 'pinch', scale: 0.95 })
    expect(g.pinchMove(200 * PINCH_EXIT_SCALE - 1)).toEqual({ kind: 'exit' })
    expect(g.pinchMove(50).kind).toBe('none')
    expect(g.end(400)).toBe('none')
  })

  it('a pinch released short of the threshold stays', () => {
    const g = new TerminalGesture()
    g.begin(150, 300, 0)
    g.pinch(200)
    g.pinchMove(200 * PINCH_EXIT_SCALE + 5)
    expect(g.end(400)).toBe('none')
  })

  it('a second finger turns a scroll into a pinch, and the first finger stops scrolling', () => {
    const g = new TerminalGesture()
    g.begin(150, 300, 0)
    expect(g.move(150, 270).kind).toBe('scroll')
    g.pinch(180)
    expect(g.move(150, 200).kind).toBe('none')
    expect(g.pinchMove(100)).toEqual({ kind: 'exit' })
  })

  it('pinching out (zooming in) does not leave', () => {
    const g = new TerminalGesture()
    g.begin(150, 300, 0)
    g.pinch(100)
    g.pinchMove(200)
    expect(g.end(300)).toBe('none')
  })
})
