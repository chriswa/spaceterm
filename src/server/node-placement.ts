import type { NodeData } from '../shared/state'
import { measureCard as nodePixelSize } from '../shared/card-types'
import { agentCaptionReserve, layOutNodeLabel, layOutStatusLabel, type CaptionReserve } from '../shared/node-label'
import {
  terminalPixelSize,
  ROOT_NODE_RADIUS,
  PLACEMENT_MARGIN,
  DEFAULT_COLS,
  DEFAULT_ROWS
} from '../shared/node-size'

// --- Geometry types ---

interface Rect {
  cx: number
  cy: number
  hw: number // half-width
  hh: number // half-height
}

interface Edge {
  x1: number
  y1: number
  x2: number
  y2: number
}

// --- Helpers ---
//
// Every position in this module — node.x/y, the `position` and `positionHint`
// arguments, and the returned point — is a card centre, matching how the
// renderer draws cards.

function nodeCenter(node: NodeData): { x: number; y: number } {
  return { x: node.x, y: node.y }
}

function nodeRect(node: NodeData): Rect {
  const size = nodePixelSize(node)
  return { cx: node.x, cy: node.y, hw: size.width / 2, hh: size.height / 2 }
}

function rectsOverlap(a: Rect, b: Rect, margin: number): boolean {
  return (
    Math.abs(a.cx - b.cx) < a.hw + b.hw + margin &&
    Math.abs(a.cy - b.cy) < a.hh + b.hh + margin
  )
}

function pointToSegmentDistance(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1
  const dy = y2 - y1
  const lenSq = dx * dx + dy * dy
  if (lenSq === 0) return Math.hypot(px - x1, py - y1)
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lenSq))
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))
}

// --- Spatial context ---

/**
 * Everything a new card must keep clear of: each card, plus the captions drawn
 * above and below it. Captions are laid out with the renderer's own functions,
 * so the space reserved is the space drawn. A status caption's text depends on
 * the clock, hence `now`.
 */
function buildRects(nodes: Record<string, NodeData>, now: number): Rect[] {
  const rects: Rect[] = []
  for (const node of Object.values(nodes)) {
    rects.push(nodeRect(node))
    for (const label of [layOutNodeLabel(node), layOutStatusLabel(node, now)]) {
      if (label) rects.push({ cx: label.x, cy: label.y, hw: label.width / 2, hh: label.height / 2 })
    }
  }
  return rects
}

function buildEdges(nodes: Record<string, NodeData>): Edge[] {
  const edges: Edge[] = []
  for (const node of Object.values(nodes)) {
    let parentCenter: { x: number; y: number }
    if (node.parentId === 'root') {
      parentCenter = { x: 0, y: 0 }
    } else {
      const parent = nodes[node.parentId]
      if (!parent) continue
      parentCenter = nodeCenter(parent)
    }
    const childCenter = nodeCenter(node)
    edges.push({ x1: parentCenter.x, y1: parentCenter.y, x2: childCenter.x, y2: childCenter.y })
  }
  return edges
}

// --- Angular gap heuristic (ported from tree-placement.ts) ---

function bestAngle(
  parentCenter: { x: number; y: number },
  grandparentCenter: { x: number; y: number } | null,
  siblingCenters: { x: number; y: number }[]
): number {
  const TWO_PI = Math.PI * 2
  const normalize = (a: number) => ((a % TWO_PI) + TWO_PI) % TWO_PI

  const avoidAngle = grandparentCenter
    ? Math.atan2(grandparentCenter.y - parentCenter.y, grandparentCenter.x - parentCenter.x)
    : Math.PI / 2

  const siblingAngles = siblingCenters.map(s =>
    normalize(Math.atan2(s.y - parentCenter.y, s.x - parentCenter.x))
  )

  if (siblingAngles.length === 0) {
    return normalize(avoidAngle + Math.PI)
  }

  const occupied = [
    ...siblingAngles,
    normalize(avoidAngle),
    normalize(avoidAngle + 0.01),
    normalize(avoidAngle - 0.01)
  ]
  occupied.sort((a, b) => a - b)

  let bestGap = 0
  let bestMid = 0
  for (let i = 0; i < occupied.length; i++) {
    const next = i + 1 < occupied.length ? occupied[i + 1] : occupied[0] + TWO_PI
    const gap = next - occupied[i]
    if (gap > bestGap) {
      bestGap = gap
      bestMid = occupied[i] + gap / 2
    }
  }

  return normalize(bestMid)
}

// --- New node footprint ---

/**
 * The card being placed, plus any space it should keep free around itself for
 * captions it does not have yet — see `agentCaptionReserve`.
 */
export interface NewNodeFootprint {
  width: number
  height: number
  reserved?: readonly CaptionReserve[]
}

/** The rects a new node would occupy with its card centred at (cx, cy). */
/** An agent surface of `cols` × `rows`, with room kept for its name and status captions. */
export function agentSurfaceFootprint(cols: number, rows: number): NewNodeFootprint {
  const card = terminalPixelSize(cols, rows)
  return { ...card, reserved: agentCaptionReserve(card) }
}

function footprintRects(footprint: NewNodeFootprint, cx: number, cy: number): Rect[] {
  const rects: Rect[] = [{ cx, cy, hw: footprint.width / 2, hh: footprint.height / 2 }]
  for (const r of footprint.reserved ?? []) {
    rects.push({ cx: cx + r.dx, cy: cy + r.dy, hw: r.width / 2, hh: r.height / 2 })
  }
  return rects
}

function collides(existing: readonly Rect[], candidate: readonly Rect[]): boolean {
  return candidate.some(c => existing.some(r => rectsOverlap(r, c, PLACEMENT_MARGIN)))
}

// --- Fit check ---

export function canFitAt(
  nodes: Record<string, NodeData>,
  position: { x: number; y: number },
  footprint: NewNodeFootprint,
  now = Date.now()
): boolean {
  return !collides(buildRects(nodes, now), footprintRects(footprint, position.x, position.y))
}

// --- Main placement ---

export function computePlacement(
  nodes: Record<string, NodeData>,
  parentId: string,
  newNodeSize: NewNodeFootprint,
  positionHint?: { x: number; y: number },
  now = Date.now()
): { x: number; y: number } {
  const existingRects = buildRects(nodes, now)
  const existingEdges = buildEdges(nodes)

  // Parent center
  let parentCx: number
  let parentCy: number
  let parentHW: number
  let parentHH: number

  if (parentId === 'root') {
    parentCx = 0
    parentCy = 0
    parentHW = ROOT_NODE_RADIUS
    parentHH = ROOT_NODE_RADIUS
  } else {
    const parent = nodes[parentId]
    if (!parent) {
      return { x: 0, y: 0 }
    }
    const pSize = nodePixelSize(parent)
    parentCx = parent.x
    parentCy = parent.y
    parentHW = pSize.width / 2
    parentHH = pSize.height / 2
  }

  // Grandparent center
  let grandparentCenter: { x: number; y: number } | null = null
  if (parentId !== 'root') {
    const parent = nodes[parentId]
    if (parent) {
      if (parent.parentId === 'root') {
        grandparentCenter = { x: 0, y: 0 }
      } else {
        const gp = nodes[parent.parentId]
        if (gp) {
          grandparentCenter = nodeCenter(gp)
        }
      }
    }
  }

  // New node half-extents
  const newHW = newNodeSize.width / 2
  const newHH = newNodeSize.height / 2

  // Ideal placement distance
  const parentHalfDiag = parentId === 'root' ? ROOT_NODE_RADIUS : Math.hypot(parentHW, parentHH)
  const newHalfDiag = Math.hypot(newHW, newHH)
  const defaultTermSize = terminalPixelSize(DEFAULT_COLS, DEFAULT_ROWS)
  const defaultTermHalfDiag = Math.hypot(defaultTermSize.width / 2, defaultTermSize.height / 2)
  const idealDist = Math.max(
    parentHalfDiag + newHalfDiag + 2 * PLACEMENT_MARGIN,
    2 * defaultTermHalfDiag + PLACEMENT_MARGIN
  )

  // Position hint handling (for edge-split)
  if (positionHint) {
    if (!collides(existingRects, footprintRects(newNodeSize, positionHint.x, positionHint.y))) {
      return positionHint
    }
    // Search nearby positions around the hint
    const hintCx = positionHint.x
    const hintCy = positionHint.y
    for (const dist of [100, 200, 300]) {
      for (let i = 0; i < 12; i++) {
        const angle = (i / 12) * Math.PI * 2
        const cx = hintCx + Math.cos(angle) * dist
        const cy = hintCy + Math.sin(angle) * dist
        if (!collides(existingRects, footprintRects(newNodeSize, cx, cy))) {
          return { x: cx, y: cy }
        }
      }
    }
    // Fallback: use the hint as-is
    return positionHint
  }

  // Sibling centers for angular gap
  const siblingCenters: { x: number; y: number }[] = []
  for (const node of Object.values(nodes)) {
    if (node.parentId === parentId) {
      siblingCenters.push(nodeCenter(node))
    }
  }

  const startAngle = bestAngle({ x: parentCx, y: parentCy }, grandparentCenter, siblingCenters)

  // Generate candidates via radial sweep
  const ANGLE_STEPS = 36
  const ANGLE_INCREMENT = (Math.PI * 2) / ANGLE_STEPS
  const distanceRings = [idealDist, idealDist * 1.25, idealDist * 1.5, idealDist * 2, idealDist * 3, idealDist * 4]

  let bestScore = Infinity
  let bestPos = { x: parentCx, y: parentCy } // fallback
  let fallbackPos = bestPos

  for (const dist of distanceRings) {
    for (let step = 0; step < ANGLE_STEPS; step++) {
      // Sweep outward from best angle in both directions
      const offsetAngle = Math.ceil(step / 2) * ANGLE_INCREMENT * (step % 2 === 0 ? 1 : -1)
      const angle = startAngle + offsetAngle

      const cx = parentCx + Math.cos(angle) * dist
      const cy = parentCy + Math.sin(angle) * dist
      // Hard reject: overlap with an existing node or caption
      if (collides(existingRects, footprintRects(newNodeSize, cx, cy))) {
        continue
      }

      // Score: edge occlusion (soft, weight=2)
      let edgeOcclusion = 0
      const occlusionThreshold = newHalfDiag + 30
      for (const edge of existingEdges) {
        const d = pointToSegmentDistance(cx, cy, edge.x1, edge.y1, edge.x2, edge.y2)
        if (d < occlusionThreshold) {
          edgeOcclusion += occlusionThreshold - d
        }
      }

      // Score: grandparent proximity (soft, weight=5)
      let gpPenalty = 0
      if (grandparentCenter) {
        const distToGP = Math.hypot(cx - grandparentCenter.x, cy - grandparentCenter.y)
        const distToParent = Math.hypot(cx - parentCx, cy - parentCy)
        const threshold = distToParent * 1.2
        if (distToGP < threshold) {
          gpPenalty = threshold - distToGP
        }
      }

      // Score: distance from parent (soft, weight=0.1) — prefer closer
      const distToParent = Math.hypot(cx - parentCx, cy - parentCy)

      // Score: deviation from the preferred angle (soft, weight=10 per radian).
      // Without it every clear candidate on a ring ties, and floating-point
      // noise in the other terms decides which side of the parent wins.
      const deviation = Math.abs(offsetAngle)

      const score = edgeOcclusion * 2 + gpPenalty * 5 + distToParent * 0.1 + deviation * 10

      if (score < bestScore) {
        bestScore = score
        bestPos = { x: cx, y: cy }
      }
    }

    // Update fallback to farthest ring at best angle
    const fbCx = parentCx + Math.cos(startAngle) * dist
    const fbCy = parentCy + Math.sin(startAngle) * dist
    fallbackPos = { x: fbCx, y: fbCy }
  }

  // If no valid candidate found (all rejected), use fallback
  if (bestScore === Infinity) {
    return fallbackPos
  }

  return bestPos
}
