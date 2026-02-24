import { useEffect, useRef } from 'react'
import { helpGroups } from '../lib/help-registry'
import { isWindowVisible } from '../hooks/useWindowVisible'

const MODIFIER_KEYS = new Set(['Meta', 'Shift', 'Alt', 'Control'])

const MODIFIER_SYMBOLS: Record<string, string> = {
  Control: '⌃',
  Alt: '⌥',
  Shift: '⇧',
  Meta: '⌘',
}

// Standard Mac modifier order: ⌃ ⌥ ⇧ ⌘
const MODIFIER_ORDER = ['Control', 'Alt', 'Shift', 'Meta']
const MODIFIER_SYMBOL_ORDER = '⌃⌥⇧⌘'

const KEY_LABELS: Record<string, string> = {
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  Enter: '↩',
  Escape: 'Esc',
  Backspace: '⌫',
  Delete: '⌦',
  Tab: '⇥',
  ' ': 'Space',
}

function labelForKey(key: string): string {
  if (KEY_LABELS[key]) return KEY_LABELS[key]
  if (key.length === 1) return key.toUpperCase()
  return key
}

// --- Shortcut name lookup ---
// Normalizes a key string from the help registry (e.g. "⌘ ⇧ S") into the
// same format the overlay produces (e.g. "⇧⌘S") by stripping spaces and
// re-ordering modifier symbols to match MODIFIER_ORDER.
function normalizeKeysToOverlayFormat(keysStr: string): string {
  const stripped = keysStr.replace(/\s+/g, '')
  const mods: string[] = []
  let rest = ''
  for (const char of stripped) {
    if (MODIFIER_SYMBOL_ORDER.includes(char)) {
      mods.push(char)
    } else {
      rest += char
    }
  }
  mods.sort((a, b) => MODIFIER_SYMBOL_ORDER.indexOf(a) - MODIFIER_SYMBOL_ORDER.indexOf(b))
  return mods.join('') + rest
}

// Build a Map<overlayComboString, shortName> from the help registry at
// module load time. Entries with " / " separators register each variant.
const shortcutNames: Map<string, string> = (() => {
  const map = new Map<string, string>()
  for (const group of helpGroups) {
    for (const entry of group.entries) {
      const variants = entry.keys.split(/\s*\/\s*/)
      // Extract modifier prefix from first variant for shorthand expansion
      // e.g. "⌘ ←" / "→" → second variant gets ⌘ prepended
      const firstNormalized = normalizeKeysToOverlayFormat(variants[0])
      const modPrefix = [...firstNormalized].filter(c => MODIFIER_SYMBOL_ORDER.includes(c)).join('')

      for (const variant of variants) {
        let normalized = normalizeKeysToOverlayFormat(variant)
        // If variant has no modifiers but the first variant did, prepend them
        const variantMods = [...normalized].filter(c => MODIFIER_SYMBOL_ORDER.includes(c))
        if (modPrefix && variantMods.length === 0) {
          normalized = modPrefix + normalized
        }
        // Skip mouse/click/drag entries — they don't map to keyboard combos
        if (/click|drag|pinch|scroll/i.test(normalized)) continue
        // Skip entries that are just descriptions (no modifier and not a known single key)
        if (!modPrefix && variantMods.length === 0 && normalized !== 'Esc') continue
        map.set(normalized, entry.name)
      }
    }
  }
  return map
})()

type FadeState =
  | 'idle'
  | 'active'
  | 'modifier-release'
  | 'combo-hold'
  | 'combo-fade'

// Timing constants
const COMBO_HOLD_MS = 1000
const COMBO_HOLD_LABELED_MS = 2000
const COMBO_FADE_MS = 400
const MODIFIER_FAST_OPACITY = 0.25
const MODIFIER_TAIL_MS = 600

// Mouse constants
const DRAG_THRESHOLD_PX = 8

// Zoom debounce — how long after the last pinch wheel event before fading
const ZOOM_DEBOUNCE_MS = 300

// Wave simulation resolution scale (fraction of screen resolution)
const SIM_SCALE = 0.5
// Fraction of sim texture that extends beyond the visible screen on each side.
// The sponge layer lives entirely in this hidden border.
const SIM_PADDING = 0.15

// --- Wave simulation shaders (WebGL 2 / GLSL 300 es) ---

const WAVE_VERT_SRC = `#version 300 es
in vec2 a_position;
out vec2 vUV;
void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
  vUV = a_position * 0.5 + 0.5;
}
`

const WAVE_SIM_FRAG_SRC = `#version 300 es
precision highp float;

uniform sampler2D uPrev;
uniform sampler2D uCurr;
uniform vec2 uTexelSize;

// Each impulse is a line segment: (startXY, endXY, intensity)
uniform int uImpulseCount;
uniform vec2 uImpulseA[8]; // start point (UV)
uniform vec2 uImpulseB[8]; // end point (UV)
uniform float uImpulseI[8]; // intensity
uniform float uImpulseR[8]; // radius

const float WAVE_SPEED = 0.25;   // must be <= 0.25 for stability
const float FRICTION = 0.06;     // velocity damping — kills center oscillation
const float AMPLITUDE_DAMP = 0.998; // gentle global amplitude decay

out vec4 fragColor;

void main() {
  vec2 uv = gl_FragCoord.xy * uTexelSize;

  // Absorbing sponge layer — lives entirely in the hidden padding border
  // outside the visible screen area, so no visible damping artifacts.
  float padFrac = ${SIM_PADDING} / (1.0 + ${SIM_PADDING} * 2.0);
  float edgeDist = min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y));
  float sponge = smoothstep(0.0, padFrac, edgeDist);

  float c = texture(uCurr, uv).r * sponge;
  float l = texture(uCurr, uv + vec2(-uTexelSize.x, 0.0)).r * sponge;
  float r = texture(uCurr, uv + vec2( uTexelSize.x, 0.0)).r * sponge;
  float u = texture(uCurr, uv + vec2(0.0,  uTexelSize.y)).r * sponge;
  float d = texture(uCurr, uv + vec2(0.0, -uTexelSize.y)).r * sponge;
  float prev = texture(uPrev, uv).r * sponge;

  // 2D wave equation with velocity damping:
  // next = (2 - friction)*c - (1 - friction)*prev + speed*(laplacian)
  // The friction term damps the velocity (c - prev), so disturbed points
  // settle back to zero instead of oscillating.
  float laplacian = l + r + u + d - 4.0 * c;
  float next = (2.0 - FRICTION) * c - (1.0 - FRICTION) * prev + WAVE_SPEED * laplacian;
  next *= AMPLITUDE_DAMP;

  // Inject impulses — each is a line segment, producing a smooth stroke
  // of depression along the drag path. Distance is aspect-corrected so
  // the impulse cross-section is circular on screen.
  float invAspect = uTexelSize.y / uTexelSize.x; // simW/simH
  for (int i = 0; i < 8; i++) {
    if (i >= uImpulseCount) break;
    vec2 a = uImpulseA[i];
    vec2 b = uImpulseB[i];
    float intensity = uImpulseI[i];
    // Aspect-correct into physical space for distance calc
    vec2 p = vec2(uv.x * invAspect, uv.y);
    vec2 sa = vec2(a.x * invAspect, a.y);
    vec2 sb = vec2(b.x * invAspect, b.y);
    // Distance from point to line segment
    vec2 ab = sb - sa;
    float t = clamp(dot(p - sa, ab) / max(dot(ab, ab), 1e-8), 0.0, 1.0);
    float dist = length(p - sa - ab * t);
    float radius = uImpulseR[i];
    next -= intensity * smoothstep(radius, 0.0, dist);
  }

  fragColor = vec4(next, 0.0, 0.0, 1.0);
}
`

const WAVE_RENDER_FRAG_SRC = `#version 300 es
precision highp float;

uniform sampler2D uWave;
uniform vec2 uRenderTexelSize;
uniform float uPadFrac; // fraction of sim texture that is padding on each side
in vec2 vUV;
out vec4 fragColor;

void main() {
  // Map screen UV [0,1] into the inner (visible) portion of the padded sim texture
  vec2 simUV = uPadFrac + vUV * (1.0 - 2.0 * uPadFrac);

  // Sample neighbors to compute surface gradient (slope)
  float l = texture(uWave, simUV + vec2(-uRenderTexelSize.x, 0.0)).r;
  float r = texture(uWave, simUV + vec2( uRenderTexelSize.x, 0.0)).r;
  float u = texture(uWave, simUV + vec2(0.0,  uRenderTexelSize.y)).r;
  float d = texture(uWave, simUV + vec2(0.0, -uRenderTexelSize.y)).r;

  // Gradient magnitude — highlights wave crests and edges,
  // transparent where surface is flat (center of displacement + calm water)
  float grad = length(vec2(r - l, u - d));
  // Square to compress low-level noise away and push crests toward full white
  float alpha = clamp(grad * 12.0, 0.0, 1.0);
  alpha *= alpha;
  fragColor = vec4(1.0, 1.0, 1.0, alpha);
}
`

// --- WebGL helpers ---

function compileShader(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader | null {
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

function createProgram(gl: WebGL2RenderingContext, vertSrc: string, fragSrc: string): WebGLProgram | null {
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

export function KeycastOverlay() {
  const svgRef = useRef<SVGSVGElement>(null)
  const textRef = useRef<SVGTextElement>(null)
  const descRef = useRef<SVGTextElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  // All mutable state lives in refs to avoid re-renders — we drive the DOM directly
  const heldModifiers = useRef(new Set<string>())
  const fadeState = useRef<FadeState>('idle')
  const fadeStart = useRef(0)
  const comboLocked = useRef(false)
  const comboTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const rafId = useRef(0)

  // Mouse tracking
  const mouseDownPos = useRef<{ x: number; y: number } | null>(null)
  const mousePos = useRef<{ x: number; y: number }>({ x: 0, y: 0 })
  const isDragging = useRef(false)

  // Wave impulse queue — mouse handlers push line segments, WebGL loop consumes
  const impulseQueue = useRef<Array<{ ax: number; ay: number; bx: number; by: number; intensity: number; radius: number }>>([])

  // Zoom tracking
  const zoomTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Active continuous gesture — while set, modifier changes update the display
  // instantly and the display stays at full opacity until the gesture ends.
  // Stores the gesture suffix (e.g. "Drag", "← Pan", "Zoom", "Click").
  const activeGesture = useRef<string | null>(null)

  // --- WebGL wave simulation lifecycle ---
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const dpr = window.devicePixelRatio

    const gl = canvas.getContext('webgl2', {
      alpha: true,
      premultipliedAlpha: false,
      antialias: false,
    })
    if (!gl) return

    // Required to render into R32F framebuffer attachments
    if (!gl.getExtension('EXT_color_buffer_float')) return
    // Enable linear filtering on float textures if available
    const hasFloatLinear = !!gl.getExtension('OES_texture_float_linear')
    const texFilter = hasFloatLinear ? gl.LINEAR : gl.NEAREST

    // --- Compile programs ---
    const simProg = createProgram(gl, WAVE_VERT_SRC, WAVE_SIM_FRAG_SRC)
    const renderProg = createProgram(gl, WAVE_VERT_SRC, WAVE_RENDER_FRAG_SRC)
    if (!simProg || !renderProg) return

    // --- Sim program uniforms ---
    const simPosLoc = gl.getAttribLocation(simProg, 'a_position')
    const simPrevLoc = gl.getUniformLocation(simProg, 'uPrev')
    const simCurrLoc = gl.getUniformLocation(simProg, 'uCurr')
    const simTexelLoc = gl.getUniformLocation(simProg, 'uTexelSize')
    const simImpulseCountLoc = gl.getUniformLocation(simProg, 'uImpulseCount')
    const simImpulseALocs: WebGLUniformLocation[] = []
    const simImpulseBLocs: WebGLUniformLocation[] = []
    const simImpulseILocs: WebGLUniformLocation[] = []
    const simImpulseRLocs: WebGLUniformLocation[] = []
    for (let i = 0; i < 8; i++) {
      simImpulseALocs.push(gl.getUniformLocation(simProg, `uImpulseA[${i}]`)!)
      simImpulseBLocs.push(gl.getUniformLocation(simProg, `uImpulseB[${i}]`)!)
      simImpulseILocs.push(gl.getUniformLocation(simProg, `uImpulseI[${i}]`)!)
      simImpulseRLocs.push(gl.getUniformLocation(simProg, `uImpulseR[${i}]`)!)
    }

    // --- Render program uniforms ---
    const renderPosLoc = gl.getAttribLocation(renderProg, 'a_position')
    const renderWaveLoc = gl.getUniformLocation(renderProg, 'uWave')
    const renderTexelLoc = gl.getUniformLocation(renderProg, 'uRenderTexelSize')
    const renderPadLoc = gl.getUniformLocation(renderProg, 'uPadFrac')
    const padFrac = SIM_PADDING / (1 + SIM_PADDING * 2)

    // --- Quad buffer ---
    const quadBuf = gl.createBuffer()!
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)

    // --- Simulation textures and framebuffers ---
    // Three textures/FBOs for the wave equation: prev (t-2), curr (t-1), next (t).
    // Each frame we read prev+curr and write to next, then rotate indices.
    // This avoids feedback loops (never reading and writing the same texture).
    let simW = 0
    let simH = 0
    const textures: WebGLTexture[] = [null!, null!, null!]
    const framebuffers: WebGLFramebuffer[] = [null!, null!, null!]
    let prevIdx = 0  // t-2
    let currIdx = 1  // t-1
    let nextIdx = 2  // write target

    function createSimResources(w: number, h: number) {
      simW = w
      simH = h
      for (let i = 0; i < 3; i++) {
        if (textures[i]) gl.deleteTexture(textures[i])
        if (framebuffers[i]) gl.deleteFramebuffer(framebuffers[i])

        const tex = gl.createTexture()!
        gl.bindTexture(gl.TEXTURE_2D, tex)
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, w, h, 0, gl.RED, gl.FLOAT, null)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, texFilter)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, texFilter)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
        textures[i] = tex

        const fb = gl.createFramebuffer()!
        gl.bindFramebuffer(gl.FRAMEBUFFER, fb)
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)
        framebuffers[i] = fb
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      prevIdx = 0
      currIdx = 1
      nextIdx = 2
    }

    // --- Resize handling ---
    const resize = () => {
      const w = Math.round(canvas.clientWidth * dpr)
      const h = Math.round(canvas.clientHeight * dpr)
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w
        canvas.height = h
      }
      // Sim texture is larger than the screen — extra border for the sponge layer
      const padScale = 1 + SIM_PADDING * 2
      const newSimW = Math.max(1, Math.floor(w * SIM_SCALE * padScale))
      const newSimH = Math.max(1, Math.floor(h * SIM_SCALE * padScale))
      if (newSimW !== simW || newSimH !== simH) {
        createSimResources(newSimW, newSimH)
      }
    }

    const observer = new ResizeObserver(resize)
    observer.observe(canvas)
    resize()

    // --- Animation loop ---
    let waveRafId = 0

    const tick = () => {
      waveRafId = requestAnimationFrame(tick)
      resize()

      if (simW === 0 || simH === 0) return

      // Read prev (t-2) and curr (t-1), write next (t) — no feedback loops
      // --- Simulation pass (no blending — writing raw float values) ---
      gl.disable(gl.BLEND)
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffers[nextIdx])
      gl.viewport(0, 0, simW, simH)

      gl.useProgram(simProg)

      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, textures[prevIdx])
      gl.activeTexture(gl.TEXTURE1)
      gl.bindTexture(gl.TEXTURE_2D, textures[currIdx])

      gl.uniform1i(simPrevLoc, 0)
      gl.uniform1i(simCurrLoc, 1)
      gl.uniform2f(simTexelLoc, 1 / simW, 1 / simH)

      // Drain impulse queue (line segments)
      const impulses = impulseQueue.current.splice(0, 8)
      gl.uniform1i(simImpulseCountLoc, impulses.length)
      for (let i = 0; i < impulses.length; i++) {
        gl.uniform2f(simImpulseALocs[i], impulses[i].ax, impulses[i].ay)
        gl.uniform2f(simImpulseBLocs[i], impulses[i].bx, impulses[i].by)
        gl.uniform1f(simImpulseILocs[i], impulses[i].intensity)
        gl.uniform1f(simImpulseRLocs[i], impulses[i].radius)
      }

      gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf)
      gl.enableVertexAttribArray(simPosLoc)
      gl.vertexAttribPointer(simPosLoc, 2, gl.FLOAT, false, 0, 0)
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
      gl.disableVertexAttribArray(simPosLoc)

      // Rotate: prev <- curr <- next <- prev
      const oldPrev = prevIdx
      prevIdx = currIdx
      currIdx = nextIdx
      nextIdx = oldPrev

      // --- Render pass (blending on — compositing alpha onto transparent canvas) ---
      gl.enable(gl.BLEND)
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      gl.viewport(0, 0, canvas.width, canvas.height)
      gl.clearColor(0, 0, 0, 0)
      gl.clear(gl.COLOR_BUFFER_BIT)

      gl.useProgram(renderProg)
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, textures[currIdx])
      gl.uniform1i(renderWaveLoc, 0)
      gl.uniform2f(renderTexelLoc, 1 / simW, 1 / simH)
      gl.uniform1f(renderPadLoc, padFrac)

      gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf)
      gl.enableVertexAttribArray(renderPosLoc)
      gl.vertexAttribPointer(renderPosLoc, 2, gl.FLOAT, false, 0, 0)
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
      gl.disableVertexAttribArray(renderPosLoc)
    }

    const startLoop = () => { if (!waveRafId) waveRafId = requestAnimationFrame(tick) }
    const stopLoop = () => { if (waveRafId) { cancelAnimationFrame(waveRafId); waveRafId = 0 } }

    const unsubVisibility = window.api.window.onVisibilityChanged((visible) => {
      if (visible) startLoop(); else stopLoop()
    })

    if (isWindowVisible()) startLoop()

    return () => {
      stopLoop()
      unsubVisibility()
      observer.disconnect()
      gl.deleteProgram(simProg)
      gl.deleteProgram(renderProg)
      for (let i = 0; i < 3; i++) {
        if (textures[i]) gl.deleteTexture(textures[i])
        if (framebuffers[i]) gl.deleteFramebuffer(framebuffers[i])
      }
      gl.deleteBuffer(quadBuf)
    }
  }, [])

  // --- Keyboard / mouse / gesture event handling ---
  useEffect(() => {
    const buildModifierString = (): string => {
      const parts: string[] = []
      for (const mod of MODIFIER_ORDER) {
        if (heldModifiers.current.has(mod)) {
          parts.push(MODIFIER_SYMBOLS[mod])
        }
      }
      return parts.join('')
    }

    const setDisplay = (text: string) => {
      if (textRef.current) {
        textRef.current.textContent = text
      }
      // Look up shortcut name and show it
      if (descRef.current) {
        descRef.current.textContent = shortcutNames.get(text) ?? ''
      }
    }

    const cancelComboTimer = () => {
      if (comboTimer.current !== null) {
        clearTimeout(comboTimer.current)
        comboTimer.current = null
      }
    }

    const startFade = (state: FadeState) => {
      fadeState.current = state
      fadeStart.current = performance.now()
    }

    const cancelZoomTimer = () => {
      if (zoomTimer.current !== null) {
        clearTimeout(zoomTimer.current)
        zoomTimer.current = null
      }
    }

    const lockCombo = (text: string) => {
      cancelComboTimer()
      cancelZoomTimer()
      activeGesture.current = null
      comboLocked.current = true
      setDisplay(text)
      startFade('combo-hold')

      const hasLabel = shortcutNames.has(text)
      comboTimer.current = setTimeout(() => {
        comboTimer.current = null
        comboLocked.current = false
        startFade('combo-fade')
      }, hasLabel ? COMBO_HOLD_LABELED_MS : COMBO_HOLD_MS)
    }

    // Start or update a continuous gesture — stays visible until endGesture()
    const startGesture = (suffix: string) => {
      cancelComboTimer()
      cancelZoomTimer()
      activeGesture.current = suffix
      comboLocked.current = true
      setDisplay(buildModifierString() + suffix)
      fadeState.current = 'combo-hold'
      fadeStart.current = performance.now()
    }

    // End the continuous gesture and start the normal fade-out sequence
    const endGesture = () => {
      const suffix = activeGesture.current
      activeGesture.current = null
      if (!suffix) return
      // Lock a final combo with whatever modifiers + gesture are showing
      const finalText = textRef.current?.textContent ?? ''
      if (finalText) {
        lockCombo(finalText)
      } else {
        comboLocked.current = false
        startFade('combo-fade')
      }
    }

    // Rebuild display when modifiers change during a live gesture
    const updateGestureModifiers = () => {
      const suffix = activeGesture.current
      if (!suffix) return
      setDisplay(buildModifierString() + suffix)
    }

    // --- Push wave impulse (line segment from A to B) ---
    // Map screen coords into the sim texture's padded UV space.
    const padFrac = SIM_PADDING / (1 + SIM_PADDING * 2)
    const toSimUV = (clientX: number, clientY: number) => ({
      x: padFrac + (clientX / window.innerWidth) * (1 - 2 * padFrac),
      y: padFrac + (1.0 - clientY / window.innerHeight) * (1 - 2 * padFrac),
    })
    const CLICK_RADIUS = 0.016
    const DRAG_RADIUS = 0.008
    const pushImpulseLine = (
      x1: number, y1: number, x2: number, y2: number, intensity: number
    ) => {
      const a = toSimUV(x1, y1)
      const b = toSimUV(x2, y2)
      impulseQueue.current.push({ ax: a.x, ay: a.y, bx: b.x, by: b.y, intensity, radius: DRAG_RADIUS })
    }
    const pushImpulsePoint = (clientX: number, clientY: number, intensity: number) => {
      const p = toSimUV(clientX, clientY)
      impulseQueue.current.push({ ax: p.x, ay: p.y, bx: p.x, by: p.y, intensity, radius: CLICK_RADIUS })
    }

    // --- Key handlers ---
    const handleKeyDown = (e: KeyboardEvent) => {
      if (MODIFIER_KEYS.has(e.key)) {
        heldModifiers.current.add(e.key)
        // During a live gesture, update modifiers instantly
        if (activeGesture.current) { updateGestureModifiers(); return }
        if (comboLocked.current) return
        cancelComboTimer()
        setDisplay(buildModifierString())
        fadeState.current = 'active'
      } else {
        lockCombo(buildModifierString() + labelForKey(e.key))
      }
    }

    const handleKeyUp = (e: KeyboardEvent) => {
      if (MODIFIER_KEYS.has(e.key)) {
        heldModifiers.current.delete(e.key)
        // During a live gesture, update modifiers instantly
        if (activeGesture.current) { updateGestureModifiers(); return }
        if (comboLocked.current) return

        if (heldModifiers.current.size > 0) {
          setDisplay(buildModifierString())
          fadeState.current = 'active'
        } else {
          startFade('modifier-release')
        }
      }
    }

    // --- Mouse handlers ---
    const handleMouseDown = (e: MouseEvent) => {
      mouseDownPos.current = { x: e.clientX, y: e.clientY }
      mousePos.current = { x: e.clientX, y: e.clientY }
      isDragging.current = false

      // Show click as a live gesture (modifiers can change while held)
      startGesture('Click')
      pushImpulsePoint(e.clientX, e.clientY, 0.25)
    }

    const handleMouseMove = (e: MouseEvent) => {
      const down = mouseDownPos.current
      if (!down) return

      const prevX = mousePos.current.x
      const prevY = mousePos.current.y
      mousePos.current = { x: e.clientX, y: e.clientY }

      if (!isDragging.current) {
        const ddx = e.clientX - down.x
        const ddy = e.clientY - down.y
        if (ddx * ddx + ddy * ddy > DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) {
          isDragging.current = true
          startGesture('Drag')
        }
      }

      // Push a single line-segment impulse from previous to current position.
      // The shader computes distance-to-segment per fragment for smooth strokes.
      if (isDragging.current) {
        const dx = e.clientX - prevX
        const dy = e.clientY - prevY
        const dist = Math.sqrt(dx * dx + dy * dy)
        const intensity = Math.min(0.08 + dist * 0.005, 0.4)
        pushImpulseLine(prevX, prevY, e.clientX, e.clientY, intensity)
      }
    }

    const handleMouseUp = () => {
      const wasDown = mouseDownPos.current !== null
      mouseDownPos.current = null
      isDragging.current = false
      if (wasDown) {
        endGesture()
      }
    }

    const handleDblClick = () => {
      lockCombo(buildModifierString() + 'Double Click')
    }

    // --- Wheel/pinch/pan handler ---
    const panArrowForDelta = (dx: number, dy: number): string => {
      if (Math.abs(dx) > Math.abs(dy)) {
        return dx > 0 ? '→ ' : '← '
      }
      return dy > 0 ? '↓ ' : '↑ '
    }

    const isGestureType = (type: string): boolean => {
      const g = activeGesture.current
      return g != null && g.endsWith(type)
    }

    const handleWheel = (e: WheelEvent) => {
      const isPinch = e.ctrlKey
      const isPan = !e.ctrlKey && (Math.abs(e.deltaX) > 2 || Math.abs(e.deltaY) > 2)

      if (!isPinch && !isPan) return

      const suffix = isPinch
        ? 'Zoom'
        : panArrowForDelta(e.deltaX, e.deltaY) + 'Pan'

      cancelZoomTimer()

      // Already in the same gesture type — update suffix (arrow direction) and debounce
      if (isPinch ? isGestureType('Zoom') : isGestureType('Pan')) {
        activeGesture.current = suffix
        setDisplay(buildModifierString() + suffix)
        zoomTimer.current = setTimeout(() => {
          zoomTimer.current = null
          endGesture()
        }, ZOOM_DEBOUNCE_MS)
        return
      }

      // First event of this gesture
      startGesture(suffix)
      zoomTimer.current = setTimeout(() => {
        zoomTimer.current = null
        endGesture()
      }, ZOOM_DEBOUNCE_MS)
    }

    // --- Animation loop (SVG text opacity) ---
    const tick = () => {
      rafId.current = requestAnimationFrame(tick)
      const el = svgRef.current
      if (!el) return

      const state = fadeState.current
      let opacity = 0

      if (state === 'idle') {
        opacity = 0
      } else if (state === 'active') {
        opacity = 1
      } else if (state === 'combo-hold') {
        opacity = 1
      } else if (state === 'combo-fade') {
        const elapsed = performance.now() - fadeStart.current
        opacity = Math.max(0, 1 - elapsed / COMBO_FADE_MS)
        if (opacity <= 0) fadeState.current = 'idle'
      } else if (state === 'modifier-release') {
        const elapsed = performance.now() - fadeStart.current
        opacity = MODIFIER_FAST_OPACITY * Math.max(0, 1 - elapsed / MODIFIER_TAIL_MS)
        if (opacity <= 0) fadeState.current = 'idle'
      }

      el.style.opacity = String(opacity)
    }

    const handleBlur = () => {
      heldModifiers.current.clear()
      mouseDownPos.current = null
      isDragging.current = false
      activeGesture.current = null
      if (!comboLocked.current) {
        fadeState.current = 'idle'
      }
    }

    window.addEventListener('keydown', handleKeyDown, { capture: true })
    window.addEventListener('keyup', handleKeyUp, { capture: true })
    window.addEventListener('mousedown', handleMouseDown, { capture: true })
    window.addEventListener('mousemove', handleMouseMove, { capture: true })
    window.addEventListener('mouseup', handleMouseUp, { capture: true })
    window.addEventListener('dblclick', handleDblClick, { capture: true })
    window.addEventListener('wheel', handleWheel, { capture: true, passive: true })
    window.addEventListener('blur', handleBlur)
    rafId.current = requestAnimationFrame(tick)

    return () => {
      window.removeEventListener('keydown', handleKeyDown, { capture: true })
      window.removeEventListener('keyup', handleKeyUp, { capture: true })
      window.removeEventListener('mousedown', handleMouseDown, { capture: true })
      window.removeEventListener('mousemove', handleMouseMove, { capture: true })
      window.removeEventListener('mouseup', handleMouseUp, { capture: true })
      window.removeEventListener('dblclick', handleDblClick, { capture: true })
      window.removeEventListener('wheel', handleWheel, { capture: true })
      window.removeEventListener('blur', handleBlur)
      cancelAnimationFrame(rafId.current)
      cancelComboTimer()
      cancelZoomTimer()
    }
  }, [])

  return (
    <>
      <canvas ref={canvasRef} className="keycast-wave-canvas" />
      <svg ref={svgRef} className="keycast-overlay" style={{ opacity: 0 }}>
        <text
          ref={textRef}
          x="100%"
          y={56}
          dx={-8}
          textAnchor="end"
          dominantBaseline="central"
          fontSize={72}
          fontFamily="system-ui, -apple-system, BlinkMacSystemFont, sans-serif"
          fontWeight={700}
          fill="white"
          stroke="black"
          strokeWidth={6}
          strokeLinejoin="round"
          paintOrder="stroke"
        />
        <text
          ref={descRef}
          x="100%"
          y={94}
          dx={-8}
          textAnchor="end"
          dominantBaseline="central"
          fontSize={28}
          fontFamily="system-ui, -apple-system, BlinkMacSystemFont, sans-serif"
          fontWeight={500}
          fill="rgba(255,255,255,0.85)"
          stroke="black"
          strokeWidth={4}
          strokeLinejoin="round"
          paintOrder="stroke"
        />
      </svg>
    </>
  )
}
