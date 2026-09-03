import { useEffect, useRef } from 'react'
import type { Camera } from '../lib/camera'
import { isWindowVisible, onWindowVisibleChange } from '../hooks/useWindowVisible'
import type { NodeId } from '../../../../shared/ids'
import { useThemeStore } from '../stores/themeStore'
import { resolveFacets } from '../lib/theme/themes'
import type { BackgroundFacet, EdgeFacet } from '../lib/theme/facets'
import { BG_VERT_SRC, EDGE_VERT_SRC } from '../lib/theme/shaders'
import { CanvasFrameGate } from '../lib/canvas-frame-gate'
import { FrameLimiter, quantizeClock } from '../lib/frame-policy'
import { chromeNeedsEdgeMask } from '../lib/card-surface'
import { isCardOnScreen } from '../lib/viewport'

export interface TreeLineNode {
  id: NodeId
  parentId: NodeId
  x: number
  y: number
  /** Age-band brightness of the child subtree this edge leads into. */
  brightness: number
}

export interface MaskRect {
  x: number // center x (world space)
  y: number // center y (world space)
  width: number
  height: number
}

export interface ReparentEdge {
  fromX: number
  fromY: number
  toX: number
  toY: number
}

interface CanvasBackgroundProps {
  camera: Camera
  cameraRef: React.MutableRefObject<Camera>
  edgesRef: React.MutableRefObject<TreeLineNode[]>
  maskRectsRef: React.MutableRefObject<MaskRect[]>
  selectionRef: React.RefObject<string | null>
  reparentEdgeRef: React.RefObject<ReparentEdge | null>
}

/* ------------------------------------------------------------------ */
/*  GL program construction                                            */
/* ------------------------------------------------------------------ */

/**
 * A GLSL compile error used to fail silently here, which is the worst possible
 * behaviour for the one thing in this app whose source is a string: the canvas
 * simply went black, with the driver's diagnostic — line number and all —
 * discarded. Shader sources are assembled from several template fragments, so
 * "the background disappeared" was the only symptom of a typo in any of them.
 */
function compileShader(gl: WebGLRenderingContext, type: number, src: string): WebGLShader | null {
  const s = gl.createShader(type)
  if (!s) return null
  gl.shaderSource(s, src)
  gl.compileShader(s)
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const stage = type === gl.VERTEX_SHADER ? 'vertex' : 'fragment'
    window.api.log(`[CanvasBackground] ${stage} shader failed to compile: ${gl.getShaderInfoLog(s)}`)
    gl.deleteShader(s)
    return null
  }
  return s
}

function createProgram(gl: WebGLRenderingContext, vertSrc: string, fragSrc: string): WebGLProgram | null {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vertSrc)
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fragSrc)
  if (!vs || !fs) {
    if (vs) gl.deleteShader(vs)
    if (fs) gl.deleteShader(fs)
    return null
  }

  const prog = gl.createProgram()!
  gl.attachShader(prog, vs)
  gl.attachShader(prog, fs)
  gl.linkProgram(prog)
  // Shaders are reference-counted by the program; detaching and deleting here
  // frees the compiler's copy without invalidating the linked program.
  gl.detachShader(prog, vs)
  gl.detachShader(prog, fs)
  gl.deleteShader(vs)
  gl.deleteShader(fs)
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    window.api.log(`[CanvasBackground] program failed to link: ${gl.getProgramInfoLog(prog)}`)
    gl.deleteProgram(prog)
    return null
  }
  return prog
}

interface BgStage {
  prog: WebGLProgram
  pos: number
  time: WebGLUniformLocation | null
  origin: WebGLUniformLocation | null
  zoom: WebGLUniformLocation | null
  dpr: WebGLUniformLocation | null
}

interface EdgeStage {
  prog: WebGLProgram
  pos: number
  uv: number
  pan: WebGLUniformLocation | null
  zoom: WebGLUniformLocation | null
  res: WebGLUniformLocation | null
  time: WebGLUniformLocation | null
  bgTime: WebGLUniformLocation | null
  bgOrigin: WebGLUniformLocation | null
  intensity: WebGLUniformLocation | null
  brightness: WebGLUniformLocation | null
  dpr: WebGLUniformLocation | null
}

/** A compiled stage, or `null` if its shader failed to build. */
function buildBgStage(gl: WebGLRenderingContext, frag: string): BgStage | null {
  const prog = createProgram(gl, BG_VERT_SRC, frag)
  if (!prog) return null
  return {
    prog,
    pos: gl.getAttribLocation(prog, 'a_position'),
    time: gl.getUniformLocation(prog, 'iTime'),
    origin: gl.getUniformLocation(prog, 'uOrigin'),
    zoom: gl.getUniformLocation(prog, 'uZoom'),
    dpr: gl.getUniformLocation(prog, 'uDpr'),
  }
}

function buildEdgeStage(gl: WebGLRenderingContext, frag: string, vert: string): EdgeStage | null {
  const prog = createProgram(gl, vert, frag)
  if (!prog) return null
  return {
    prog,
    pos: gl.getAttribLocation(prog, 'a_position'),
    uv: gl.getAttribLocation(prog, 'a_uv'),
    pan: gl.getUniformLocation(prog, 'uPan'),
    zoom: gl.getUniformLocation(prog, 'uZoom'),
    res: gl.getUniformLocation(prog, 'uResolution'),
    time: gl.getUniformLocation(prog, 'uTime'),
    bgTime: gl.getUniformLocation(prog, 'uBgTime'),
    bgOrigin: gl.getUniformLocation(prog, 'uBgOrigin'),
    intensity: gl.getUniformLocation(prog, 'uIntensity'),
    brightness: gl.getUniformLocation(prog, 'uBrightness'),
    dpr: gl.getUniformLocation(prog, 'uDpr'),
  }
}

interface StageCache<F, S> {
  get(facet: F): S | null
  values(): (S | null)[]
}

/**
 * Compile-once-per-shader cache.
 *
 * Keyed by *facet* id rather than theme id, because `background` and `edges`
 * are independent facets: two themes that share a background must share its
 * compiled program rather than each getting one. `has` distinguishes "not
 * compiled yet" from "compiled and failed", so a broken shader is not retried
 * every frame.
 */
function makeStageCache<F extends { id: string }, S>(build: (facet: F) => S | null): StageCache<F, S> {
  const cache = new Map<string, S | null>()
  return {
    get(facet: F): S | null {
      if (!cache.has(facet.id)) cache.set(facet.id, build(facet))
      return cache.get(facet.id)!
    },
    values: (): (S | null)[] => [...cache.values()],
  }
}

/**
 * Everything that dies with the GL context, and so has to be rebuilt when one
 * is restored.
 *
 * Grouped rather than held as separate `let`s so that "the context went away"
 * is one assignment — `resources = null` — and every user of them has to say
 * what it does without a context instead of reaching for a stale program id.
 */
interface GlResources {
  bgCache: StageCache<BackgroundFacet, BgStage>
  edgeCache: StageCache<EdgeFacet, EdgeStage>
  bgBuf: WebGLBuffer | null
  edgeBuf: WebGLBuffer | null
  maskBuf: WebGLBuffer | null
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

const FLOATS_PER_VERTEX = 4 // x, y, u, v
const VERTS_PER_EDGE = 6
const FLOATS_PER_EDGE = VERTS_PER_EDGE * FLOATS_PER_VERTEX // 24
// Zoom exponent: (1/z)^0.7 gives ~5x at z=0.1, 1x at z=1.0
const ZOOM_WIDTH_EXP = Math.log(5) / Math.log(10) // ≈ 0.699
/** Intensity for the selected-edge and reparent-preview highlight passes. */
const HIGHLIGHT_INTENSITY = 3.0

/** Shared empty list, so "no masking this frame" allocates nothing. */
const NO_MASK_RECTS: readonly MaskRect[] = []

/**
 * The mask rects that can actually change a pixel this frame.
 *
 * A mask quad's cost is its area in fragments of the *background* shader, and a
 * card off the side of the screen contributes none — but it was still being
 * uploaded, drawn, and (more expensively) counted by `CanvasFrameGate` as a
 * reason the frame differed from the last one. `margin` is zero here, unlike
 * the card-freshness use of `isCardOnScreen`: this is about what is on screen
 * now, not about what needs to be kept current for a pan that has not happened.
 */
function visibleMaskRects(
  rects: readonly MaskRect[],
  camera: Camera,
  cssWidth: number,
  cssHeight: number
): readonly MaskRect[] {
  const viewport = { width: cssWidth, height: cssHeight }
  const visible = rects.filter((rect) => isCardOnScreen(rect, camera, viewport, 0))
  // Nothing culled is the common case when zoomed in on a small surface; hand
  // back the original so the gate's copy is the only allocation.
  return visible.length === rects.length ? rects : visible
}

export function CanvasBackground({ cameraRef, edgesRef, maskRectsRef, selectionRef, reparentEdgeRef }: CanvasBackgroundProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rafRef = useRef<number>(0)
  // Read through a ref: the render loop must see theme changes without the GL
  // context being torn down and rebuilt, which re-running the effect would do.
  const themeId = useThemeStore(s => s.themeId)
  const themeIdRef = useRef(themeId)
  themeIdRef.current = themeId

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const gl = canvas.getContext('webgl', {
      alpha: true,
      premultipliedAlpha: false,
      antialias: false,
    })
    if (!gl) return

    // --- CPU-side vertex staging. Outlives the context; only the GPU buffers
    //     it is uploaded into do not. ---
    let maskVerts = new Float32Array(64 * 12) // 6 verts × 2 floats per rect
    let edgeVerts = new Float32Array(64 * FLOATS_PER_EDGE)

    const createResources = (): GlResources => {
      gl.getExtension('OES_standard_derivatives') // required for fwidth() in edge SDF
      gl.enable(gl.BLEND)
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)

      const bgBuf = gl.createBuffer()
      gl.bindBuffer(gl.ARRAY_BUFFER, bgBuf)
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)

      return {
        // Compiled lazily and kept: switching themes back and forth must not
        // recompile, and a shader the user never selects must never cost anything.
        bgCache: makeStageCache<BackgroundFacet, BgStage>((f) => buildBgStage(gl, f.frag)),
        // An edge facet may bring its own vertex shader; most take the animated default.
        edgeCache: makeStageCache<EdgeFacet, EdgeStage>(
          (f) => buildEdgeStage(gl, f.frag, f.vert ?? EDGE_VERT_SRC),
        ),
        bgBuf,
        edgeBuf: gl.createBuffer(),
        // Reuses the background program to paint over edges behind transparent cards.
        maskBuf: gl.createBuffer(),
      }
    }

    const destroyResources = (res: GlResources): void => {
      for (const stage of [...res.bgCache.values(), ...res.edgeCache.values()]) {
        if (stage) gl.deleteProgram(stage.prog)
      }
      gl.deleteBuffer(res.bgBuf)
      gl.deleteBuffer(res.edgeBuf)
      gl.deleteBuffer(res.maskBuf)
    }

    let resources: GlResources | null = createResources()

    const bgT0 = performance.now() - (Math.random() * 2_000_000 - 1_000_000)
    const edgeT0 = performance.now()

    // What lets a fully static theme stop repainting a still canvas. See
    // `canvas-frame-gate` for why this is a comparison and not a dirty flag,
    // and for the backstop that bounds how long a skip can last.
    const gate = new CanvasFrameGate()
    // The ceiling and the unfocused rate. No intrinsic rate of its own: what
    // this canvas's *content* needs is already declared per facet as
    // `animatedHz` and enforced by quantising their clocks, so a second opinion
    // here would only be able to disagree with it.
    const limiter = new FrameLimiter()

    /**
     * Layout size in CSS pixels, and the DPR the drawing buffer was sized for.
     *
     * Cached rather than read per frame. `clientWidth` is a layout read, and the
     * crab-dance loop writes DOM styles from its own rAF callback, so a read
     * here forced a synchronous layout of a document holding every card on the
     * surface — every frame, whether or not anything had resized.
     */
    let cssWidth = 0
    let cssHeight = 0
    let sizedForDpr = 0

    /**
     * Re-read layout and resize the drawing buffer to match.
     *
     * Called from the `ResizeObserver` (where layout has already been done, so
     * the read is free) and when the DPR changes underneath us — which happens
     * when the window moves to a display with a different scale factor, and
     * which nothing else would notice.
     */
    const measure = (dpr: number) => {
      cssWidth = canvas.clientWidth
      cssHeight = canvas.clientHeight
      sizedForDpr = dpr
      const w = Math.round(cssWidth * dpr)
      const h = Math.round(cssHeight * dpr)
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w
        canvas.height = h
      }
    }

    const observer = new ResizeObserver(() => measure(window.devicePixelRatio))
    observer.observe(canvas)
    measure(window.devicePixelRatio)

    const tick = (now: number) => {
      const res = resources
      if (!res) {
        // Context lost; `webglcontextrestored` restarts the loop. Clearing the
        // handle keeps it honest as the "loop is running" flag `startLoop` reads.
        rafRef.current = 0
        return
      }

      // Before the gate, and before anything is measured: a frame the policy
      // has not allowed must leave no trace, and `shouldDraw` records the frame
      // it approves.
      if (!limiter.shouldRun(now)) {
        rafRef.current = requestAnimationFrame(tick)
        return
      }

      const dpr = window.devicePixelRatio
      if (dpr !== sizedForDpr) measure(dpr)

      const cam = cameraRef.current
      const themeId = themeIdRef.current
      const facets = resolveFacets(themeId)
      const bg = res.bgCache.get(facets.background)
      const edge = res.edgeCache.get(facets.edges)

      // Each facet's clock is stepped down to the rate it declared, so the
      // frames in between are handed an identical value and the gate skips them.
      // `null` means the facet promised its output does not depend on time at
      // all; with both clocks out, a canvas nobody is moving stops being redrawn
      // entirely.
      const bgClock = quantizeClock(now - bgT0, facets.background.animatedHz)
      const bgTime = (bgClock ?? 0) / 1666
      // The edges composite over the background, so a frame drawn for either
      // clock has to redraw both — which is why quantising them separately is
      // sound but skipping only one of the two passes would not be.
      const edgeClock = quantizeClock(now - edgeT0, facets.edges.animatedHz)
      const edgeTime = (edgeClock ?? 0) / 2000

      // Opaque card chrome hides whatever is behind it without any help from
      // us, so the masking pass is pure overdraw — one full evaluation of the
      // background shader per card. See `chromeNeedsEdgeMask`.
      const masking = chromeNeedsEdgeMask(facets.cardChrome)
      // Culled here rather than in the draw so the gate sees the same list: a
      // card that is off screen cannot change a pixel, and treating its
      // movement as a redraw reason is what kept the canvas repainting while
      // cards drifted about out of view.
      const maskRects = masking
        ? visibleMaskRects(maskRectsRef.current, cam, cssWidth, cssHeight)
        : NO_MASK_RECTS

      if (!gate.shouldDraw({
        width: canvas.width,
        height: canvas.height,
        clientWidth: cssWidth,
        clientHeight: cssHeight,
        dpr,
        camX: cam.x,
        camY: cam.y,
        camZ: cam.z,
        // The edge clock is only an input when there is an edge to draw it on.
        // A surface with no edges yet would otherwise repaint forever for a
        // chevron crawl nothing is crawling along.
        bgTime: bgClock === null ? null : bgTime,
        edgeTime: edgeClock === null || edgesRef.current.length === 0 ? null : edgeTime,
        themeId,
        edges: edgesRef.current,
        maskRects,
        selection: selectionRef.current,
        reparentEdge: reparentEdgeRef.current,
      }, now)) {
        rafRef.current = requestAnimationFrame(tick)
        return
      }

      gl.viewport(0, 0, canvas.width, canvas.height)
      gl.clearColor(0, 0, 0, 0)
      gl.clear(gl.COLOR_BUFFER_BIT)

      // Both the full-screen pass and the card masks bind the background
      // program identically; only the vertex buffer and draw call differ.
      const bindBackground = (buffer: WebGLBuffer | null) => {
        if (!bg) return
        gl.useProgram(bg.prog)
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
        gl.enableVertexAttribArray(bg.pos)
        gl.vertexAttribPointer(bg.pos, 2, gl.FLOAT, false, 0, 0)
        gl.uniform1f(bg.time, bgTime)
        gl.uniform2f(bg.origin, cam.x * dpr, canvas.height - cam.y * dpr)
        gl.uniform1f(bg.zoom, cam.z)
        gl.uniform1f(bg.dpr, dpr)
      }

      // 1. Draw the background quad
      if (bg) {
        bindBackground(res.bgBuf)
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
        gl.disableVertexAttribArray(bg.pos)
      }

      // 2. Draw edge quads with SDF chevrons
      if (edge) {
        // One upload-and-draw for every edge batch: the ordinary edges and
        // both highlight passes differ only in vertex data and intensity.
        const drawEdgeBatch = (vertexCount: number, intensity: number, brightness: number) => {
          if (vertexCount === 0) return
          gl.useProgram(edge.prog)
          gl.bindBuffer(gl.ARRAY_BUFFER, res.edgeBuf)
          gl.bufferData(gl.ARRAY_BUFFER, edgeVerts.subarray(0, vertexCount * FLOATS_PER_VERTEX), gl.DYNAMIC_DRAW)

          const stride = FLOATS_PER_VERTEX * 4 // 16 bytes
          gl.enableVertexAttribArray(edge.pos)
          gl.vertexAttribPointer(edge.pos, 2, gl.FLOAT, false, stride, 0)
          gl.enableVertexAttribArray(edge.uv)
          gl.vertexAttribPointer(edge.uv, 2, gl.FLOAT, false, stride, 8)

          gl.uniform2f(edge.pan, cam.x, cam.y)
          gl.uniform1f(edge.zoom, cam.z)
          gl.uniform2f(edge.res, cssWidth, cssHeight)
          gl.uniform1f(edge.time, edgeTime)
          gl.uniform1f(edge.bgTime, bgTime)
          gl.uniform2f(edge.bgOrigin, cam.x * dpr, canvas.height - cam.y * dpr)
          gl.uniform1f(edge.dpr, dpr)
          gl.uniform1f(edge.intensity, intensity)
          gl.uniform1f(edge.brightness, brightness)

          gl.drawArrays(gl.TRIANGLES, 0, vertexCount)
          gl.disableVertexAttribArray(edge.pos)
          gl.disableVertexAttribArray(edge.uv)
        }

        const edges = edgesRef.current
        if (edges.length > 0) {
          // Build id → position lookup
          const posMap = new Map<string, { x: number; y: number }>()
          for (const e of edges) {
            posMap.set(e.id, { x: e.x, y: e.y })
          }

          // Grow buffer if needed
          const needed = edges.length * FLOATS_PER_EDGE
          if (edgeVerts.length < needed) {
            edgeVerts = new Float32Array(needed)
          }

          // Scale width only — UVs stay constant so pattern doesn't shift during zoom
          const hw = 8 * Math.pow(1 / cam.z, ZOOM_WIDTH_EXP)
          const tileSize = 2 * hw // keep tiles square so the 1:1 texture isn't stretched

          // Emit one parent→child quad into edgeVerts, returning the new offset.
          const emitQuad = (offset: number, px: number, py: number, cx: number, cy: number): number => {
            const dx = cx - px
            const dy = cy - py
            const len = Math.sqrt(dx * dx + dy * dy)
            if (len === 0) return offset
            // Perpendicular normal
            const nx = -dy / len
            const ny = dx / len
            const vLen = len / tileSize // texture tiles along length
            // 4 corners: parent side (v=0), child side (v=vLen)
            const v0x = px + nx * hw; const v0y = py + ny * hw
            const v1x = px - nx * hw; const v1y = py - ny * hw
            const v2x = cx + nx * hw; const v2y = cy + ny * hw
            const v3x = cx - nx * hw; const v3y = cy - ny * hw
            // Triangle 1: v0, v1, v2  (x, y, u, v)
            edgeVerts[offset++] = v0x; edgeVerts[offset++] = v0y
            edgeVerts[offset++] = 0;   edgeVerts[offset++] = 0
            edgeVerts[offset++] = v1x; edgeVerts[offset++] = v1y
            edgeVerts[offset++] = 1;   edgeVerts[offset++] = 0
            edgeVerts[offset++] = v2x; edgeVerts[offset++] = v2y
            edgeVerts[offset++] = 0;   edgeVerts[offset++] = vLen
            // Triangle 2: v1, v3, v2
            edgeVerts[offset++] = v1x; edgeVerts[offset++] = v1y
            edgeVerts[offset++] = 1;   edgeVerts[offset++] = 0
            edgeVerts[offset++] = v3x; edgeVerts[offset++] = v3y
            edgeVerts[offset++] = 1;   edgeVerts[offset++] = vLen
            edgeVerts[offset++] = v2x; edgeVerts[offset++] = v2y
            edgeVerts[offset++] = 0;   edgeVerts[offset++] = vLen
            return offset
          }

          // Resolve a node's parent position; 'root' sits at the world origin.
          const parentPosOf = (parentId: NodeId): { x: number; y: number } | null =>
            parentId === 'root' ? { x: 0, y: 0 } : posMap.get(parentId) ?? null

          // An edge inherits the brightness of the child subtree it leads to.
          // Draw each age band separately so the shader can apply that value
          // consistently across every edge theme without changing its vertex
          // format or its hit-testing geometry.
          for (const brightness of [1, 0.6, 0.4, 0.2]) {
            let offset = 0
            for (const node of edges) {
              if (node.brightness !== brightness) continue
              const parentPos = parentPosOf(node.parentId)
              if (!parentPos) continue
              offset = emitQuad(offset, parentPos.x, parentPos.y, node.x, node.y)
            }
            drawEdgeBatch(offset / FLOATS_PER_VERTEX, 1.0, brightness)
          }

          // 2b. Highlight edges:
          //     - Node selected → boosted chevrons on its parent edge
          //     - Reparent preview → boosted chevrons on the pending edge
          const sel = selectionRef.current
          const childNode = sel ? edges.find(e => e.id === sel) : undefined
          const selParent = childNode ? parentPosOf(childNode.parentId) : null
          if (childNode && selParent) {
            const end = emitQuad(0, selParent.x, selParent.y, childNode.x, childNode.y)
            drawEdgeBatch(end / FLOATS_PER_VERTEX, HIGHLIGHT_INTENSITY, childNode.brightness)
          }

          const rEdge = reparentEdgeRef.current
          if (rEdge) {
            const end = emitQuad(0, rEdge.fromX, rEdge.fromY, rEdge.toX, rEdge.toY)
            drawEdgeBatch(end / FLOATS_PER_VERTEX, HIGHLIGHT_INTENSITY, 1.0)
          }
        }
      }

      // 3. Paint over edges behind transparent cards using the background shader.
      //    The bg fragment shader uses gl_FragCoord, so quads at any position
      //    produce seamless background — effectively erasing the edges underneath.
      //    Empty when the theme's chrome is opaque, or when no card is on screen.
      if (bg) {
        const rects = maskRects
        if (rects.length > 0) {
          const needed = rects.length * 12 // 6 verts × 2 floats
          if (maskVerts.length < needed) {
            maskVerts = new Float32Array(needed)
          }

          let mOffset = 0
          const w = cssWidth
          const h = cssHeight

          for (const rect of rects) {
            // World → screen → NDC  (same transform as edge vertex shader)
            const sl = (rect.x - rect.width / 2) * cam.z + cam.x
            const sr = (rect.x + rect.width / 2) * cam.z + cam.x
            const st = (rect.y - rect.height / 2) * cam.z + cam.y
            const sb = (rect.y + rect.height / 2) * cam.z + cam.y

            const nl = 2 * sl / w - 1
            const nr = 2 * sr / w - 1
            const nt = 1 - 2 * st / h
            const nb = 1 - 2 * sb / h

            // Triangle 1: TL, BL, TR
            maskVerts[mOffset++] = nl; maskVerts[mOffset++] = nt
            maskVerts[mOffset++] = nl; maskVerts[mOffset++] = nb
            maskVerts[mOffset++] = nr; maskVerts[mOffset++] = nt
            // Triangle 2: BL, BR, TR
            maskVerts[mOffset++] = nl; maskVerts[mOffset++] = nb
            maskVerts[mOffset++] = nr; maskVerts[mOffset++] = nb
            maskVerts[mOffset++] = nr; maskVerts[mOffset++] = nt
          }

          bindBackground(res.maskBuf)
          gl.bufferData(gl.ARRAY_BUFFER, maskVerts.subarray(0, mOffset), gl.DYNAMIC_DRAW)
          gl.drawArrays(gl.TRIANGLES, 0, mOffset / 2)
          gl.disableVertexAttribArray(bg.pos)
        }
      }

      rafRef.current = requestAnimationFrame(tick)
    }

    // A frame composited before the window went away is not there when it comes
    // back, and the gate would otherwise skip the first frame back as "nothing
    // changed".
    const startLoop = () => {
      if (rafRef.current) return
      gate.invalidate()
      // However long the window was away is not information about when the next
      // frame is wanted, and the first one back is the one that must not wait.
      limiter.reset()
      rafRef.current = requestAnimationFrame(tick)
    }
    const stopLoop = () => { if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = 0 } }

    // Hidden, minimised, or occluded — see `useWindowVisible` for why occlusion
    // is the case this must not miss.
    const unsubVisibility = onWindowVisibleChange((visible) => {
      if (visible) startLoop(); else stopLoop()
    })

    if (isWindowVisible()) startLoop()

    /**
     * A context is lost when the driver resets, when the GPU process restarts,
     * or when Chromium reclaims the least recently created one — and every
     * program and buffer id in `resources` dies with it. `preventDefault` is
     * what makes the loss recoverable at all: without it the browser never
     * fires `webglcontextrestored`, and the canvas stays empty until the app is
     * reloaded.
     */
    const onContextLost = (event: Event) => {
      event.preventDefault()
      window.api.log('[CanvasBackground] GL context lost; waiting for restore')
      stopLoop()
      resources = null
    }

    const onContextRestored = () => {
      window.api.log('[CanvasBackground] GL context restored; rebuilding programs')
      resources = createResources()
      if (isWindowVisible()) startLoop()
    }

    canvas.addEventListener('webglcontextlost', onContextLost)
    canvas.addEventListener('webglcontextrestored', onContextRestored)

    return () => {
      stopLoop()
      unsubVisibility()
      canvas.removeEventListener('webglcontextlost', onContextLost)
      canvas.removeEventListener('webglcontextrestored', onContextRestored)
      observer.disconnect()
      if (resources) destroyResources(resources)
    }
  }, [])

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        pointerEvents: 'none',
      }}
    />
  )
}
