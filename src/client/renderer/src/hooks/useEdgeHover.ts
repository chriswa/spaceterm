import { useCallback, useEffect, useRef, useState } from 'react'
import type { Camera } from '../lib/camera'
import type { TreeLineNode } from '../components/CanvasBackground'
import { EDGE_HOVER_THRESHOLD_PX, EDGE_SPLIT_NODE_MARGIN_PX, ROOT_NODE_RADIUS } from '../lib/constants'
import { useNodeStore, nodePixelSize } from '../stores/nodeStore'

export interface HoveredEdge {
  parentId: string
  childId: string
  point: { x: number; y: number }
}

function findClosestEdge(
  screenX: number,
  screenY: number,
  viewportRect: DOMRect,
  cam: Camera,
  edges: TreeLineNode[]
): HoveredEdge | null {
  const canvasX = (screenX - viewportRect.left - cam.x) / cam.z
  const canvasY = (screenY - viewportRect.top - cam.y) / cam.z
  const threshold = EDGE_HOVER_THRESHOLD_PX / cam.z

  // Prebuild position lookup map to avoid O(n) find per edge
  const posMap = new Map<string, { x: number; y: number }>()
  for (const edge of edges) {
    posMap.set(edge.id, { x: edge.x, y: edge.y })
  }

  let bestEdge: TreeLineNode | null = null
  let bestDist = Infinity
  let bestPoint = { x: 0, y: 0 }

  for (const edge of edges) {
    // Determine parent position
    let ax: number, ay: number
    if (edge.parentId === 'root') {
      ax = 0
      ay = 0
    } else {
      const parent = posMap.get(edge.parentId)
      if (!parent) continue
      ax = parent.x
      ay = parent.y
    }

    const bx = edge.x
    const by = edge.y

    // Phase 1: AABB cull
    const minX = Math.min(ax, bx) - threshold
    const maxX = Math.max(ax, bx) + threshold
    const minY = Math.min(ay, by) - threshold
    const maxY = Math.max(ay, by) + threshold
    if (canvasX < minX || canvasX > maxX || canvasY < minY || canvasY > maxY) continue

    // Phase 2: Closest point on segment
    const dx = bx - ax
    const dy = by - ay
    const lenSq = dx * dx + dy * dy
    if (lenSq === 0) continue

    const t = Math.max(0, Math.min(1, ((canvasX - ax) * dx + (canvasY - ay) * dy) / lenSq))
    const px = ax + t * dx
    const py = ay + t * dy
    const dist = Math.sqrt((canvasX - px) * (canvasX - px) + (canvasY - py) * (canvasY - py))

    if (dist < threshold && dist < bestDist) {
      bestDist = dist
      bestEdge = edge
      bestPoint = { x: px, y: py }
    }
  }

  if (!bestEdge) return null

  // Node proximity guard: suppress split indicator near any existing node
  const m = EDGE_SPLIT_NODE_MARGIN_PX
  const allNodes = useNodeStore.getState().nodeList
  for (const node of allNodes) {
    const size = nodePixelSize(node)
    const hw = size.width / 2
    const hh = size.height / 2
    if (
      bestPoint.x >= node.x - hw - m && bestPoint.x <= node.x + hw + m &&
      bestPoint.y >= node.y - hh - m && bestPoint.y <= node.y + hh + m
    ) {
      return null
    }
  }
  // Also check the root node at (0,0)
  const rr = ROOT_NODE_RADIUS
  if (
    bestPoint.x >= -rr - m && bestPoint.x <= rr + m &&
    bestPoint.y >= -rr - m && bestPoint.y <= rr + m
  ) {
    return null
  }

  return { parentId: bestEdge.parentId, childId: bestEdge.id, point: bestPoint }
}

/**
 * Detects mouse proximity to parent→child edges on the canvas.
 * Recalculates every frame (via rAF) so it stays correct during pan/zoom.
 * Ignores mouse events over .canvas-node elements.
 */
export function useEdgeHover(
  cameraRef: React.RefObject<Camera>,
  edgesRef: React.RefObject<TreeLineNode[]>,
  reparentActive: boolean
) {
  const [hoveredEdge, setHoveredEdge] = useState<HoveredEdge | null>(null)
  const hoveredEdgeRef = useRef<HoveredEdge | null>(null)
  // Track last known screen-space mouse position and whether mouse is over a node
  const mouseScreenRef = useRef<{ x: number; y: number } | null>(null)
  const overNodeRef = useRef(false)

  // Track mouse position and whether it's over a canvas node
  useEffect(() => {
    const viewport = document.querySelector('.canvas-viewport') as HTMLElement | null
    if (!viewport) return

    const onMouseMove = (e: MouseEvent) => {
      mouseScreenRef.current = { x: e.clientX, y: e.clientY }
      // Check if the mouse target is inside a canvas-node
      const target = e.target as HTMLElement
      overNodeRef.current = !!target.closest('.canvas-node')
    }

    const onMouseLeave = () => {
      mouseScreenRef.current = null
    }

    viewport.addEventListener('mousemove', onMouseMove)
    viewport.addEventListener('mouseleave', onMouseLeave)
    return () => {
      viewport.removeEventListener('mousemove', onMouseMove)
      viewport.removeEventListener('mouseleave', onMouseLeave)
    }
  }, [])

  // rAF loop: recalculate edge hover every frame
  const lastInputRef = useRef<{ mx: number; my: number; cx: number; cy: number; cz: number } | null>(null)

  useEffect(() => {
    if (reparentActive) {
      if (hoveredEdgeRef.current) {
        hoveredEdgeRef.current = null
        setHoveredEdge(null)
      }
      lastInputRef.current = null
      return
    }

    let rafId: number

    const tick = () => {
      rafId = requestAnimationFrame(tick)

      const mouse = mouseScreenRef.current
      if (!mouse || overNodeRef.current) {
        if (hoveredEdgeRef.current) {
          hoveredEdgeRef.current = null
          setHoveredEdge(null)
        }
        lastInputRef.current = null
        return
      }

      const cam = cameraRef.current
      const edges = edgesRef.current
      if (!cam || !edges || edges.length === 0) {
        if (hoveredEdgeRef.current) {
          hoveredEdgeRef.current = null
          setHoveredEdge(null)
        }
        lastInputRef.current = null
        return
      }

      // Skip computation if mouse and camera haven't changed
      const last = lastInputRef.current
      if (last && last.mx === mouse.x && last.my === mouse.y && last.cx === cam.x && last.cy === cam.y && last.cz === cam.z) {
        return
      }
      lastInputRef.current = { mx: mouse.x, my: mouse.y, cx: cam.x, cy: cam.y, cz: cam.z }

      const viewport = document.querySelector('.canvas-viewport') as HTMLElement | null
      if (!viewport) return
      const rect = viewport.getBoundingClientRect()

      const result = findClosestEdge(mouse.x, mouse.y, rect, cam, edges)

      if (result) {
        const prev = hoveredEdgeRef.current
        if (!prev || prev.parentId !== result.parentId || prev.childId !== result.childId || prev.point.x !== result.point.x || prev.point.y !== result.point.y) {
          hoveredEdgeRef.current = result
          setHoveredEdge(result)
        }
      } else if (hoveredEdgeRef.current) {
        hoveredEdgeRef.current = null
        setHoveredEdge(null)
      }
    }

    rafId = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafId)
  }, [cameraRef, edgesRef, reparentActive])

  const clearHoveredEdge = useCallback(() => {
    hoveredEdgeRef.current = null
    setHoveredEdge(null)
  }, [])

  return { hoveredEdge, hoveredEdgeRef, clearHoveredEdge }
}
