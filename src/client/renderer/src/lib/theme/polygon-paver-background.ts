/**
 * Hex Pavers and Triangle Pavers: the Pavers stone laid as a honeycomb, or as
 * concentric rings of triangles.
 *
 * Same palette, grain, joint, chamfer, warp and fade as `./paver-background`
 * — only the cut differs, so a retune of the stone there is a retune here.
 *
 * ## Triangles
 *
 * Pavers' own courses, each a ring of triangles alternating point-out and
 * point-in: one pair per stone Pavers would lay, the point-out ones standing
 * on the inner edge of the course and meeting its outer edge in a point. Any
 * whole number of pairs closes the ring, so this is exact in every course. The
 * target aspect is the equilateral one, `2 / sqrt(3)` — a base that much
 * longer than the course is deep.
 *
 * ## Hexagons
 *
 * A honeycomb interlocks only between rows of the same count, so every ring
 * of hexagons has the same number, `HEX_COUNT`, and each ring is the last one
 * scaled up. In practice that is a regular honeycomb laid in log-polar
 * coordinates: `ln r` up, angle across, both measured in hexagons. The map is
 * conformal, so every stone is very nearly a regular hexagon; rings of them
 * run round the root node, and every other ring's stones sit on the same
 * spokes, so the floor reads as radial lines of hexagons opening outward.
 *
 * The price is how fast they open: a stone's size goes as `r` itself, not
 * Pavers' `r ** 0.25`. Ten times further out is ten times larger. So the
 * joint, corners and chamfer grow with the stone, unlike Pavers' fixed ones,
 * and the floor is self-similar: every ring is the one inside it, scaled.
 */

import { ROOT_DISC_RADIUS } from '../../../../../shared/node-size'
import {
  PAVER_COURSE_GLSL,
  PAVER_WARP_GLSL,
  paverCourseConstsGlsl,
  paverFinishGlsl,
  paverPreludeGlsl,
} from './paver-background'

/**
 * How much wider than deep a triangle aims to be: the proportion at which a
 * triangle on the course's depth is equilateral.
 */
const TRIANGLE_ASPECT = 2 / Math.sqrt(3)

/**
 * Hexagons in every ring. Any whole number closes the ring. Fixes how large
 * a stone is at a given radius — `TAU * r / HEX_COUNT` across the flats — so
 * this is the hex floor's one scale control: about 55 units across at the root
 * disc's rim, 175 at a thousand units out, and a screen's width some eight
 * thousand out.
 *
 * It also sets how true the hexagons are. Each ring is `exp(TAU * sqrt(3) /
 * (2 * HEX_COUNT))` times the size of the one inside it — 16% at 36 — and a
 * stone is that much larger across its outer edge than its inner. At 24 that
 * is 25%, and the stones read as pentagons.
 */
const HEX_COUNT = 36

/**
 * The stone width, across the flats, at which the joint, corners and chamfer
 * are Pavers' sizes. They scale with the stone from there, in or out, so this
 * fixes their share of it: a joint 12 units wide is 5% of a 240-unit stone.
 */
const HEX_JOINT_AT = 240

const SQRT3 = Math.sqrt(3)

/** The hexagons, from `void main` on. Declares what `paverFinishGlsl` expects. */
const HEX_MAIN_GLSL = `
  // The honeycomb's coordinates: across, the angle, and up, ln r — both in
  // hexagons, so one unit is a stone's width either way and the map is
  // conformal. One unit is scale world units here, which grows with r.
  float hx = theta * HEX_PER_RADIAN;
  float hy = log2(r * INV_RIM) * HEX_PER_LOG2;
  float scale = r / HEX_PER_RADIAN;
  vec2 hp = vec2(hx, hy);

  // The nearest hexagon centre. The lattice is the union of two rectangular
  // ones, (i, j sqrt3) and (i + 1/2, (j + 1/2) sqrt3): rings half a hexagon
  // apart in turn, so every other ring sits on the same spokes.
  vec2 S = vec2(1.0, SQRT3);
  vec2 ca = floor(hp / S + 0.5) * S;
  vec2 cb = (floor(hp / S) + 0.5) * S;
  vec2 da = hp - ca;
  vec2 db = hp - cb;
  float useB = step(dot(db, db), dot(da, da));
  vec2 local = mix(da, db, useB);
  float ring = mix(2.0 * floor(hp.y / SQRT3 + 0.5), 2.0 * floor(hp.y / SQRT3) + 1.0, useB);
  float spoke = mod(floor(mix(ca.x, cb.x, useB)), HEX_COUNT);
  vec3 id = hash32(vec2(spoke, ring));

  // The stone's own frame, in world units: across the ring, and out along it.
  vec2 p = local * scale;
  float hw = 0.5 * scale;

  // The joint, corners and chamfer, in proportion to the stone.
  float fit = scale / JOINT_AT;
  float inset = (JOINT + (id.x - 0.5) * 6.0 + CORNER) * fit;
  float d = sdHexagon(p.yx, max(hw - inset, 1.0)) - CORNER * fit;

  // The edge the pixel is nearest, which the chamfer faces along. Mitred at
  // the corners, as a cut chamfer is.
  vec3 proj = vec3(dot(p, N0), dot(p, N1), dot(p, N2));
  vec3 ap = abs(proj);
  float onB = step(ap.x, ap.y) * step(ap.z, ap.y);
  float onC = (1.0 - onB) * step(ap.x, ap.z);
  float onA = 1.0 - onB - onC;
  vec2 nrm = (N0 * onA + N1 * onB + N2 * onC) * sign(dot(proj, vec3(onA, onB, onC)) + 1e-9);

  // The light in the same frame: across the ring, and out.
  vec2 radial = warped / r;
  vec2 tangent = vec2(-radial.y, radial.x);
  float facing = dot(nrm, vec2(dot(LIGHT, tangent), dot(LIGHT, radial)));

  // Retired before the stones go sub-pixel, against the stone's own size.
  float quietStone = smoothstep(scale / 3.0, scale / 14.0, worldPerPx);

  // Every BANDth ring is laid darker — a soldier course.
  float band = 1.0 - min(mod(ring, BAND), 1.0);
  float bandWave = abs(fract(hp.y / (0.5 * SQRT3 * BAND)) - 0.5) * 2.0;
`

export const HEX_PAVER_BG_FRAG = `${paverPreludeGlsl(null)}
const float SQRT3 = ${SQRT3.toFixed(7)};
const float HEX_COUNT = ${HEX_COUNT}.0;
/** Hexagons per radian round a ring, and per doubling of r outward. */
const float HEX_PER_RADIAN = ${(HEX_COUNT / (2 * Math.PI)).toFixed(7)};
const float HEX_PER_LOG2 = ${((HEX_COUNT / (2 * Math.PI)) * Math.LN2).toFixed(7)};
/** 1 / the root disc's radius: ln r is measured from the rim. */
const float INV_RIM = ${(1 / ROOT_DISC_RADIUS).toFixed(9)};
const float JOINT_AT = ${HEX_JOINT_AT.toFixed(1)};

/** The hexagon's edge normals, a third of the way round each; the other three are their negatives. */
const vec2 N0 = vec2(1.0, 0.0);
const vec2 N1 = vec2(0.5, 0.866025404);
const vec2 N2 = vec2(-0.5, 0.866025404);

/** Exact distance to a regular hexagon of inradius ri, flat top and bottom. After Inigo Quilez. */
float sdHexagon(vec2 p, float ri) {
  const vec3 k = vec3(-0.866025404, 0.5, 0.577350269);
  p = abs(p);
  p -= 2.0 * min(dot(k.xy, p), 0.0) * k.xy;
  p -= vec2(clamp(p.x, -k.z * ri, k.z * ri), ri);
  return length(p) * sign(p.y);
}

void main() {
${PAVER_WARP_GLSL}
${HEX_MAIN_GLSL}
${paverFinishGlsl(null, 'CHAMFER * fit')}
}
`

export const TRIANGLE_PAVER_BG_FRAG = `${paverPreludeGlsl(null)}
${paverCourseConstsGlsl(TRIANGLE_ASPECT)}

/** Exact distance to a triangle. After Inigo Quilez. */
float sdTriangle(vec2 p, vec2 p0, vec2 p1, vec2 p2) {
  vec2 e0 = p1 - p0, e1 = p2 - p1, e2 = p0 - p2;
  vec2 v0 = p - p0, v1 = p - p1, v2 = p - p2;
  vec2 pq0 = v0 - e0 * clamp(dot(v0, e0) / dot(e0, e0), 0.0, 1.0);
  vec2 pq1 = v1 - e1 * clamp(dot(v1, e1) / dot(e1, e1), 0.0, 1.0);
  vec2 pq2 = v2 - e2 * clamp(dot(v2, e2) / dot(e2, e2), 0.0, 1.0);
  float s = sign(e0.x * e2.y - e0.y * e2.x);
  vec2 d = min(min(vec2(dot(pq0, pq0), s * (v0.x * e0.y - v0.y * e0.x)),
                   vec2(dot(pq1, pq1), s * (v1.x * e1.y - v1.y * e1.x))),
                   vec2(dot(pq2, pq2), s * (v2.x * e2.y - v2.y * e2.x)));
  return -sqrt(d.x) * sign(d.y);
}

void main() {
${PAVER_WARP_GLSL}
${PAVER_COURSE_GLSL}

  // The triangles: the joints run from each stone boundary on the course's
  // inner edge to the middle of the stone on its outer edge, and back. Along
  // m and n those joints are whole numbers; a point-out triangle has the same
  // floor of each, a point-in one is a step further along n.
  float m = a - 0.5 * fy;
  float n = a + 0.5 * fy;
  float tri = floor(m) + floor(n);
  float pointIn = mod(tri, 2.0);
  float cell = mod(tri, 2.0 * count);

  // The triangle's own frame, in world units: across the course from the
  // middle of its base, and up the course from its inner edge.
  float width = TAU * r / count;
  vec2 p = vec2((a - 0.5 * tri - 0.5) * width, fy * depth);
  vec3 id = hash32(vec2(cell, row));

  // The triangle, inset by the joint about its incentre, its corners rounded.
  float up = 1.0 - 2.0 * pointIn;
  float baseY = pointIn * depth;
  float side = sqrt(0.25 * width * width + depth * depth);
  float inr = width * depth / (width + 2.0 * side);
  vec2 incentre = vec2(0.0, baseY + up * inr);
  float inset = JOINT + (id.x - 0.5) * 6.0 + CORNER;
  float shrink = max(inr - inset, 1.0) / inr;
  vec2 v0 = incentre + (vec2(-0.5 * width, baseY) - incentre) * shrink;
  vec2 v1 = incentre + (vec2(0.5 * width, baseY) - incentre) * shrink;
  vec2 v2 = incentre + (vec2(0.0, depth - baseY) - incentre) * shrink;
  float d = sdTriangle(p, v0, v1, v2) - CORNER;

  // The nearest of the three edges, which the chamfer faces along.
  vec2 nBase = vec2(0.0, -up);
  vec2 nLeft = normalize(vec2(-depth, 0.5 * width * up));
  vec2 nRight = normalize(vec2(depth, 0.5 * width * up));
  vec2 rel = p - incentre;
  float eB = dot(rel, nBase);
  float eL = dot(rel, nLeft);
  float eR = dot(rel, nRight);
  vec2 nrm = mix(mix(nRight, nLeft, step(eR, eL)), nBase, step(max(eL, eR), eB));

  // The light in the course's frame: across it, and up it.
  vec2 radial = warped / r;
  vec2 tangent = vec2(-radial.y, radial.x);
  float facing = dot(nrm, vec2(dot(LIGHT, tangent), dot(LIGHT, radial)));


  // Retired before the stones go sub-pixel, against the local course depth.
  float quietStone = smoothstep(depth / 3.0, depth / 14.0, worldPerPx);

  // Every BANDth course is laid darker — a soldier course — as in Pavers.
  float band = 1.0 - min(mod(row, BAND), 1.0);
  float bandWave = abs(fract((v - 0.5) / BAND) - 0.5) * 2.0;
${paverFinishGlsl(null)}
}
`

/** The lattice's parameters, exported so `./polygon-paver-lattice.test` measures the shader's own numbers. */
export const POLYGON_LATTICE = { TRIANGLE_ASPECT, HEX_COUNT, HEX_JOINT_AT } as const
