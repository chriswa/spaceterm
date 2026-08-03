import type { MaskRect, ReparentEdge, TreeLineNode } from '../components/CanvasBackground'

/**
 * Everything the canvas frame is a function of.
 *
 * If two frames agree on all of this, they would draw the same pixels — so the
 * second one need not be drawn at all. That is the entire claim this module
 * makes, and it is only sound if the list is *complete*: a field left out here
 * is a stale canvas, which is the worst failure mode available (silent, and
 * only visible as "the background stopped updating that one time").
 *
 * So the rule for anything added to the render loop: if it can change what is
 * drawn, it belongs in this interface. The compiler enforces the second half of
 * that — `CanvasBackground` builds this object explicitly — but not the first.
 */
export interface FrameInputs {
  /** Drawing-buffer size, in device pixels. */
  width: number
  height: number
  /**
   * Layout size, in CSS pixels. The edge shader's `uResolution` and the mask
   * quads' NDC conversion are computed from these, not from the buffer size.
   *
   * Very nearly redundant — the buffer is `round(client * dpr)` — but only
   * *very* nearly: at a device pixel ratio below 1 two client widths can round
   * to the same buffer width. Cheaper to list than to argue about.
   */
  clientWidth: number
  clientHeight: number
  camX: number
  camY: number
  camZ: number
  /**
   * The background's clock, or `null` when its facet declares itself static.
   *
   * Null rather than "ignore the number": a static facet's time genuinely is
   * not an input, and passing `null` says so at the call site instead of
   * leaving a live-but-unread field for someone to wire back in.
   */
  bgTime: number | null
  /** The edges' clock, or `null` when the edge facet declares itself static. */
  edgeTime: number | null
  /** Facets are resolved from this, so a theme switch is a change. */
  themeId: string
  edges: readonly TreeLineNode[]
  maskRects: readonly MaskRect[]
  selection: string | null
  reparentEdge: ReparentEdge | null
}

/**
 * Whether the canvas has to be redrawn, given what it drew last time.
 *
 * ## Why skipping is safe
 *
 * The loop clears and redraws the whole canvas every frame, so a frame is
 * either drawn in full or not at all — there is no partial state to corrupt.
 * Issuing no GL commands leaves the last composited frame on screen, which is
 * exactly the previous frame's contents, which is exactly what this frame would
 * have produced. (Skipping would *not* be safe with incremental drawing on a
 * context created without `preserveDrawingBuffer`; that is a different design.)
 *
 * The rAF loop keeps running either way. What is saved is the draw, which for a
 * full-screen fragment shader plus a mask quad per card is essentially the whole
 * cost — not the callback.
 *
 * ## Why comparison rather than a hash or a dirty flag
 *
 * A hash of the inputs would be shorter to write and can collide, and a
 * collision here means a frame that silently never repaints. The arrays are one
 * entry per node — tens, maybe hundreds — so an exact field-by-field compare is
 * far cheaper than the draw it avoids and cannot be wrong.
 *
 * A dirty flag set by the producers would be cheaper still, and was rejected:
 * it would put the correctness burden on every writer of `edgesRef`,
 * `maskRectsRef` and the camera, scattered across `App.tsx`, where forgetting
 * one is invisible until someone notices the canvas is stale. Here the cost of
 * being wrong is bounded by this file.
 */
export class CanvasFrameGate {
  private previous: FrameInputs | null = null

  /**
   * Record `next` and report whether it differs from the last frame drawn.
   *
   * Callers must draw when this returns true and must not when it returns
   * false: the recorded state assumes the frame it approved was actually
   * rendered.
   */
  shouldDraw(next: FrameInputs): boolean {
    const previous = this.previous
    // Copied, not aliased: `edges` and `maskRects` are live arrays the renderer
    // mutates in place, so holding the caller's reference would compare a frame
    // against itself and skip forever.
    this.previous = {
      ...next,
      edges: next.edges.map((e) => ({ ...e })),
      maskRects: next.maskRects.map((r) => ({ ...r })),
      reparentEdge: next.reparentEdge ? { ...next.reparentEdge } : null,
    }
    return previous === null || differs(previous, next)
  }

  /**
   * Force the next frame to draw.
   *
   * For state changes outside `FrameInputs` — a shader finishing compilation,
   * the window becoming visible again — where the inputs are unchanged but the
   * drawing buffer's contents are not to be trusted.
   */
  invalidate(): void {
    this.previous = null
  }
}

function differs(a: FrameInputs, b: FrameInputs): boolean {
  return (
    a.width !== b.width ||
    a.height !== b.height ||
    a.clientWidth !== b.clientWidth ||
    a.clientHeight !== b.clientHeight ||
    a.camX !== b.camX ||
    a.camY !== b.camY ||
    a.camZ !== b.camZ ||
    a.bgTime !== b.bgTime ||
    a.edgeTime !== b.edgeTime ||
    a.themeId !== b.themeId ||
    a.selection !== b.selection ||
    reparentDiffers(a.reparentEdge, b.reparentEdge) ||
    edgesDiffer(a.edges, b.edges) ||
    maskRectsDiffer(a.maskRects, b.maskRects)
  )
}

function reparentDiffers(a: ReparentEdge | null, b: ReparentEdge | null): boolean {
  if (a === null || b === null) return a !== b
  return a.fromX !== b.fromX || a.fromY !== b.fromY || a.toX !== b.toX || a.toY !== b.toY
}

function edgesDiffer(a: readonly TreeLineNode[], b: readonly TreeLineNode[]): boolean {
  if (a.length !== b.length) return true
  for (let i = 0; i < a.length; i++) {
    // Order matters as well as content: the loop emits quads in array order, so
    // a reorder is a different draw even when the set is identical.
    if (a[i].id !== b[i].id || a[i].parentId !== b[i].parentId) return true
    if (a[i].x !== b[i].x || a[i].y !== b[i].y) return true
  }
  return false
}

function maskRectsDiffer(a: readonly MaskRect[], b: readonly MaskRect[]): boolean {
  if (a.length !== b.length) return true
  for (let i = 0; i < a.length; i++) {
    if (a[i].x !== b[i].x || a[i].y !== b[i].y) return true
    if (a[i].width !== b[i].width || a[i].height !== b[i].height) return true
  }
  return false
}
