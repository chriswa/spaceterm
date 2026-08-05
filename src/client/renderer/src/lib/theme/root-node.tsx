import { useEffect, useRef } from 'react'
import { isWindowVisible, onWindowVisibleChange } from '../../hooks/useWindowVisible'

/**
 * Implementations of the `rootNode` facet.
 *
 * A facet is handed a box and told whether the canvas is focused; positioning
 * that box is `RootNode`'s job, not the facet's. That split is what lets a
 * facet be a plain `<div>` in one theme and a live WebGL canvas in another
 * without either knowing about `CardShell`'s layout.
 */
export interface RootNodeVisualProps {
  /** Width and height of the box, in CSS pixels. */
  size: number
  focused: boolean
}

/**
 * Label size as a fraction of the box, not a pixel count.
 *
 * `ROOT_NODE_RADIUS` is the one knob for how big the root node is; a facet with
 * a hard-coded font size would answer a change to it with a speck of text in a
 * large circle. The two fractions are the sizes the labels used to have at the
 * radius they were tuned at.
 */
const CENTRED_LABEL_FRACTION = 22 / 126
const RETICLE_LABEL_FRACTION = 11 / 126

/* ------------------------------------------------------------------ */
/*  Disc — a CSS circle                                                */
/* ------------------------------------------------------------------ */

/**
 * The cheap one, and the default: one filled circle, no per-frame work at all.
 */
export function DiscRootNode({ size, focused }: RootNodeVisualProps) {
  return (
    <div
      className="root-node__circle"
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        background: '#000',
        // The rim and its hover colour live in CSS; only the width scales, or
        // the outline of a label-scale disc would be a hairline.
        borderWidth: Math.max(1, size / 126),
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {focused && (
        <span
          style={{
            color: '#fff',
            fontSize: size * CENTRED_LABEL_FRACTION,
            fontWeight: 600,
            letterSpacing: '0.05em',
            userSelect: 'none',
          }}
        >
          root
        </span>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Reticle — a surveyor's mark                                        */
/* ------------------------------------------------------------------ */

/**
 * One ring on a black disc, with the label centred inside it.
 *
 * The fill is what separates the mark from the grid: the axes run *through*
 * the origin, and an open ring let them cross the label, which read as the
 * grid running over the root node rather than the node sitting on it.
 * Everything else a reticle usually has — crosshair ticks, a centre dot, a
 * second ring — was tried and removed: against a grid that is already full of
 * fine lines, more marks read as clutter rather than as precision. The ring
 * alone is enough to say "here".
 */
export function ReticleRootNode({ size, focused }: RootNodeVisualProps) {
  const stroke = focused ? '#e8edf7' : '#9aa4bd'
  return (
    <div style={{ position: 'relative', width: size, height: size }}>
      <svg
        className="root-node__reticle"
        viewBox="0 0 100 100"
        width={size}
        height={size}
        fill="none"
        stroke={stroke}
        style={{ display: 'block', transition: 'stroke 0.15s' }}
      >
        {/* r=44 leaves room for the 2-unit stroke inside the 100 viewBox. */}
        <circle cx="50" cy="50" r="44" strokeWidth="2" opacity="0.85" fill="#000" />
      </svg>
      {focused && (
        <span
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#e8edf7',
            fontSize: size * RETICLE_LABEL_FRACTION,
            fontWeight: 600,
            letterSpacing: '0.18em',
            // Letter-spacing also trails the last glyph, so centring the box
            // leaves the word a hair left. Half of it back as padding cancels.
            paddingLeft: '0.18em',
            textTransform: 'uppercase',
            userSelect: 'none',
            pointerEvents: 'none',
          }}
        >
          root
        </span>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Orb — an animated WebGL fireball                                   */
/* ------------------------------------------------------------------ */

/** Ceiling on the orb's backing store, in device pixels. See the cap in use. */
const ORB_MAX_PX = 512

const ORB_VERT_SRC = `
attribute vec2 a_position;
void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`

// Shader by Trisomie21 — https://www.shadertoy.com/view/lsf3RH
// Rendered as black-with-alpha rather than the original fire palette, so the
// orb reads as a hole punched in the canvas rather than a light source.
const ORB_FRAG_SRC = `
precision highp float;
uniform vec2 iResolution;
uniform float iTime;

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

const float shrink = 1.2;

void main() {
    vec2 p = -.5 + gl_FragCoord.xy / iResolution.xy;
    p.x *= iResolution.x / iResolution.y;

    float color = 3.0 - (3. * length(2. * p * shrink));
    vec3 coord = vec3(atan(p.x, p.y) / 6.2832 + .5, length(p * shrink) * .4, .5);

    for (int i = 1; i <= 7; i++) {
        float power = pow(2.0, float(i));
        color += (1.5 / power) * snoise(coord + vec3(0., iTime * .05, -iTime * .01), power * 16.);
    }
    float c = max(color, 0.0);
    gl_FragColor = vec4(vec3(0.0), smoothstep(0.8, 2.0, c));
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

/**
 * The expensive one: the same seven-octave noise the nebula background runs,
 * on an 80×80 canvas, every frame.
 *
 * It stops on window-hide like `CanvasBackground` does. A facet that animates
 * has to opt into that itself — an orb left spinning behind a hidden window is
 * exactly the sort of thing the power monitor was built to catch, and it is
 * invisible by definition.
 */
export function OrbRootNode({ size, focused }: RootNodeVisualProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rafRef = useRef<number>(0)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    // Capped at 2: past that the orb is paying for pixels nobody can see.
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    // Capped again in absolute pixels: seven octaves of 3D noise per pixel per
    // frame makes cost quadratic in the node's size, and the root node is now
    // label-scale. The orb is a soft blob, so the browser's upscale to `size`
    // costs nothing visible where the shader would cost a lot.
    const px = Math.min(Math.round(size * dpr), ORB_MAX_PX)
    canvas.width = px
    canvas.height = px

    const gl = canvas.getContext('webgl', {
      alpha: true,
      premultipliedAlpha: false,
      antialias: false,
    })
    if (!gl) return

    const vs = compileShader(gl, gl.VERTEX_SHADER, ORB_VERT_SRC)
    const fs = compileShader(gl, gl.FRAGMENT_SHADER, ORB_FRAG_SRC)
    if (!vs || !fs) return

    const prog = gl.createProgram()!
    gl.attachShader(prog, vs)
    gl.attachShader(prog, fs)
    gl.linkProgram(prog)
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      gl.deleteProgram(prog)
      gl.deleteShader(vs)
      gl.deleteShader(fs)
      return
    }
    gl.useProgram(prog)

    const buf = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buf)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)
    const posLoc = gl.getAttribLocation(prog, 'a_position')
    gl.enableVertexAttribArray(posLoc)
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0)

    const resLoc = gl.getUniformLocation(prog, 'iResolution')
    const timeLoc = gl.getUniformLocation(prog, 'iTime')
    gl.uniform2f(resLoc, px, px)

    gl.enable(gl.BLEND)
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)

    // Random phase so two windows do not animate in lockstep.
    const t0 = performance.now() - (Math.random() * 2_000_000 - 1_000_000)

    const tick = (now: number) => {
      gl.uniform1f(timeLoc, (now - t0) / 3333)
      gl.viewport(0, 0, px, px)
      gl.clearColor(0, 0, 0, 0)
      gl.clear(gl.COLOR_BUFFER_BIT)
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
      rafRef.current = requestAnimationFrame(tick)
    }

    const startLoop = () => { if (!rafRef.current) rafRef.current = requestAnimationFrame(tick) }
    const stopLoop = () => { if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = 0 } }

    const unsubVisibility = onWindowVisibleChange((visible) => {
      if (visible) startLoop(); else stopLoop()
    })
    if (isWindowVisible()) startLoop()

    return () => {
      stopLoop()
      unsubVisibility()
      gl.deleteProgram(prog)
      gl.deleteShader(vs)
      gl.deleteShader(fs)
      gl.deleteBuffer(buf)
    }
  }, [size])

  return (
    <div className="root-node__orb" style={{ position: 'relative', width: size, height: size }}>
      <canvas ref={canvasRef} style={{ width: size, height: size, display: 'block' }} />
      {focused && (
        <span
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#fff',
            fontSize: size * CENTRED_LABEL_FRACTION,
            fontWeight: 600,
            letterSpacing: '0.05em',
            userSelect: 'none',
            pointerEvents: 'none',
          }}
        >
          root
        </span>
      )}
    </div>
  )
}
