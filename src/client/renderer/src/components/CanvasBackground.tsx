import { useEffect, useRef } from 'react'
import type { Camera } from '../lib/camera'

export interface TreeLineNode {
  id: string
  parentId: string
  x: number
  y: number
}

export interface MaskRect {
  x: number // center x (world space)
  y: number // center y (world space)
  width: number
  height: number
}

interface CanvasBackgroundProps {
  camera: Camera
  cameraRef: React.RefObject<Camera>
  edgesRef: React.RefObject<TreeLineNode[]>
  maskRectsRef: React.RefObject<MaskRect[]>
  edgesEnabled: boolean
  shadersEnabled: boolean
}

// --- Background shaders ---

const BG_VERT_SRC = `
attribute vec2 a_position;
void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`

const BG_FRAG_SRC = `
// Based on shader by Trisomie21 — https://www.shadertoy.com/view/lsf3RH

precision highp float;
uniform float iTime;
uniform vec2 uOrigin;
uniform float uZoom;

const float PI = 3.14159265358979;

// OKLab → linear sRGB
vec3 oklab2rgb(vec3 lab) {
    float l_ = lab.x + 0.3963377774 * lab.y + 0.2158037573 * lab.z;
    float m_ = lab.x - 0.1055613458 * lab.y - 0.0638541728 * lab.z;
    float s_ = lab.x - 0.0894841775 * lab.y - 1.2914855480 * lab.z;
    float l = l_*l_*l_;
    float m = m_*m_*m_;
    float s = s_*s_*s_;
    return vec3(
        +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
        -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
        -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s
    );
}

// OKLCH → linear sRGB (hue in radians)
vec3 oklch2rgb(float L, float C, float h) {
    return oklab2rgb(vec3(L, C * cos(h), C * sin(h)));
}

float snoise(vec3 uv, float res)
{
    const vec3 s = vec3(1e0, 1e2, 1e3);

    uv *= res;

    vec3 uv0 = floor(mod(uv, res))*s;
    vec3 uv1 = floor(mod(uv+vec3(1.), res))*s;

    vec3 f = fract(uv); f = f*f*(3.0-2.0*f);

    vec4 v = vec4(uv0.x+uv0.y+uv0.z, uv1.x+uv0.y+uv0.z,
                    uv0.x+uv1.y+uv0.z, uv1.x+uv1.y+uv0.z);

    vec4 r = fract(sin(v*1e-1)*1e3);
    float r0 = mix(mix(r.x, r.y, f.x), mix(r.z, r.w, f.x), f.y);

    r = fract(sin((v + uv1.z - uv0.z)*1e-1)*1e3);
    float r1 = mix(mix(r.x, r.y, f.x), mix(r.z, r.w, f.x), f.y);

    return mix(r0, r1, f.z)*2.-1.;
}

void mainImage( out vec4 fragColor, in vec2 fragCoord )
{
    vec2 canvasOffset = (fragCoord.xy - uOrigin) / uZoom;
    float r = length(canvasOffset);
    float theta = atan(canvasOffset.y, canvasOffset.x);

    // Log compression: ~4000 canvas-pixels maps to ~0.4 in shader-space
    float logR = log(1.0 + r / 100.0) * 0.108;
    vec2 p = vec2(cos(theta), sin(theta)) * logR;

    // Expand radial reach by 3x — divide distance so falloff is gentler
    float d = length(p) / 3.0;
    float color = 3.0 - (3. * d * 2.4);

    vec3 coord = vec3(atan(p.x,p.y)/6.2832+.5, d*.4, .5);

    for(int i = 1; i <= 7; i++)
    {
        float power = pow(2.0, float(i));
        color += (1.5 / power) * snoise(coord + vec3(0.,iTime*.05/9., -iTime*.01/9.), power*16.);
    }
    float c = max(color, 0.0);

    // Luminance curve — raised floor so edge colors (purple) survive
    float lum = smoothstep(0.0, 0.5, c) * 0.4
              + smoothstep(0.5, 1.5, c) * 0.3
              + smoothstep(1.5, 2.5, c) * 0.3;
    float base = 0.15 + lum * 0.85;

    // Radial rainbow — hue from angle, OKLCH for perceptual uniformity
    // Remap: 0° at north (top), increasing clockwise
    float hue = PI*8.0/12.0 - theta;
    vec3 tint = max(oklch2rgb(0.65, 0.15, hue), 0.0);
    vec3 rgb = tint * base;
    fragColor = vec4(rgb * 0.5, 1.0);
}

void main() {
    mainImage(gl_FragColor, gl_FragCoord.xy);
}
`

// --- Edge shaders ---

const EDGE_VERT_SRC = `
attribute vec2 a_position;
attribute vec2 a_uv;
uniform vec2 uPan;
uniform float uZoom;
uniform vec2 uResolution;
uniform float uTime;
varying vec2 vUV;

void main() {
  vec2 screen = a_position * uZoom + uPan;
  float ndcX = 2.0 * screen.x / uResolution.x - 1.0;
  float ndcY = 1.0 - 2.0 * screen.y / uResolution.y;
  gl_Position = vec4(ndcX, ndcY, 0.0, 1.0);
  vUV = vec2(a_uv.x, a_uv.y + uTime);
}
`

const EDGE_FRAG_SRC = `
precision mediump float;
varying vec2 vUV;
uniform sampler2D uTexture;
void main() {
  gl_FragColor = texture2D(uTexture, vec2(vUV.x, fract(vUV.y)));
}
`

function compileShader(gl: WebGLRenderingContext, type: number, src: string): WebGLShader | null {
  const s = gl.createShader(type)
  if (!s) return null
  gl.shaderSource(s, src)
  gl.compileShader(s)
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    gl.deleteShader(s)
    return null
  }
  return s
}

function createProgram(gl: WebGLRenderingContext, vertSrc: string, fragSrc: string): WebGLProgram | null {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vertSrc)
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fragSrc)
  if (!vs || !fs) return null

  const prog = gl.createProgram()!
  gl.attachShader(prog, vs)
  gl.attachShader(prog, fs)
  gl.linkProgram(prog)
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    gl.deleteProgram(prog)
    gl.deleteShader(vs)
    gl.deleteShader(fs)
    return null
  }
  return prog
}

function createChevronTexture(gl: WebGLRenderingContext): WebGLTexture | null {
  const size = 20
  const offscreen = document.createElement('canvas')
  offscreen.width = size
  offscreen.height = size
  const ctx = offscreen.getContext('2d')
  if (!ctx) return null

  // Chevron pointing up — apex near top, arms extending down-left and down-right
  ctx.strokeStyle = '#000000'
  ctx.lineWidth = 3
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.beginPath()
  ctx.moveTo(3, 16)
  ctx.lineTo(10, 4)
  ctx.lineTo(17, 16)
  ctx.stroke()

  const tex = gl.createTexture()
  if (!tex) return null
  gl.bindTexture(gl.TEXTURE_2D, tex)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, offscreen)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)

  return tex
}

const BASE_HALF_WIDTH = 10
const BASE_TILE_SIZE = 40 // world units per texture repeat
const FLOATS_PER_VERTEX = 4 // x, y, u, v
const VERTS_PER_EDGE = 6
const FLOATS_PER_EDGE = VERTS_PER_EDGE * FLOATS_PER_VERTEX // 24
// Zoom exponent: (1/z)^0.7 gives ~5x at z=0.1, 1x at z=1.0
const ZOOM_WIDTH_EXP = Math.log(5) / Math.log(10) // ≈ 0.699

export function CanvasBackground({ cameraRef, edgesRef, maskRectsRef, edgesEnabled, shadersEnabled }: CanvasBackgroundProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rafRef = useRef<number>(0)
  const shadersEnabledRef = useRef(shadersEnabled)
  shadersEnabledRef.current = shadersEnabled
  const edgesEnabledRef = useRef(edgesEnabled)
  edgesEnabledRef.current = edgesEnabled

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const dpr = 1 // Cap at 1 — effect is very dim, no need for retina

    const gl = canvas.getContext('webgl', {
      alpha: true,
      premultipliedAlpha: false,
      antialias: false,
    })
    if (!gl) return

    // --- Background program ---
    const bgProg = createProgram(gl, BG_VERT_SRC, BG_FRAG_SRC)

    let bgBuf: WebGLBuffer | null = null
    let bgPosLoc = -1
    let bgTimeLoc: WebGLUniformLocation | null = null
    let bgOriginLoc: WebGLUniformLocation | null = null
    let bgZoomLoc: WebGLUniformLocation | null = null

    if (bgProg) {
      bgBuf = gl.createBuffer()
      gl.bindBuffer(gl.ARRAY_BUFFER, bgBuf)
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)
      bgPosLoc = gl.getAttribLocation(bgProg, 'a_position')
      bgTimeLoc = gl.getUniformLocation(bgProg, 'iTime')
      bgOriginLoc = gl.getUniformLocation(bgProg, 'uOrigin')
      bgZoomLoc = gl.getUniformLocation(bgProg, 'uZoom')
    }

    // --- Edge program ---
    const edgeProg = createProgram(gl, EDGE_VERT_SRC, EDGE_FRAG_SRC)

    let edgeBuf: WebGLBuffer | null = null
    let edgePosLoc = -1
    let edgeUVLoc = -1
    let edgePanLoc: WebGLUniformLocation | null = null
    let edgeZoomLoc: WebGLUniformLocation | null = null
    let edgeResLoc: WebGLUniformLocation | null = null
    let edgeTimeLoc: WebGLUniformLocation | null = null
    let edgeTexLoc: WebGLUniformLocation | null = null
    let chevronTex: WebGLTexture | null = null

    if (edgeProg) {
      edgeBuf = gl.createBuffer()
      edgePosLoc = gl.getAttribLocation(edgeProg, 'a_position')
      edgeUVLoc = gl.getAttribLocation(edgeProg, 'a_uv')
      edgePanLoc = gl.getUniformLocation(edgeProg, 'uPan')
      edgeZoomLoc = gl.getUniformLocation(edgeProg, 'uZoom')
      edgeResLoc = gl.getUniformLocation(edgeProg, 'uResolution')
      edgeTimeLoc = gl.getUniformLocation(edgeProg, 'uTime')
      edgeTexLoc = gl.getUniformLocation(edgeProg, 'uTexture')
      chevronTex = createChevronTexture(gl)
    }

    // --- Mask buffer (reuses background program to paint over edges behind transparent cards) ---
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

      // 1. Draw background quad
      if (shadersEnabledRef.current && bgProg && bgBuf) {
        gl.useProgram(bgProg)
        gl.bindBuffer(gl.ARRAY_BUFFER, bgBuf)
        gl.enableVertexAttribArray(bgPosLoc)
        gl.vertexAttribPointer(bgPosLoc, 2, gl.FLOAT, false, 0, 0)
        gl.uniform1f(bgTimeLoc, (now - bgT0) / 3333)
        gl.uniform2f(bgOriginLoc, cam.x * dpr, canvas.height - cam.y * dpr)
        gl.uniform1f(bgZoomLoc, cam.z)
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
        gl.disableVertexAttribArray(bgPosLoc)
      }

      // 2. Draw edge quads with chevron texture
      if (edgesEnabledRef.current && edgeProg && edgeBuf && chevronTex) {
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
          const hw = BASE_HALF_WIDTH * Math.pow(1 / cam.z, ZOOM_WIDTH_EXP)
          // Below 20% zoom, start stretching tiles to avoid moiré
          const tileSize = cam.z >= 0.2 ? BASE_TILE_SIZE : BASE_TILE_SIZE * (0.2 / cam.z)

          let vertexCount = 0
          let offset = 0

          for (const node of edges) {
            let parentPos: { x: number; y: number }
            if (node.parentId === 'root') {
              parentPos = { x: 0, y: 0 }
            } else {
              const pp = posMap.get(node.parentId)
              if (!pp) continue
              parentPos = pp
            }

            const dx = node.x - parentPos.x
            const dy = node.y - parentPos.y
            const len = Math.sqrt(dx * dx + dy * dy)
            if (len === 0) continue

            // Perpendicular normal
            const nx = -dy / len
            const ny = dx / len
            const vLen = len / tileSize // texture tiles along length

            // 4 corners: parent side (v=0), child side (v=vLen)
            const v0x = parentPos.x + nx * hw
            const v0y = parentPos.y + ny * hw
            const v1x = parentPos.x - nx * hw
            const v1y = parentPos.y - ny * hw
            const v2x = node.x + nx * hw
            const v2y = node.y + ny * hw
            const v3x = node.x - nx * hw
            const v3y = node.y - ny * hw

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

            vertexCount += 6
          }

          if (vertexCount > 0) {
            gl.useProgram(edgeProg)
            gl.bindBuffer(gl.ARRAY_BUFFER, edgeBuf)
            gl.bufferData(gl.ARRAY_BUFFER, edgeVerts.subarray(0, vertexCount * FLOATS_PER_VERTEX), gl.DYNAMIC_DRAW)

            const stride = FLOATS_PER_VERTEX * 4 // 16 bytes
            gl.enableVertexAttribArray(edgePosLoc)
            gl.vertexAttribPointer(edgePosLoc, 2, gl.FLOAT, false, stride, 0)
            gl.enableVertexAttribArray(edgeUVLoc)
            gl.vertexAttribPointer(edgeUVLoc, 2, gl.FLOAT, false, stride, 8)

            gl.activeTexture(gl.TEXTURE0)
            gl.bindTexture(gl.TEXTURE_2D, chevronTex)
            gl.uniform1i(edgeTexLoc, 0)

            gl.uniform2f(edgePanLoc, cam.x, cam.y)
            gl.uniform1f(edgeZoomLoc, cam.z)
            gl.uniform2f(edgeResLoc, canvas.width, canvas.height)
            gl.uniform1f(edgeTimeLoc, (now - edgeT0) / 2000)

            gl.drawArrays(gl.TRIANGLES, 0, vertexCount)
            gl.disableVertexAttribArray(edgePosLoc)
            gl.disableVertexAttribArray(edgeUVLoc)
          }
        }
      }

      // 3. Paint over edges behind transparent cards using the background shader
      //    The bg fragment shader uses gl_FragCoord, so quads at any position
      //    produce seamless background — effectively erasing the edges underneath.
      if (shadersEnabledRef.current && edgesEnabledRef.current && bgProg && maskBuf) {
        const rects = maskRectsRef.current
        if (rects.length > 0) {
          const needed = rects.length * 12 // 6 verts × 2 floats
          if (maskVerts.length < needed) {
            maskVerts = new Float32Array(needed)
          }

          let mOffset = 0
          const w = canvas.width
          const h = canvas.height

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

          gl.useProgram(bgProg)
          gl.bindBuffer(gl.ARRAY_BUFFER, maskBuf)
          gl.bufferData(gl.ARRAY_BUFFER, maskVerts.subarray(0, mOffset), gl.DYNAMIC_DRAW)
          gl.enableVertexAttribArray(bgPosLoc)
          gl.vertexAttribPointer(bgPosLoc, 2, gl.FLOAT, false, 0, 0)
          gl.uniform1f(bgTimeLoc, (now - bgT0) / 3333)
          gl.uniform2f(bgOriginLoc, cam.x * dpr, canvas.height - cam.y * dpr)
          gl.uniform1f(bgZoomLoc, cam.z)
          gl.drawArrays(gl.TRIANGLES, 0, mOffset / 2)
          gl.disableVertexAttribArray(bgPosLoc)
        }
      }

      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      observer.disconnect()
      if (bgProg) gl.deleteProgram(bgProg)
      if (bgBuf) gl.deleteBuffer(bgBuf)
      if (edgeProg) gl.deleteProgram(edgeProg)
      if (edgeBuf) gl.deleteBuffer(edgeBuf)
      if (chevronTex) gl.deleteTexture(chevronTex)
      if (maskBuf) gl.deleteBuffer(maskBuf)
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
