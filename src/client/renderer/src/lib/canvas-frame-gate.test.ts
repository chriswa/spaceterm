import { describe, it, expect } from 'vitest'
import { asNodeId } from '../../../../shared/ids'
import { CanvasFrameGate, type FrameInputs } from './canvas-frame-gate'

/**
 * The gate decides whether a frame is drawn at all, so its two failure modes
 * are asymmetric and both worth pinning:
 *
 * - Drawing when it need not have is a wasted frame. Costly, never wrong.
 * - *Not* drawing when it should have is a stale canvas — silent, and reported
 *   as "the background sometimes stops updating".
 *
 * So every input gets a test that changing it forces a draw, and the "skips"
 * tests are deliberately few: they assert the one case skipping is for.
 */

/** `TreeLineNode`'s ids are branded, and spelling that out inline drowns the tests. */
const edge = (id: string, parentId: string, x: number, y: number) => ({
  id: asNodeId(id),
  parentId: asNodeId(parentId),
  x,
  y,
})

const base = (): FrameInputs => ({
  width: 1600,
  height: 900,
  clientWidth: 800,
  clientHeight: 450,
  dpr: 2,
  camX: 10,
  camY: 20,
  camZ: 1,
  bgTime: null,
  edgeTime: null,
  themeId: 'concentric',
  edges: [edge('a', 'root', 100, 200)],
  maskRects: [{ x: 0, y: 0, width: 300, height: 200 }],
  selection: null,
  reparentEdge: null,
})

const MAX_SKIP_MS = 1_000

/**
 * A gate driven by an explicit clock.
 *
 * Every case but the backstop's own wants time to stand still: the gate forces a
 * redraw when nothing has been drawn for `MAX_SKIP_MS`, so a suite that let the
 * wall clock run would see that as a flake on a slow machine.
 */
function clocked(maxSkipMs: number = MAX_SKIP_MS) {
  const gate = new CanvasFrameGate(maxSkipMs)
  let now = 0
  return {
    draw: (inputs: FrameInputs = base()): boolean => gate.shouldDraw(inputs, now),
    advance: (ms: number): void => { now += ms },
    invalidate: (): void => gate.invalidate(),
  }
}

/** A gate that has already drawn `base()`, which is the interesting state. */
function settled(): ReturnType<typeof clocked> {
  const gate = clocked()
  gate.draw()
  return gate
}

describe('CanvasFrameGate', () => {
  it('always draws the first frame', () => {
    expect(clocked().draw()).toBe(true)
  })

  it('skips a still canvas under a fully static theme', () => {
    // The whole point. Both clocks null, nothing else moving.
    const gate = settled()
    expect(gate.draw()).toBe(false)
    expect(gate.draw()).toBe(false)
  })

  it('never skips while either facet is animated', () => {
    // One live clock is enough: the edges composite over the background, so
    // neither can be repainted without the other.
    for (const clock of ['bgTime', 'edgeTime'] as const) {
      const gate = clocked()
      for (let frame = 0; frame < 4; frame++) {
        const inputs = { ...base(), [clock]: frame * 0.016 }
        expect(gate.draw(inputs), `${clock} frame ${frame}`).toBe(true)
      }
    }
  })

  it('draws again when any scalar input changes', () => {
    const changes: Partial<FrameInputs>[] = [
      { width: 1601 },
      { height: 901 },
      { clientWidth: 801 },
      { clientHeight: 451 },
      // A display change moves this and nothing else — the buffer size is
      // computed from it, so the two agree on a new value at the same moment.
      { dpr: 1 },
      { camX: 10.5 },
      { camY: 20.5 },
      { camZ: 1.0001 },
      { themeId: 'default' },
      { selection: 'a' },
      { bgTime: 0 },
      { edgeTime: 0 },
    ]
    for (const change of changes) {
      const gate = settled()
      expect(gate.draw({ ...base(), ...change }), JSON.stringify(change)).toBe(true)
    }
  })

  it('draws again when an edge moves, appears, or is reparented', () => {
    const cases: Record<string, FrameInputs['edges']> = {
      moved: [edge('a', 'root', 101, 200)],
      added: [edge('a', 'root', 100, 200), edge('b', 'a', 300, 400)],
      removed: [],
      reparented: [edge('a', 'b', 100, 200)],
      renamed: [edge('z', 'root', 100, 200)],
    }
    for (const [name, edges] of Object.entries(cases)) {
      const gate = settled()
      expect(gate.draw({ ...base(), edges }), name).toBe(true)
    }
  })

  it('draws again when the edge order changes', () => {
    // Quads are emitted in array order, so a reorder is a different draw even
    // though the set is identical — and blending makes that visible.
    const gate = clocked()
    const edges = [edge('a', 'root', 1, 2), edge('b', 'root', 3, 4)]
    gate.draw({ ...base(), edges })
    expect(gate.draw({ ...base(), edges: [edges[1], edges[0]] })).toBe(true)
  })

  it('draws again when a card moves or resizes under the mask', () => {
    const cases: Record<string, FrameInputs['maskRects']> = {
      moved: [{ x: 1, y: 0, width: 300, height: 200 }],
      resized: [{ x: 0, y: 0, width: 301, height: 200 }],
      added: [
        { x: 0, y: 0, width: 300, height: 200 },
        { x: 500, y: 0, width: 300, height: 200 },
      ],
      removed: [],
    }
    for (const [name, maskRects] of Object.entries(cases)) {
      const gate = settled()
      expect(gate.draw({ ...base(), maskRects }), name).toBe(true)
    }
  })

  it('draws again when the reparent preview appears, moves, or clears', () => {
    const edge = { fromX: 0, fromY: 0, toX: 10, toY: 10 }
    const gate = clocked()
    gate.draw()
    expect(gate.draw({ ...base(), reparentEdge: edge })).toBe(true)
    expect(gate.draw({ ...base(), reparentEdge: { ...edge } })).toBe(false)
    expect(gate.draw({ ...base(), reparentEdge: { ...edge, toX: 11 } })).toBe(true)
    expect(gate.draw({ ...base(), reparentEdge: null })).toBe(true)
  })

  it('survives the caller mutating the arrays it was handed', () => {
    // `edgesRef.current` and `maskRectsRef.current` are live arrays the renderer
    // writes through. Holding the caller's reference would compare a frame
    // against itself and skip for ever — which is a frozen canvas, not a
    // wasted frame, so it is the one aliasing bug that must not exist here.
    const gate = clocked()
    const edges = [edge('a', 'root', 0, 0)]
    const maskRects = [{ x: 0, y: 0, width: 10, height: 10 }]
    gate.draw({ ...base(), edges, maskRects })

    edges[0].x = 999
    expect(gate.draw({ ...base(), edges, maskRects })).toBe(true)

    maskRects[0].width = 999
    expect(gate.draw({ ...base(), edges, maskRects })).toBe(true)
  })

  it('redraws once after being invalidated', () => {
    // For state outside FrameInputs — the window coming back into view, where
    // the inputs are unchanged but the drawing buffer's contents are not.
    const gate = settled()
    expect(gate.draw()).toBe(false)
    gate.invalidate()
    expect(gate.draw()).toBe(true)
    expect(gate.draw()).toBe(false)
  })

  /**
   * The backstop is what keeps a gap in the other two guards to one second
   * rather than until the app is reloaded: Chromium can discard the composited
   * frame for reasons the renderer is never told about, and only the app can
   * repaint a canvas.
   */
  describe('the periodic backstop', () => {
    it('draws a frame nothing else asked for, once the skip runs long', () => {
      const gate = settled()
      gate.advance(MAX_SKIP_MS - 1)
      expect(gate.draw()).toBe(false)
      gate.advance(1)
      expect(gate.draw()).toBe(true)
    })

    it('fires at its own period, not once per frame after the deadline', () => {
      const gate = settled()
      gate.advance(MAX_SKIP_MS)
      expect(gate.draw()).toBe(true)
      // The forced frame restarts the clock — otherwise every frame after the
      // first deadline would draw, and the optimisation would be gone.
      expect(gate.draw()).toBe(false)
      gate.advance(MAX_SKIP_MS - 1)
      expect(gate.draw()).toBe(false)
      gate.advance(1)
      expect(gate.draw()).toBe(true)
    })

    it('is deferred by a frame drawn for any other reason', () => {
      const gate = settled()
      gate.advance(MAX_SKIP_MS - 1)
      expect(gate.draw({ ...base(), camX: 11 })).toBe(true)
      gate.advance(1)
      expect(gate.draw({ ...base(), camX: 11 })).toBe(false)
    })
  })
})
