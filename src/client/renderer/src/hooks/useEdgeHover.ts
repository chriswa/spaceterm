import { useEffect, useRef, useState } from 'react'
import type { Camera } from '../lib/camera'
import type { TreeLineNode } from '../components/CanvasBackground'
import { EDGE_HOVER_THRESHOLD_PX } from '../lib/constants'

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
      const parent = edges.find(n => n.id === edge.parentId)
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
  edgesEnabled: boolean,
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
  useEffect(() => {
    if (!edgesEnabled || reparentActive) {
      if (hoveredEdgeRef.current) {
        hoveredEdgeRef.current = null
        setHoveredEdge(null)
      }
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
        return
      }

      const cam = cameraRef.current
      const edges = edgesRef.current
      if (!cam || !edges || edges.length === 0) {
        if (hoveredEdgeRef.current) {
          hoveredEdgeRef.current = null
          setHoveredEdge(null)
        }
        return
      }

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
  }, [cameraRef, edgesRef, edgesEnabled, reparentActive])

  return { hoveredEdge, hoveredEdgeRef }
}
