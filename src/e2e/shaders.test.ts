import { describe, it, expect, afterEach } from 'vitest'
import { e2eBlocker, launchApp, type LaunchedApp } from './electron-app'
import * as shaders from '../client/renderer/src/lib/theme/shaders'
import { PAVER_BG_FRAG } from '../client/renderer/src/lib/theme/paver-background'

/**
 * Every shader this repo ships, compiled by a real driver.
 *
 * Nothing else covers this. `shaders.ts` is a file of template literals, so a
 * GLSL error is invisible to `tsc` and to every jsdom suite (jsdom has no
 * WebGL); the renderer logs the driver's message to `~/.spaceterm/electron.log`
 * and draws nothing, which looks like a canvas that failed to lay out rather
 * than like a typo on one line of one shader. The themes only compile the
 * facets they select, so an unselected theme can stay broken indefinitely.
 *
 * Sources are discovered by name — every `*_FRAG` export is a fragment shader
 * and every `*_VERT_SRC` a vertex shader — so a new shader is covered by
 * existing here, the same way a new test file needs no registration.
 *
 * This borrows the launched app only for its renderer's GL context, and each
 * program is compiled in a throwaway canvas of its own rather than the app's,
 * so it cannot disturb what the window is drawing.
 */

const blocker = e2eBlocker()
const describeE2E = blocker ? describe.skip : describe

if (blocker) console.warn(`[e2e] skipping: ${blocker}`)

/** Fragment shader sources, by export name. */
const FRAGMENTS: [string, string][] = [
  ...Object.entries({ ...shaders, PAVER_BG_FRAG })
    .filter((entry): entry is [string, string] =>
      entry[0].endsWith('_FRAG') && typeof entry[1] === 'string'),
]

/** Vertex shader sources, by export name. */
const VERTICES: [string, string][] = Object.entries(shaders)
  .filter((entry): entry is [string, string] =>
    entry[0].endsWith('_VERT_SRC') && typeof entry[1] === 'string')

let launched: LaunchedApp | null = null

afterEach(async () => {
  await launched?.close()
  launched = null
})

describeE2E('the shader sources', () => {
  it('all compile, and every edge pair links', async () => {
    // A guard, not a formality: the discovery is by naming convention, and a
    // convention that stops matching would make this suite pass by covering
    // nothing at all.
    expect(FRAGMENTS.length).toBeGreaterThanOrEqual(5)
    expect(VERTICES.length).toBeGreaterThanOrEqual(2)

    launched = await launchApp()
    await launched.window.waitForSelector('#root', { timeout: 30_000 })

    const failures = await launched.window.evaluate(
      ({ fragments, vertices }) => {
        const canvas = document.createElement('canvas')
        const gl = canvas.getContext('webgl')
        if (!gl) return ['no WebGL context in the renderer']
        // The chevron shaders use fwidth(), which is an extension in WebGL 1.
        gl.getExtension('OES_standard_derivatives')

        const errors: string[] = []
        const compile = (name: string, type: number, src: string): WebGLShader | null => {
          const shader = gl.createShader(type)!
          gl.shaderSource(shader, src)
          gl.compileShader(shader)
          if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return shader
          errors.push(`${name}: ${gl.getShaderInfoLog(shader)}`)
          return null
        }

        const compiledVerts = new Map<string, WebGLShader>()
        for (const [name, src] of vertices) {
          const shader = compile(name, gl.VERTEX_SHADER, src)
          if (shader) compiledVerts.set(name, shader)
        }

        for (const [name, src] of fragments) {
          const frag = compile(name, gl.FRAGMENT_SHADER, src)
          if (!frag) continue
          // Linking is a second class of error: a fragment shader that reads a
          // varying its vertex shader does not write compiles fine on its own.
          // Every edge fragment has to link against every edge vertex shader,
          // since a theme is free to pair them (see `EdgeFacet.vert`).
          if (!name.includes('EDGE')) continue
          for (const [vertName, vert] of compiledVerts) {
            if (!vertName.includes('EDGE')) continue
            const prog = gl.createProgram()!
            gl.attachShader(prog, vert)
            gl.attachShader(prog, frag)
            gl.linkProgram(prog)
            if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
              errors.push(`${vertName} + ${name}: ${gl.getProgramInfoLog(prog)}`)
            }
          }
        }
        return errors
      },
      { fragments: FRAGMENTS, vertices: VERTICES }
    )

    expect(failures).toEqual([])
  })
})
