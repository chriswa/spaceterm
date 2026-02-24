import { useEffect, useRef } from 'react'
import type { Camera } from '../lib/camera'
import { isWindowVisible } from '../hooks/useWindowVisible'

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

export interface ReparentEdge {
  fromX: number
  fromY: number
  toX: number
  toY: number
}

interface CanvasBackgroundProps {
  camera: Camera
  cameraRef: React.RefObject<Camera>
  edgesRef: React.RefObject<TreeLineNode[]>
  maskRectsRef: React.RefObject<MaskRect[]>
  selectionRef: React.RefObject<string | null>
  reparentEdgeRef: React.RefObject<ReparentEdge | null>
  goodGfx: boolean
}

// --- Background shaders ---

const BG_VERT_SRC = `
attribute vec2 a_position;
void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`

// Shared background GLSL — reused by edge shader for soft-light blending
const BG_HELPERS = `
const float PI = 3.14159265358979;

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

vec3 oklch2rgb(float L, float C, float h) {
    return oklab2rgb(vec3(L, C * cos(h), C * sin(h)));
}

float snoise(vec3 uv, float res) {
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

vec4 computeBackground(vec2 fragCoord, float bgTime, vec2 bgOrigin, float bgZoom, float lumFloor) {
    vec2 canvasOffset = (fragCoord - bgOrigin) / bgZoom;
    float r = length(canvasOffset) * 0.5;
    float theta = atan(canvasOffset.y, canvasOffset.x);
    float logR = log(1.0 + r / 100.0) * 0.16;
    vec2 p = vec2(cos(theta), sin(theta)) * logR;
    float d = length(p) / 3.0;
    float color = 3.0 - (3. * d * 2.4);
    vec3 coord = vec3(atan(p.x,p.y)/6.2832+.5, d*.4, .5);
    for(int i = 1; i <= 7; i++) {
        float power = pow(2.0, float(i));
        color += (1.5 / power) * snoise(coord + vec3(0.,bgTime*.05/9., -bgTime*.01/9.), power*16.);
    }
    float c = max(color, 0.0);
    float lum = smoothstep(0.0, 0.5, c) * 0.4
              + smoothstep(0.5, 1.5, c) * 0.3
              + smoothstep(1.5, 2.5, c) * 0.3;
    float base = max(lum, lumFloor);
    float hue = PI*8.0/12.0 - theta;
    vec3 tint = max(oklch2rgb(0.51, 0.06, hue), 0.0);
    vec3 rgb = tint * base;
    return vec4(rgb * 1.2, 1.0);
}
`

const BG_FRAG_SRC = `
// Based on shader by Trisomie21 — https://www.shadertoy.com/view/lsf3RH
precision highp float;
uniform float iTime;
uniform vec2 uOrigin;
uniform float uZoom;
${BG_HELPERS}
void main() {
    gl_FragColor = computeBackground(gl_FragCoord.xy, iTime, uOrigin, uZoom, 0.0);
}
`

// Simple 2D polar-coordinate noise shader — cheap alternative to the full 3D octave shader
const SIMPLE_BG_FRAG_SRC = `
precision highp float;
uniform float iTime;
uniform vec2 uOrigin;
uniform float uZoom;

const float PI = 3.14159265358979;

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

vec3 oklch2rgb(float L, float C, float h) {
    return oklab2rgb(vec3(L, C * cos(h), C * sin(h)));
}

float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

float noise2d(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = hash(i);
    float b = hash(i + vec2(1.0, 0.0));
    float c = hash(i + vec2(0.0, 1.0));
    float d = hash(i + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

void main() {
    vec2 canvasOffset = (gl_FragCoord.xy - uOrigin) / uZoom;
    float r = length(canvasOffset) * 0.5;
    float theta = atan(canvasOffset.y, canvasOffset.x);
    float d = log(1.0 + r / 100.0);

    // Map angle onto a circle (cos/sin) to eliminate the seam at ±π.
    // Map distance onto a circle so the pattern tiles seamlessly in log-space.
    // High angular freq + low radial freq = radial streaks.
    float aF = 24.0;
    float dPhase = d * 2.094;
    float tPhase = iTime * 0.4;

    float n = 0.5 * (
        noise2d(vec2(cos(theta) * aF + cos(tPhase) * 0.8, cos(dPhase) * 0.6 + sin(tPhase) * 0.8)) +
        noise2d(vec2(sin(theta) * aF + sin(tPhase * 0.7) * 0.8, sin(dPhase) * 0.6 + cos(tPhase * 0.7) * 0.8))
    );

    // Proximity: 1 at origin, 0 past ~100k world-space pixels
    float proximity = 1.0 - smoothstep(0.0, 100000.0, r);

    // Lift noise floor aggressively near centre (min ~0.7), let it fall to 0 far out
    float floor = proximity * 0.7;
    float lifted = floor + n * (1.0 - floor);
    float lum = smoothstep(0.05, 0.95, lifted) * 0.6;

    // Near centre: higher lightness + lower chroma = washed-out pastels
    // Far out: deeper, more saturated tint
    float hue = PI * 8.0 / 12.0 - theta;
    float L = 0.51;
    float C = 0.06;
    vec3 tint = max(oklch2rgb(L, C, hue), 0.0);
    gl_FragColor = vec4(tint * lum * 1.2, 1.0);
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
#extension GL_OES_standard_derivatives : enable
precision highp float;
varying vec2 vUV;
uniform float uBgTime;
uniform vec2 uBgOrigin;
uniform float uIntensity;
uniform float uZoom;

${BG_HELPERS}

// W3C soft-light compositing (Figma-compatible)
float softLightChannel(float backdrop, float source) {
  if (source <= 0.5) {
    return backdrop - (1.0 - 2.0 * source) * backdrop * (1.0 - backdrop);
  } else {
    float d = (backdrop <= 0.25)
      ? ((16.0 * backdrop - 12.0) * backdrop + 4.0) * backdrop
      : sqrt(backdrop);
    return backdrop + (2.0 * source - 1.0) * (d - backdrop);
  }
}

vec3 softLight(vec3 backdrop, vec3 source) {
  return vec3(
    softLightChannel(backdrop.r, source.r),
    softLightChannel(backdrop.g, source.g),
    softLightChannel(backdrop.b, source.b)
  );
}

// Distance to line segment a→b
float sdSegment(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h);
}

const vec2  APEX   = vec2(0.5, 0.125);
const vec2  BASE_L = vec2(0.15, 0.82);
const vec2  BASE_R = vec2(0.85, 0.82);
const float HALF_W = 0.06;

void main() {
  vec2 uv = vec2(vUV.x, fract(vUV.y));

  float d = min(sdSegment(uv, APEX, BASE_L), sdSegment(uv, APEX, BASE_R));
  float aa = fwidth(d) * 0.75;
  float alpha = 1.0 - smoothstep(HALF_W - aa, HALF_W + aa, d);
  if (alpha < 0.004) discard;

  vec4 bg = computeBackground(gl_FragCoord.xy, uBgTime, uBgOrigin, uZoom, 0.15);
  vec3 blended = softLight(bg.rgb, vec3(1.0));
  // uIntensity > 1 overshoots past soft-light toward brighter
  vec3 result = mix(bg.rgb, blended, alpha * uIntensity);
  gl_FragColor = vec4(result, bg.a);
}
`

// Simple edge shader — uses radial hue with a flat washed-out tint instead of computeBackground
const SIMPLE_EDGE_FRAG_SRC = `
#extension GL_OES_standard_derivatives : enable
precision highp float;
varying vec2 vUV;
uniform vec2 uBgOrigin;
uniform float uIntensity;
uniform float uZoom;

const float PI = 3.14159265358979;

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

vec3 oklch2rgb(float L, float C, float h) {
    return oklab2rgb(vec3(L, C * cos(h), C * sin(h)));
}

float sdSegment(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h);
}

const vec2  APEX   = vec2(0.5, 0.125);
const vec2  BASE_L = vec2(0.15, 0.82);
const vec2  BASE_R = vec2(0.85, 0.82);
const float HALF_W = 0.06;

void main() {
  vec2 uv = vec2(vUV.x, fract(vUV.y));

  float d = min(sdSegment(uv, APEX, BASE_L), sdSegment(uv, APEX, BASE_R));
  float aa = fwidth(d) * 0.75;
  float alpha = 1.0 - smoothstep(HALF_W - aa, HALF_W + aa, d);
  if (alpha < 0.004) discard;

  // Flat washed-out radial hue — no expensive noise
  vec2 canvasOffset = (gl_FragCoord.xy - uBgOrigin) / uZoom;
  float theta = atan(canvasOffset.y, canvasOffset.x);
  float hue = PI * 8.0 / 12.0 - theta;
  vec3 tint = max(oklch2rgb(0.65, 0.06, hue), 0.0);
  vec3 result = tint * (0.35 + 0.45 * alpha * uIntensity);
  gl_FragColor = vec4(result, 1.0);
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

const FLOATS_PER_VERTEX = 4 // x, y, u, v
const VERTS_PER_EDGE = 6
const FLOATS_PER_EDGE = VERTS_PER_EDGE * FLOATS_PER_VERTEX // 24
// Zoom exponent: (1/z)^0.7 gives ~5x at z=0.1, 1x at z=1.0
const ZOOM_WIDTH_EXP = Math.log(5) / Math.log(10) // ≈ 0.699

export function CanvasBackground({ cameraRef, edgesRef, maskRectsRef, selectionRef, reparentEdgeRef, goodGfx }: CanvasBackgroundProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rafRef = useRef<number>(0)
  const goodGfxRef = useRef(goodGfx)
  goodGfxRef.current = goodGfx

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

    // --- Background programs (full + simple) ---
    const bgProgFull = createProgram(gl, BG_VERT_SRC, BG_FRAG_SRC)
    const bgProgSimple = createProgram(gl, BG_VERT_SRC, SIMPLE_BG_FRAG_SRC)

    let bgBuf: WebGLBuffer | null = null

    // Uniform/attrib locations for each bg program
    const bgLocs = {
      full: { pos: -1, time: null as WebGLUniformLocation | null, origin: null as WebGLUniformLocation | null, zoom: null as WebGLUniformLocation | null },
      simple: { pos: -1, time: null as WebGLUniformLocation | null, origin: null as WebGLUniformLocation | null, zoom: null as WebGLUniformLocation | null },
    }

    if (bgProgFull || bgProgSimple) {
      bgBuf = gl.createBuffer()
      gl.bindBuffer(gl.ARRAY_BUFFER, bgBuf)
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)
    }
    if (bgProgFull) {
      bgLocs.full.pos = gl.getAttribLocation(bgProgFull, 'a_position')
      bgLocs.full.time = gl.getUniformLocation(bgProgFull, 'iTime')
      bgLocs.full.origin = gl.getUniformLocation(bgProgFull, 'uOrigin')
      bgLocs.full.zoom = gl.getUniformLocation(bgProgFull, 'uZoom')
    }
    if (bgProgSimple) {
      bgLocs.simple.pos = gl.getAttribLocation(bgProgSimple, 'a_position')
      bgLocs.simple.time = gl.getUniformLocation(bgProgSimple, 'iTime')
      bgLocs.simple.origin = gl.getUniformLocation(bgProgSimple, 'uOrigin')
      bgLocs.simple.zoom = gl.getUniformLocation(bgProgSimple, 'uZoom')
    }

    // --- Edge programs (full + simple) ---
    const edgeProgFull = createProgram(gl, EDGE_VERT_SRC, EDGE_FRAG_SRC)
    const edgeProgSimple = createProgram(gl, EDGE_VERT_SRC, SIMPLE_EDGE_FRAG_SRC)

    let edgeBuf: WebGLBuffer | null = null

    type EdgeLocs = {
      pos: number; uv: number
      pan: WebGLUniformLocation | null; zoom: WebGLUniformLocation | null
      res: WebGLUniformLocation | null; time: WebGLUniformLocation | null
      bgTime: WebGLUniformLocation | null; bgOrigin: WebGLUniformLocation | null
      intensity: WebGLUniformLocation | null
    }
    const initEdgeLocs = (prog: WebGLProgram): EdgeLocs => ({
      pos: gl.getAttribLocation(prog, 'a_position'),
      uv: gl.getAttribLocation(prog, 'a_uv'),
      pan: gl.getUniformLocation(prog, 'uPan'),
      zoom: gl.getUniformLocation(prog, 'uZoom'),
      res: gl.getUniformLocation(prog, 'uResolution'),
      time: gl.getUniformLocation(prog, 'uTime'),
      bgTime: gl.getUniformLocation(prog, 'uBgTime'),
      bgOrigin: gl.getUniformLocation(prog, 'uBgOrigin'),
      intensity: gl.getUniformLocation(prog, 'uIntensity'),
    })

    const nullEdgeLocs: EdgeLocs = { pos: -1, uv: -1, pan: null, zoom: null, res: null, time: null, bgTime: null, bgOrigin: null, intensity: null }
    const edgeLocsFull = edgeProgFull ? initEdgeLocs(edgeProgFull) : nullEdgeLocs
    const edgeLocsSimple = edgeProgSimple ? initEdgeLocs(edgeProgSimple) : nullEdgeLocs

    if (edgeProgFull || edgeProgSimple) {
      edgeBuf = gl.createBuffer()
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

      const bgTime = (now - bgT0) / 1666

      // 1. Draw background quad — pick full or simple shader
      const activeBgProg = goodGfxRef.current ? bgProgFull : bgProgSimple
      const activeBgLoc = goodGfxRef.current ? bgLocs.full : bgLocs.simple
      if (activeBgProg && bgBuf) {
        gl.useProgram(activeBgProg)
        gl.bindBuffer(gl.ARRAY_BUFFER, bgBuf)
        gl.enableVertexAttribArray(activeBgLoc.pos)
        gl.vertexAttribPointer(activeBgLoc.pos, 2, gl.FLOAT, false, 0, 0)
        gl.uniform1f(activeBgLoc.time, bgTime)
        gl.uniform2f(activeBgLoc.origin, cam.x * dpr, canvas.height - cam.y * dpr)
        gl.uniform1f(activeBgLoc.zoom, cam.z)
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
        gl.disableVertexAttribArray(activeBgLoc.pos)
      }

      // 2. Draw edge quads with SDF chevrons
      const activeEdgeProg = goodGfxRef.current ? edgeProgFull : edgeProgSimple
      const eL = goodGfxRef.current ? edgeLocsFull : edgeLocsSimple
      if (activeEdgeProg && edgeBuf) {
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
            gl.useProgram(activeEdgeProg)
            gl.bindBuffer(gl.ARRAY_BUFFER, edgeBuf)
            gl.bufferData(gl.ARRAY_BUFFER, edgeVerts.subarray(0, vertexCount * FLOATS_PER_VERTEX), gl.DYNAMIC_DRAW)

            const stride = FLOATS_PER_VERTEX * 4 // 16 bytes
            gl.enableVertexAttribArray(eL.pos)
            gl.vertexAttribPointer(eL.pos, 2, gl.FLOAT, false, stride, 0)
            gl.enableVertexAttribArray(eL.uv)
            gl.vertexAttribPointer(eL.uv, 2, gl.FLOAT, false, stride, 8)

            gl.uniform2f(eL.pan, cam.x, cam.y)
            gl.uniform1f(eL.zoom, cam.z)
            gl.uniform2f(eL.res, canvas.clientWidth, canvas.clientHeight)
            gl.uniform1f(eL.time, (now - edgeT0) / 2000)
            gl.uniform1f(eL.bgTime, bgTime)
            gl.uniform2f(eL.bgOrigin, cam.x * dpr, canvas.height - cam.y * dpr)
            gl.uniform1f(eL.intensity, 1.0)

            gl.drawArrays(gl.TRIANGLES, 0, vertexCount)
            gl.disableVertexAttribArray(eL.pos)
            gl.disableVertexAttribArray(eL.uv)
          }

          // 2b. Draw highlight edges:
          //     - Node selected → grey chevrons on parent edge
          //     - Reparent preview → white chevrons
          {
            // Helper to emit one quad into edgeVerts at a given offset
            const emitQuad = (offset: number, px: number, py: number, cx: number, cy: number): number => {
              const dx = cx - px
              const dy = cy - py
              const len = Math.sqrt(dx * dx + dy * dy)
              if (len === 0) return offset
              const nx = -dy / len
              const ny = dx / len
              const vLen = len / tileSize
              const v0x = px + nx * hw; const v0y = py + ny * hw
              const v1x = px - nx * hw; const v1y = py - ny * hw
              const v2x = cx + nx * hw; const v2y = cy + ny * hw
              const v3x = cx - nx * hw; const v3y = cy - ny * hw
              edgeVerts[offset++] = v0x; edgeVerts[offset++] = v0y
              edgeVerts[offset++] = 0;   edgeVerts[offset++] = 0
              edgeVerts[offset++] = v1x; edgeVerts[offset++] = v1y
              edgeVerts[offset++] = 1;   edgeVerts[offset++] = 0
              edgeVerts[offset++] = v2x; edgeVerts[offset++] = v2y
              edgeVerts[offset++] = 0;   edgeVerts[offset++] = vLen
              edgeVerts[offset++] = v1x; edgeVerts[offset++] = v1y
              edgeVerts[offset++] = 1;   edgeVerts[offset++] = 0
              edgeVerts[offset++] = v3x; edgeVerts[offset++] = v3y
              edgeVerts[offset++] = 1;   edgeVerts[offset++] = vLen
              edgeVerts[offset++] = v2x; edgeVerts[offset++] = v2y
              edgeVerts[offset++] = 0;   edgeVerts[offset++] = vLen
              return offset
            }

            const drawHighlightBatch = (intensity: number, vertexCount: number) => {
              gl.useProgram(activeEdgeProg)
              gl.bindBuffer(gl.ARRAY_BUFFER, edgeBuf)
              gl.bufferData(gl.ARRAY_BUFFER, edgeVerts.subarray(0, vertexCount * FLOATS_PER_VERTEX), gl.DYNAMIC_DRAW)

              const stride = FLOATS_PER_VERTEX * 4
              gl.enableVertexAttribArray(eL.pos)
              gl.vertexAttribPointer(eL.pos, 2, gl.FLOAT, false, stride, 0)
              gl.enableVertexAttribArray(eL.uv)
              gl.vertexAttribPointer(eL.uv, 2, gl.FLOAT, false, stride, 8)

              gl.uniform2f(eL.pan, cam.x, cam.y)
              gl.uniform1f(eL.zoom, cam.z)
              gl.uniform2f(eL.res, canvas.clientWidth, canvas.clientHeight)
              gl.uniform1f(eL.time, (now - edgeT0) / 2000)
              gl.uniform1f(eL.bgTime, bgTime)
              gl.uniform2f(eL.bgOrigin, cam.x * dpr, canvas.height - cam.y * dpr)
              gl.uniform1f(eL.intensity, intensity)

              gl.drawArrays(gl.TRIANGLES, 0, vertexCount)
              gl.disableVertexAttribArray(eL.pos)
              gl.disableVertexAttribArray(eL.uv)
            }

            // Selection → highlight parent edge with boosted soft-light
            const sel = selectionRef.current
            if (sel) {
              const childNode = edges.find(e => e.id === sel)
              if (childNode) {
                let parentPos: { x: number; y: number } | null = null
                if (childNode.parentId === 'root') {
                  parentPos = { x: 0, y: 0 }
                } else {
                  parentPos = posMap.get(childNode.parentId) ?? null
                }
                if (parentPos) {
                  const offset = emitQuad(0, parentPos.x, parentPos.y, childNode.x, childNode.y)
                  const vertCount = offset / FLOATS_PER_VERTEX
                  drawHighlightBatch(3.0, vertCount)
                }
              }
            }

            // Reparent preview edge
            const rEdge = reparentEdgeRef.current
            if (rEdge) {
              const offset = emitQuad(0, rEdge.fromX, rEdge.fromY, rEdge.toX, rEdge.toY)
              const vertCount = offset / FLOATS_PER_VERTEX
              drawHighlightBatch(3.0, vertCount)
            }
          }
        }
      }

      // 3. Paint over edges behind transparent cards using the background shader
      //    The bg fragment shader uses gl_FragCoord, so quads at any position
      //    produce seamless background — effectively erasing the edges underneath.
      if (activeBgProg && maskBuf) {
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

          gl.useProgram(activeBgProg)
          gl.bindBuffer(gl.ARRAY_BUFFER, maskBuf)
          gl.bufferData(gl.ARRAY_BUFFER, maskVerts.subarray(0, mOffset), gl.DYNAMIC_DRAW)
          gl.enableVertexAttribArray(activeBgLoc.pos)
          gl.vertexAttribPointer(activeBgLoc.pos, 2, gl.FLOAT, false, 0, 0)
          gl.uniform1f(activeBgLoc.time, bgTime)
          gl.uniform2f(activeBgLoc.origin, cam.x * dpr, canvas.height - cam.y * dpr)
          gl.uniform1f(activeBgLoc.zoom, cam.z)
          gl.drawArrays(gl.TRIANGLES, 0, mOffset / 2)
          gl.disableVertexAttribArray(activeBgLoc.pos)
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
      if (bgProgFull) gl.deleteProgram(bgProgFull)
      if (bgProgSimple) gl.deleteProgram(bgProgSimple)
      if (bgBuf) gl.deleteBuffer(bgBuf)
      if (edgeProgFull) gl.deleteProgram(edgeProgFull)
      if (edgeProgSimple) gl.deleteProgram(edgeProgSimple)
      if (edgeBuf) gl.deleteBuffer(edgeBuf)
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
