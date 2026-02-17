import type { NodeData } from '../shared/state'
import {
  nodePixelSize,
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

function nodeCenter(node: NodeData): { x: number; y: number } {
  const size = nodePixelSize(node)
  return { x: node.x + size.width / 2, y: node.y + size.height / 2 }
}

function nodeRect(node: NodeData): Rect {
  const size = nodePixelSize(node)
  return {
    cx: node.x + size.width / 2,
    cy: node.y + size.height / 2,
    hw: size.width / 2,
    hh: size.height / 2
  }
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

function buildRects(nodes: Record<string, NodeData>): Rect[] {
  const rects: Rect[] = []
  for (const node of Object.values(nodes)) {
    rects.push(nodeRect(node))
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

// --- Main placement ---

export function computePlacement(
  nodes: Record<string, NodeData>,
  parentId: string,
  newNodeSize: { width: number; height: number },
  positionHint?: { x: number; y: number }
): { x: number; y: number } {
  const existingRects = buildRects(nodes)
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
    parentCx = parent.x + pSize.width / 2
    parentCy = parent.y + pSize.height / 2
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
    const hintRect: Rect = { cx: positionHint.x + newHW, cy: positionHint.y + newHH, hw: newHW, hh: newHH }
    const overlaps = existingRects.some(r => rectsOverlap(r, hintRect, PLACEMENT_MARGIN))
    if (!overlaps) {
      return positionHint
    }
    // Search nearby positions around the hint
    const hintCx = positionHint.x + newHW
    const hintCy = positionHint.y + newHH
    for (const dist of [100, 200, 300]) {
      for (let i = 0; i < 12; i++) {
        const angle = (i / 12) * Math.PI * 2
        const cx = hintCx + Math.cos(angle) * dist
        const cy = hintCy + Math.sin(angle) * dist
        const candidateRect: Rect = { cx, cy, hw: newHW, hh: newHH }
        if (!existingRects.some(r => rectsOverlap(r, candidateRect, PLACEMENT_MARGIN))) {
          return { x: cx - newHW, y: cy - newHH }
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
  let bestPos = { x: parentCx - newHW, y: parentCy - newHH } // fallback
  let fallbackPos = bestPos

  for (const dist of distanceRings) {
    for (let step = 0; step < ANGLE_STEPS; step++) {
      // Sweep outward from best angle in both directions
      const offsetAngle = Math.ceil(step / 2) * ANGLE_INCREMENT * (step % 2 === 0 ? 1 : -1)
      const angle = startAngle + offsetAngle

      const cx = parentCx + Math.cos(angle) * dist
      const cy = parentCy + Math.sin(angle) * dist
      const candidateRect: Rect = { cx, cy, hw: newHW, hh: newHH }

      // Hard reject: overlap with existing node
      if (existingRects.some(r => rectsOverlap(r, candidateRect, PLACEMENT_MARGIN))) {
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

      const score = edgeOcclusion * 2 + gpPenalty * 5 + distToParent * 0.1

      if (score < bestScore) {
        bestScore = score
        bestPos = { x: cx - newHW, y: cy - newHH }
      }
    }

    // Update fallback to farthest ring at best angle
    const fbCx = parentCx + Math.cos(startAngle) * dist
    const fbCy = parentCy + Math.sin(startAngle) * dist
    fallbackPos = { x: fbCx - newHW, y: fbCy - newHH }
  }

  // If no valid candidate found (all rejected), use fallback
  if (bestScore === Infinity) {
    return fallbackPos
  }

  return bestPos
}
