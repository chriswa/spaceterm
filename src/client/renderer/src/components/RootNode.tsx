import { useCallback, useEffect, useRef } from 'react'
import { ROOT_NODE_RADIUS } from '../lib/constants'
import type { ArchivedNode } from '../../../../shared/state'
import { CardShell } from './CardShell'
import { useShaderStore } from '../stores/shaderStore'

const noop = () => {}

interface RootNodeProps {
  focused: boolean
  onClick: () => void
  archivedChildren: ArchivedNode[]
  onUnarchive: (parentNodeId: string, archivedNodeId: string) => void
  onArchiveDelete: (parentNodeId: string, archivedNodeId: string) => void
  onArchiveToggled: (nodeId: string, open: boolean) => void
}

/** How much bigger the shader canvas is than the node hit-area */
const CANVAS_SCALE = 1.0

/* ------------------------------------------------------------------ */
/*  WebGL shaders                                                      */
/* ------------------------------------------------------------------ */

const VERT_SRC = `
attribute vec2 a_position;
void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`

const FRAG_SRC = `
// Shader by Trisomie21 — https://www.shadertoy.com/view/lsf3RH

precision highp float;
uniform vec2 iResolution;
uniform float iTime;
uniform float uFocused;

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

const float shrink = 1.2;

void mainImage( out vec4 fragColor, in vec2 fragCoord )
{
    vec2 p = -.5 + fragCoord.xy / iResolution.xy;
    p.x *= iResolution.x/iResolution.y;

    float color = 3.0 - (3.*length(2.*p*shrink));

    vec3 coord = vec3(atan(p.x,p.y)/6.2832+.5, length(p*shrink)*.4, .5);

    for(int i = 1; i <= 7; i++)
    {
        float power = pow(2.0, float(i));
        color += (1.5 / power) * snoise(coord + vec3(0.,iTime*.05, -iTime*.01), power*16.);
    }
    float c = max(color, 0.0);

    // Shared base curve
    float lum = smoothstep(0.0, 0.5, c) * 0.4
              + smoothstep(0.5, 1.5, c) * 0.3
              + smoothstep(1.5, 2.5, c) * 0.3;
    float grey = 0.3 + lum * 0.7;
    float base = grey * grey * grey;
    float whiteBlend = smoothstep(1.5, 2.5, c);

    // Unselected: grey with black center (inverted)
    vec3 tintU = vec3(mix(0.4, 0.8, smoothstep(0.3, 1.5, c)));
    vec3 unselected = vec3(1.0) - mix(tintU * base, vec3(1.0), whiteBlend);

    // Selected: black/dark with white edges (inverted)
    vec3 tintS = vec3(mix(0.0, 0.15, smoothstep(0.3, 1.5, c)));
    vec3 selected = vec3(1.0) - mix(tintS * base, vec3(1.0), whiteBlend);

    vec3 rgb = mix(unselected, selected, uFocused);
    float alpha = mix(smoothstep(0.8, 2.0, c), smoothstep(0.4, 1.3, c), uFocused);
    fragColor = vec4(rgb, alpha);
}

void main() {
    mainImage(gl_FragColor, gl_FragCoord.xy);
}
`

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function compileShader(gl: WebGLRenderingContext, type: number, src: string): WebGLShader | null {
  const s = gl.createShader(type)
  if (!s) return null
  gl.shaderSource(s, src)
  gl.compileShader(s)
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    console.error('Shader compile error:', gl.getShaderInfoLog(s))
    gl.deleteShader(s)
    return null
  }
  return s
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export function RootNode({ focused, onClick, archivedChildren, onUnarchive, onArchiveDelete, onArchiveToggled }: RootNodeProps) {
  const size = ROOT_NODE_RADIUS * 2
  const canvasSize = size * CANVAS_SCALE
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rafRef = useRef<number>(0)
  const focusedRef = useRef(focused)
  focusedRef.current = focused
  const shadersEnabled = useShaderStore(s => s.shadersEnabled)

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      onClick()
    },
    [onClick],
  )

  useEffect(() => {
    if (!shadersEnabled) return

    const canvas = canvasRef.current
    if (!canvas) return

    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const pxW = Math.round(canvasSize * dpr)
    const pxH = Math.round(canvasSize * dpr)
    canvas.width = pxW
    canvas.height = pxH

    const gl = canvas.getContext('webgl', {
      alpha: true,
      premultipliedAlpha: false,
      antialias: false,
    })
    if (!gl) return

    const vs = compileShader(gl, gl.VERTEX_SHADER, VERT_SRC)
    const fs = compileShader(gl, gl.FRAGMENT_SHADER, FRAG_SRC)
    if (!vs || !fs) return

    const prog = gl.createProgram()!
    gl.attachShader(prog, vs)
    gl.attachShader(prog, fs)
    gl.linkProgram(prog)
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.error('Program link error:', gl.getProgramInfoLog(prog))
      return
    }
    gl.useProgram(prog)

    // Full-screen quad
    const buf = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buf)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)
    const posLoc = gl.getAttribLocation(prog, 'a_position')
    gl.enableVertexAttribArray(posLoc)
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0)

    // Uniforms
    const resLoc = gl.getUniformLocation(prog, 'iResolution')
    const timeLoc = gl.getUniformLocation(prog, 'iTime')
    const focusedLoc = gl.getUniformLocation(prog, 'uFocused')
    gl.uniform2f(resLoc, pxW, pxH)

    gl.enable(gl.BLEND)
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)

    const t0 = performance.now() - (Math.random() * 2_000_000 - 1_000_000)

    const tick = (now: number) => {
      gl.uniform1f(timeLoc, (now - t0) / 3333)
      gl.uniform1f(focusedLoc, focusedRef.current ? 1.0 : 0.0)
      gl.viewport(0, 0, pxW, pxH)
      gl.clearColor(0, 0, 0, 0)
      gl.clear(gl.COLOR_BUFFER_BIT)
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      gl.deleteProgram(prog)
      gl.deleteShader(vs)
      gl.deleteShader(fs)
      gl.deleteBuffer(buf)
    }
  }, [canvasSize, shadersEnabled])

  const orbContent = shadersEnabled ? (
    <canvas
      ref={canvasRef}
      style={{
        position: 'absolute',
        left: (size - canvasSize) / 2,
        top: (size - canvasSize) / 2,
        width: canvasSize,
        height: canvasSize,
        pointerEvents: 'none',
      }}
    />
  ) : (
    <div
      style={{
        position: 'absolute',
        left: (size - canvasSize) / 2,
        top: (size - canvasSize) / 2,
        width: canvasSize,
        height: canvasSize,
        borderRadius: '50%',
        border: `2px solid ${focused ? '#cc4400' : '#555'}`,
        background: '#1a1a1a',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        pointerEvents: 'none',
      }}
    >
      <span
        style={{
          color: focused ? '#cc4400' : '#888',
          fontSize: 32,
          fontWeight: 600,
          userSelect: 'none',
          letterSpacing: '0.05em',
        }}
      >
        root
      </span>
    </div>
  )

  return (
    <CardShell
      nodeId="root"
      x={-ROOT_NODE_RADIUS}
      y={-ROOT_NODE_RADIUS}
      width={size}
      height={size}
      zIndex={0}
      focused={focused}
      headVariant="hidden"
      showClose={false}
      showColorPicker={false}
      archivedChildren={archivedChildren}
      onClose={noop}
      onColorChange={noop}
      onUnarchive={onUnarchive}
      onArchiveDelete={onArchiveDelete}
      onArchiveToggled={onArchiveToggled}
      onMouseDown={handleMouseDown}
      className={`root-node${focused ? ' root-node--focused' : ''}`}
      style={{ background: 'transparent', border: 'none' }}
    >
      {orbContent}
    </CardShell>
  )
}
