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

/** A gate that has already drawn `base()`, which is the interesting state. */
function settled(): CanvasFrameGate {
  const gate = new CanvasFrameGate()
  gate.shouldDraw(base())
  return gate
}

describe('CanvasFrameGate', () => {
  it('always draws the first frame', () => {
    expect(new CanvasFrameGate().shouldDraw(base())).toBe(true)
  })

  it('skips a still canvas under a fully static theme', () => {
    // The whole point. Both clocks null, nothing else moving.
    const gate = settled()
    expect(gate.shouldDraw(base())).toBe(false)
    expect(gate.shouldDraw(base())).toBe(false)
  })

  it('never skips while either facet is animated', () => {
    // One live clock is enough: the edges composite over the background, so
    // neither can be repainted without the other.
    for (const clock of ['bgTime', 'edgeTime'] as const) {
      const gate = new CanvasFrameGate()
      for (let frame = 0; frame < 4; frame++) {
        const inputs = { ...base(), [clock]: frame * 0.016 }
        expect(gate.shouldDraw(inputs), `${clock} frame ${frame}`).toBe(true)
      }
    }
  })

  it('draws again when any scalar input changes', () => {
    const changes: Partial<FrameInputs>[] = [
      { width: 1601 },
      { height: 901 },
      { clientWidth: 801 },
      { clientHeight: 451 },
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
      expect(gate.shouldDraw({ ...base(), ...change }), JSON.stringify(change)).toBe(true)
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
      expect(gate.shouldDraw({ ...base(), edges }), name).toBe(true)
    }
  })

  it('draws again when the edge order changes', () => {
    // Quads are emitted in array order, so a reorder is a different draw even
    // though the set is identical — and blending makes that visible.
    const gate = new CanvasFrameGate()
    const edges = [edge('a', 'root', 1, 2), edge('b', 'root', 3, 4)]
    gate.shouldDraw({ ...base(), edges })
    expect(gate.shouldDraw({ ...base(), edges: [edges[1], edges[0]] })).toBe(true)
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
      expect(gate.shouldDraw({ ...base(), maskRects }), name).toBe(true)
    }
  })

  it('draws again when the reparent preview appears, moves, or clears', () => {
    const edge = { fromX: 0, fromY: 0, toX: 10, toY: 10 }
    const gate = new CanvasFrameGate()
    gate.shouldDraw(base())
    expect(gate.shouldDraw({ ...base(), reparentEdge: edge })).toBe(true)
    expect(gate.shouldDraw({ ...base(), reparentEdge: { ...edge } })).toBe(false)
    expect(gate.shouldDraw({ ...base(), reparentEdge: { ...edge, toX: 11 } })).toBe(true)
    expect(gate.shouldDraw({ ...base(), reparentEdge: null })).toBe(true)
  })

  it('survives the caller mutating the arrays it was handed', () => {
    // `edgesRef.current` and `maskRectsRef.current` are live arrays the renderer
    // writes through. Holding the caller's reference would compare a frame
    // against itself and skip for ever — which is a frozen canvas, not a
    // wasted frame, so it is the one aliasing bug that must not exist here.
    const gate = new CanvasFrameGate()
    const edges = [edge('a', 'root', 0, 0)]
    const maskRects = [{ x: 0, y: 0, width: 10, height: 10 }]
    gate.shouldDraw({ ...base(), edges, maskRects })

    edges[0].x = 999
    expect(gate.shouldDraw({ ...base(), edges, maskRects })).toBe(true)

    maskRects[0].width = 999
    expect(gate.shouldDraw({ ...base(), edges, maskRects })).toBe(true)
  })

  it('redraws once after being invalidated', () => {
    // For state outside FrameInputs — the window coming back into view, where
    // the inputs are unchanged but the drawing buffer's contents are not.
    const gate = settled()
    expect(gate.shouldDraw(base())).toBe(false)
    gate.invalidate()
    expect(gate.shouldDraw(base())).toBe(true)
    expect(gate.shouldDraw(base())).toBe(false)
  })
})
