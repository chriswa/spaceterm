import { useEffect, useRef } from 'react'
import type { Camera } from '../lib/camera'
import { isWindowVisible } from '../hooks/useWindowVisible'
import type { NodeId } from '../../../../shared/ids'
import { useThemeStore } from '../stores/themeStore'
import { resolveFacets } from '../lib/theme/themes'
import type { BackgroundFacet, EdgeFacet } from '../lib/theme/facets'
import { BG_VERT_SRC, EDGE_VERT_SRC } from '../lib/theme/shaders'

export interface TreeLineNode {
  id: NodeId
  parentId: NodeId
  x: number
  y: number
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
    dpr: gl.getUniformLocation(prog, 'uDpr'),
  }
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
function makeStageCache<F extends { id: string }, S>(build: (facet: F) => S | null) {
  const cache = new Map<string, S | null>()
  return {
    get(facet: F): S | null {
      if (!cache.has(facet.id)) cache.set(facet.id, build(facet))
      return cache.get(facet.id)!
    },
    values: (): (S | null)[] => [...cache.values()],
  }
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

    const dpr = window.devicePixelRatio

    const gl = canvas.getContext('webgl', {
      alpha: true,
      premultipliedAlpha: false,
      antialias: false,
    })
    if (!gl) return

    gl.getExtension('OES_standard_derivatives') // required for fwidth() in edge SDF

    // Compiled lazily and kept: switching themes back and forth must not
    // recompile, and a shader the user never selects must never cost anything.
    const bgCache = makeStageCache<BackgroundFacet, BgStage>((f) => buildBgStage(gl, f.frag))
    // An edge facet may bring its own vertex shader; most take the animated default.
    const edgeCache = makeStageCache<EdgeFacet, EdgeStage>(
      (f) => buildEdgeStage(gl, f.frag, f.vert ?? EDGE_VERT_SRC),
    )

    const bgBuf = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, bgBuf)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)

    const edgeBuf = gl.createBuffer()

    // --- Mask buffer (reuses the background program to paint over edges behind transparent cards) ---
    const maskBuf = gl.createBuffer()
    let maskVerts = new Float32Array(64 * 12) // 6 verts × 2 floats per rect

    // Reusable vertex array for edges — grows as needed
    let edgeVerts = new Float32Array(64 * FLOATS_PER_EDGE)

    gl.enable(gl.BLEND)
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)

    const bgT0 = performance.now() - (Math.random() * 2_000_000 - 1_000_000)
    const edgeT0 = performance.now()

    // Handle resize
    const resize = () => {
      const w = Math.round(canvas.clientWidth * dpr)
      const h = Math.round(canvas.clientHeight * dpr)
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w
        canvas.height = h
      }
    }

    const observer = new ResizeObserver(resize)
    observer.observe(canvas)
    resize()

    const tick = (now: number) => {
      resize()

      const cam = cameraRef.current
      gl.viewport(0, 0, canvas.width, canvas.height)
      gl.clearColor(0, 0, 0, 0)
      gl.clear(gl.COLOR_BUFFER_BIT)

      const bgTime = (now - bgT0) / 1666
      const facets = resolveFacets(themeIdRef.current)
      const bg = bgCache.get(facets.background)
      const edge = edgeCache.get(facets.edges)

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
        bindBackground(bgBuf)
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
        gl.disableVertexAttribArray(bg.pos)
      }

      // 2. Draw edge quads with SDF chevrons
      if (edge) {
        // One upload-and-draw for every edge batch: the ordinary edges and
        // both highlight passes differ only in vertex data and intensity.
        const drawEdgeBatch = (vertexCount: number, intensity: number) => {
          if (vertexCount === 0) return
          gl.useProgram(edge.prog)
          gl.bindBuffer(gl.ARRAY_BUFFER, edgeBuf)
          gl.bufferData(gl.ARRAY_BUFFER, edgeVerts.subarray(0, vertexCount * FLOATS_PER_VERTEX), gl.DYNAMIC_DRAW)

          const stride = FLOATS_PER_VERTEX * 4 // 16 bytes
          gl.enableVertexAttribArray(edge.pos)
          gl.vertexAttribPointer(edge.pos, 2, gl.FLOAT, false, stride, 0)
          gl.enableVertexAttribArray(edge.uv)
          gl.vertexAttribPointer(edge.uv, 2, gl.FLOAT, false, stride, 8)

          gl.uniform2f(edge.pan, cam.x, cam.y)
          gl.uniform1f(edge.zoom, cam.z)
          gl.uniform2f(edge.res, canvas.clientWidth, canvas.clientHeight)
          gl.uniform1f(edge.time, (now - edgeT0) / 2000)
          gl.uniform1f(edge.bgTime, bgTime)
          gl.uniform2f(edge.bgOrigin, cam.x * dpr, canvas.height - cam.y * dpr)
          gl.uniform1f(edge.dpr, dpr)
          gl.uniform1f(edge.intensity, intensity)

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

          let offset = 0
          for (const node of edges) {
            const parentPos = parentPosOf(node.parentId)
            if (!parentPos) continue
            offset = emitQuad(offset, parentPos.x, parentPos.y, node.x, node.y)
          }
          drawEdgeBatch(offset / FLOATS_PER_VERTEX, 1.0)

          // 2b. Highlight edges:
          //     - Node selected → boosted chevrons on its parent edge
          //     - Reparent preview → boosted chevrons on the pending edge
          const sel = selectionRef.current
          const childNode = sel ? edges.find(e => e.id === sel) : undefined
          const selParent = childNode ? parentPosOf(childNode.parentId) : null
          if (childNode && selParent) {
            const end = emitQuad(0, selParent.x, selParent.y, childNode.x, childNode.y)
            drawEdgeBatch(end / FLOATS_PER_VERTEX, HIGHLIGHT_INTENSITY)
          }

          const rEdge = reparentEdgeRef.current
          if (rEdge) {
            const end = emitQuad(0, rEdge.fromX, rEdge.fromY, rEdge.toX, rEdge.toY)
            drawEdgeBatch(end / FLOATS_PER_VERTEX, HIGHLIGHT_INTENSITY)
          }
        }
      }

      // 3. Paint over edges behind transparent cards using the background shader.
      //    The bg fragment shader uses gl_FragCoord, so quads at any position
      //    produce seamless background — effectively erasing the edges underneath.
      if (bg) {
        const rects = maskRectsRef.current
        if (rects.length > 0) {
          const needed = rects.length * 12 // 6 verts × 2 floats
          if (maskVerts.length < needed) {
            maskVerts = new Float32Array(needed)
          }

          let mOffset = 0
          const w = canvas.clientWidth
          const h = canvas.clientHeight

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

          bindBackground(maskBuf)
          gl.bufferData(gl.ARRAY_BUFFER, maskVerts.subarray(0, mOffset), gl.DYNAMIC_DRAW)
          gl.drawArrays(gl.TRIANGLES, 0, mOffset / 2)
          gl.disableVertexAttribArray(bg.pos)
        }
      }

      rafRef.current = requestAnimationFrame(tick)
    }

    const startLoop = () => { if (!rafRef.current) rafRef.current = requestAnimationFrame(tick) }
    const stopLoop = () => { if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = 0 } }

    // Subscribe to visibility changes
    const unsubVisibility = window.api.window.onVisibilityChanged((visible) => {
      if (visible) startLoop(); else stopLoop()
    })

    if (isWindowVisible()) startLoop()

    return () => {
      stopLoop()
      unsubVisibility()
      observer.disconnect()
      for (const stage of [...bgCache.values(), ...edgeCache.values()]) {
        if (stage) gl.deleteProgram(stage.prog)
      }
      gl.deleteBuffer(bgBuf)
      gl.deleteBuffer(edgeBuf)
      gl.deleteBuffer(maskBuf)
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
