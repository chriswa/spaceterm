import { useCallback, useEffect, useRef } from 'react'
import { ROOT_NODE_RADIUS } from '../lib/constants'

interface RootNodeProps {
  focused: boolean
  onClick: () => void
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
// Shader by misterprada — https://www.shadertoy.com/user/misterprada
// Ref: celestianmaze — https://x.com/cmzw_/status/1787147460772864188

precision highp float;
uniform vec2 iResolution;
uniform float iTime;

vec4 permute_3d(vec4 x){ return mod(((x*34.0)+1.0)*x, 289.0); }
vec4 taylorInvSqrt3d(vec4 r){ return 1.79284291400159 - 0.85373472095314 * r; }

float simplexNoise3d(vec3 v)
{
    const vec2  C = vec2(1.0/6.0, 1.0/3.0);
    const vec4  D = vec4(0.0, 0.5, 1.0, 2.0);

    vec3 i  = floor(v + dot(v, C.yyy));
    vec3 x0 =   v - i + dot(i, C.xxx);

    vec3 g = step(x0.yzx, x0.xyz);
    vec3 l = 1.0 - g;
    vec3 i1 = min( g.xyz, l.zxy );
    vec3 i2 = max( g.xyz, l.zxy );

    vec3 x1 = x0 - i1 + 1.0 * C.xxx;
    vec3 x2 = x0 - i2 + 2.0 * C.xxx;
    vec3 x3 = x0 - 1.0 + 3.0 * C.xxx;

    i = mod(i, 289.0);
    vec4 p = permute_3d( permute_3d( permute_3d(
             i.z + vec4(0.0, i1.z, i2.z, 1.0 ))
           + i.y + vec4(0.0, i1.y, i2.y, 1.0 ))
           + i.x + vec4(0.0, i1.x, i2.x, 1.0 ));

    float n_ = 1.0/7.0;
    vec3  ns = n_ * D.wyz - D.xzx;

    vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
    vec4 x_ = floor(j * ns.z);
    vec4 y_ = floor(j - 7.0 * x_);

    vec4 x = x_ * ns.x + ns.yyyy;
    vec4 y = y_ * ns.x + ns.yyyy;
    vec4 h = 1.0 - abs(x) - abs(y);

    vec4 b0 = vec4( x.xy, y.xy );
    vec4 b1 = vec4( x.zw, y.zw );

    vec4 s0 = floor(b0)*2.0 + 1.0;
    vec4 s1 = floor(b1)*2.0 + 1.0;
    vec4 sh = -step(h, vec4(0.0));

    vec4 a0 = b0.xzyw + s0.xzyw*sh.xxyy;
    vec4 a1 = b1.xzyw + s1.xzyw*sh.zzww;

    vec3 p0 = vec3(a0.xy,h.x);
    vec3 p1 = vec3(a0.zw,h.y);
    vec3 p2 = vec3(a1.xy,h.z);
    vec3 p3 = vec3(a1.zw,h.w);

    vec4 norm = taylorInvSqrt3d(vec4(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3)));
    p0 *= norm.x;
    p1 *= norm.y;
    p2 *= norm.z;
    p3 *= norm.w;

    vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
    m = m * m;
    return 42.0 * dot( m*m, vec4( dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3) ) );
}

float fbm3d(vec3 x, const in int it) {
    float v = 0.0;
    float a = 0.5;
    vec3 shift = vec3(100);

    for (int i = 0; i < 32; ++i) {
        if(i<it) {
            v += a * simplexNoise3d(x);
            x = x * 2.0 + shift;
            a *= 0.5;
        }
    }
    return v;
}

vec3 rotateZ(vec3 v, float angle) {
    float cosAngle = cos(angle);
    float sinAngle = sin(angle);
    return vec3(
        v.x * cosAngle - v.y * sinAngle,
        v.x * sinAngle + v.y * cosAngle,
        v.z
    );
}

float facture(vec3 vector) {
    vec3 n = normalize(vector);
    return max(max(n.x, n.y), n.z);
}

vec3 emission(vec3 color, float strength) {
    return color * strength;
}

void mainImage( out vec4 fragColor, in vec2 fragCoord )
{
    vec2 uv = (fragCoord * 2.0 - iResolution.xy) / iResolution.y;

    vec3 color = vec3(uv.xy, 0.0);
    color.z += 0.5;

    color = normalize(color);
    color -= 0.2 * vec3(0.0, 0.0, iTime);

    float angle = -log2(length(uv));

    color = rotateZ( color, angle );

    float frequency = 1.4;
    float distortion = 0.01;
    color.x = fbm3d(color * frequency + 0.0, 5) + distortion;
    color.y = fbm3d(color * frequency + 1.0, 5) + distortion;
    color.z = fbm3d(color * frequency + 2.0, 5) + distortion;

    vec3 emissionColor = emission(vec3(0.961,0.592,0.078), 0.5);

    float fac = length(uv) - facture(color + 0.32);
    fac += 0.1;
    fac *= 3.0;

    color = mix(emissionColor, vec3(fac), fac + 1.2);

    fragColor = vec4(color, 1.0);
}

void main() {
    vec4 col;
    mainImage(col, gl_FragCoord.xy);

    float brightness = dot(col.rgb, vec3(0.299, 0.587, 0.114));
    float lum = 1.0 - brightness; // invert to grayscale
    float alpha = clamp(lum * 2.0, 0.0, 1.0);

    // Radial tint: white inside, dark grey outside
    vec2 uv = (gl_FragCoord.xy * 2.0 - iResolution.xy) / iResolution.y;
    float dist = length(uv);

    float fade = smoothstep(0.05, 0.6, dist);
    vec3 tint = mix(vec3(1.0), vec3(0.3), fade);

    gl_FragColor = vec4(vec3(lum) * tint, alpha);
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

export function RootNode({ focused, onClick }: RootNodeProps) {
  const size = ROOT_NODE_RADIUS * 2
  const canvasSize = size * CANVAS_SCALE
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rafRef = useRef<number>(0)

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      onClick()
    },
    [onClick],
  )

  useEffect(() => {
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
    gl.uniform2f(resLoc, pxW, pxH)

    gl.enable(gl.BLEND)
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)

    const t0 = performance.now()

    const tick = (now: number) => {
      gl.uniform1f(timeLoc, (now - t0) / 10000)
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
  }, [canvasSize])

  return (
    <div
      className={`root-node canvas-node${focused ? ' root-node--focused' : ''}`}
      style={{
        position: 'absolute',
        left: -ROOT_NODE_RADIUS,
        top: -ROOT_NODE_RADIUS,
        width: size,
        height: size,
      }}
      onMouseDown={handleMouseDown}
    >
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
    </div>
  )
}
