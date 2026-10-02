import { describe, it, expect } from 'vitest'
import { ROOT_DISC_RADIUS } from '../../../../../shared/node-size'
import { PAVER_BG_FRAG, PAVER_COURSE_GLSL, PAVER_LATTICE } from './paver-background'
import { HEX_PAVER_BG_FRAG, POLYGON_LATTICE, TRIANGLE_PAVER_BG_FRAG } from './polygon-paver-background'

/**
 * What the hex and triangle floors have to keep being: an exact honeycomb
 * that closes every ring and opens outward, and Pavers' concentric courses
 * cut into triangles. The courses themselves are pinned by
 * `paver-lattice.test`.
 */

const { TRIANGLE_ASPECT: ASPECT, HEX_COUNT, HEX_JOINT_AT } = POLYGON_LATTICE
const TAU = Math.PI * 2
const { JOINT: PAVER_JOINT } = PAVER_LATTICE

describe('the aspect', () => {
  it('makes equilateral triangles: the slanted sides are as long as the base', () => {
    const depth = 1
    const base = ASPECT * depth
    expect(Math.hypot(base / 2, depth)).toBeCloseTo(base, 9)
  })
})

describe('the hexagons', () => {
  /** Ported from HEX_PAVER_BG_FRAG: the honeycomb's coordinates, in hexagons. */
  const toHoneycomb = (r: number, theta: number): [number, number] =>
    [(theta * HEX_COUNT) / TAU, (Math.log(r / ROOT_DISC_RADIUS) * HEX_COUNT) / TAU]
  /** Stone width across the flats at radius r, in world units. */
  const stoneAt = (r: number): number => (TAU * r) / HEX_COUNT

  it('close every ring: the same whole number of stones in each', () => {
    // A full turn is HEX_COUNT lattice units across, and the lattice repeats
    // every one, so the joints meet on the -x axis at every radius.
    expect(Number.isInteger(HEX_COUNT)).toBe(true)
    const [a] = toHoneycomb(1_000, -Math.PI)
    const [b] = toHoneycomb(1_000, Math.PI)
    expect(b - a).toBeCloseTo(HEX_COUNT, 9)
  })

  it('are laid conformally, so a stone is as deep as it is wide', () => {
    // One lattice unit outward and one round are the same world distance.
    for (const r of [400, 2_000, 30_000]) {
      const step = 1e-6
      const [, y0] = toHoneycomb(r, 0)
      const [, y1] = toHoneycomb(r * (1 + step), 0)
      const outward = (r * step) / (y1 - y0)
      const round = (r * TAU) / HEX_COUNT
      expect(outward / round, `r = ${r}`).toBeCloseTo(1, 5)
    }
  })

  it('stay close to regular: a stone is not much larger across its outer edge than its inner', () => {
    const ringGrowth = Math.exp((TAU * Math.sqrt(3)) / (2 * HEX_COUNT))
    expect(ringGrowth).toBeLessThan(1.2)
  })

  it('grow outward, and are a workable size where the tree lives', () => {
    expect(stoneAt(10_000) / stoneAt(1_000)).toBeCloseTo(10, 9)
    expect(stoneAt(1_000)).toBeGreaterThan(120)
    expect(stoneAt(1_000)).toBeLessThan(400)
  })

  it('are self-similar: the joint is the same share of every stone', () => {
    // The joint scales with the stone, so a big stone far out is a small one
    // near the rim, enlarged — and the share is narrow, as Pavers' is.
    const jointAt = (r: number): number => 2 * PAVER_JOINT * (stoneAt(r) / HEX_JOINT_AT)
    for (const r of [ROOT_DISC_RADIUS, 2_000, 50_000]) {
      expect(jointAt(r) / stoneAt(r), `r = ${r}`).toBeCloseTo((2 * PAVER_JOINT) / HEX_JOINT_AT, 9)
    }
    expect((2 * PAVER_JOINT) / HEX_JOINT_AT).toBeLessThan(0.1)
    expect(HEX_PAVER_BG_FRAG).toContain('float fit = scale / JOINT_AT;')
    expect(HEX_PAVER_BG_FRAG).toContain('float chamferWidth = CHAMFER * fit;')
  })
})

describe('the triangles', () => {
  /** Ported from TRIANGLE_PAVER_BG_FRAG: which triangle (a, fy) is in. */
  const triangleAt = (a: number, fy: number, count: number): number => {
    const tri = Math.floor(a - 0.5 * fy) + Math.floor(a + 0.5 * fy)
    return ((tri % (2 * count)) + 2 * count) % (2 * count)
  }

  it('close the ring: one turn round the course is a whole number of triangle pairs', () => {
    for (const count of [6, 9, 13, 40, 401]) {
      for (const [a, fy] of [[0.1, 0.2], [3.7, 0.9], [count - 0.05, 0.5]]) {
        expect(triangleAt(a + count, fy, count), `count ${count}`).toBe(triangleAt(a, fy, count))
      }
    }
  })

  it('alternate point-out and point-in, two to a stone', () => {
    const count = 12
    const seen = new Set<number>()
    for (let a = 0; a < count; a += 0.01) seen.add(triangleAt(a, 0.5, count))
    expect(seen.size).toBe(2 * count)
    // Along the inner edge only point-out triangles stand; along the outer, only point-in.
    for (let a = 0.05; a < count; a += 0.1) {
      expect(triangleAt(a, 0.001, count) % 2).toBe(0)
      expect(triangleAt(a, 0.999, count) % 2).toBe(1)
    }
  })
})

describe.each([
  ['hex', HEX_PAVER_BG_FRAG],
  ['triangle', TRIANGLE_PAVER_BG_FRAG],
])('the %s shader', (name, src) => {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

  it.runIf(name === 'triangle')('lays Pavers\' courses', () => {
    const courses = PAVER_COURSE_GLSL.replace(/\/\/[^\n]*/g, '')
    for (const line of courses.split('\n').filter(l => l.trim())) {
      expect(code, line.trim()).toContain(line)
    }
    expect(code).toContain(`const float ASPECT  = ${ASPECT.toFixed(4)};`)
  })

  it('is the Pavers stone: same palette and shading, cut differently', () => {
    for (const line of ['const vec3 GROUND', 'const vec3 STONE_LIGHT', 'tone *= 1.0 + grain * GRAIN_STONE;', 'gl_FragColor = vec4(linearToSrgb(col), 1.0);']) {
      const pick = (s: string) => s.split('\n').find(l => l.includes(line))
      expect(pick(src), line).toBe(pick(PAVER_BG_FRAG))
    }
  })

  it('is a painting: zoom reaches the footprint and nothing else', () => {
    for (const line of code.split('\n')) {
      if (/\b(float (tri|cell|hx|hy|scale|ring|spoke|inset)|vec2 (hp|local|p)|vec3 id) =/.test(line)) {
        expect(line, line.trim()).not.toMatch(/uZoom|uDpr|worldPerPx/)
      }
    }
  })

  it('holds still, and needs no texture, derivative or branch', () => {
    for (const banned of [/\bif\s*\(/, /texture2D/, /fwidth\s*\(/, /\biTime\b/]) {
      expect(code, String(banned)).not.toMatch(banned)
    }
    expect(code).not.toMatch(/\bfor\s*\(/)
  })
})
