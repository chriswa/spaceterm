import { useCallback, useEffect, useRef, useState } from 'react'
import type { Camera } from '../lib/camera'
import type { TreeLineNode } from '../components/CanvasBackground'
import { EDGE_HOVER_THRESHOLD_PX, EDGE_SPLIT_NODE_MARGIN_PX, ROOT_NODE_RADIUS } from '../lib/constants'
import { useNodeStore, nodePixelSize } from '../stores/nodeStore'
import { isWindowVisible, onWindowVisibleChange } from './useWindowVisible'
import { type NodeId } from '../../../../shared/ids'

export interface HoveredEdge {
  parentId: NodeId
  childId: NodeId
  point: { x: number; y: number }
}

/**
 * The edge under a screen point, within `thresholdPx` of it on screen — a
 * mouse's hover, or (with a fingertip's wider reach) a long press.
 */
export function findClosestEdge(
  screenX: number,
  screenY: number,
  viewportRect: DOMRect,
  cam: Camera,
  edges: TreeLineNode[],
  thresholdPx = EDGE_HOVER_THRESHOLD_PX
): HoveredEdge | null {
  const canvasX = (screenX - viewportRect.left - cam.x) / cam.z
  const canvasY = (screenY - viewportRect.top - cam.y) / cam.z
  const threshold = thresholdPx / cam.z

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
  cameraRef: React.MutableRefObject<Camera>,
  edgesRef: React.MutableRefObject<TreeLineNode[]>,
  reparentActive: boolean
) {
  const [hoveredEdge, setHoveredEdge] = useState<HoveredEdge | null>(null)
  const hoveredEdgeRef = useRef<HoveredEdge | null>(null)
  // Track last known screen-space mouse position and whether mouse is over a node
  const mouseScreenRef = useRef<{ x: number; y: number } | null>(null)
  /** Starts the hover loop; set by the loop's effect, called when a mouse appears. */
  const wakeLoopRef = useRef<() => void>(() => undefined)
  const overNodeRef = useRef(false)

  // Track mouse position and whether it's over a canvas node
  useEffect(() => {
    const viewport = document.querySelector('.canvas-viewport') as HTMLElement | null
    if (!viewport) return

    // Pointer events, and only a real mouse's. A touch screen fakes a
    // mousemove at every tap and never sends the mouseleave that would end it,
    // so a mouse listener kept a phantom cursor at the last tap point — and as
    // the canvas panned, every edge that slid under it lit up its split dot.
    // A touch now clears the position instead of setting it.
    const onPointerMove = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse') {
        mouseScreenRef.current = null
        return
      }
      mouseScreenRef.current = { x: e.clientX, y: e.clientY }
      wakeLoopRef.current()
      // Check if the mouse target is inside a canvas-node
      const target = e.target as HTMLElement
      overNodeRef.current = !!target.closest('.canvas-node')
    }

    const onPointerDown = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse') mouseScreenRef.current = null
    }

    const onPointerLeave = () => {
      mouseScreenRef.current = null
    }

    viewport.addEventListener('pointermove', onPointerMove)
    viewport.addEventListener('pointerdown', onPointerDown)
    viewport.addEventListener('pointerleave', onPointerLeave)
    return () => {
      viewport.removeEventListener('pointermove', onPointerMove)
      viewport.removeEventListener('pointerdown', onPointerDown)
      viewport.removeEventListener('pointerleave', onPointerLeave)
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

    let rafId = 0

    // Runs only while a mouse is over the canvas: a frame loop that kept
    // going with no pointer would hit-test nothing, sixty times a second,
    // forever — on a touch screen, where there is never a mouse, for the life
    // of the page.
    const tick = () => {
      const mouse = mouseScreenRef.current
      if (!mouse) {
        rafId = 0
        if (hoveredEdgeRef.current) {
          hoveredEdgeRef.current = null
          setHoveredEdge(null)
        }
        lastInputRef.current = null
        return
      }
      rafId = requestAnimationFrame(tick)

      if (overNodeRef.current) {
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

    // Hit-testing every edge against a cursor behind a hidden window is work
    // for a hover that cannot be seen and a click that cannot be made. This
    // loop was the one that never gated on visibility.
    const startLoop = () => { if (!rafId && mouseScreenRef.current && isWindowVisible()) rafId = requestAnimationFrame(tick) }
    const stopLoop = () => { if (rafId) { cancelAnimationFrame(rafId); rafId = 0 } }
    wakeLoopRef.current = startLoop

    const unsubVisibility = onWindowVisibleChange((visible) => {
      if (visible) startLoop(); else stopLoop()
    })
    if (isWindowVisible()) startLoop()

    return () => {
      stopLoop()
      unsubVisibility()
      wakeLoopRef.current = () => undefined
    }
  }, [cameraRef, edgesRef, reparentActive])

  const clearHoveredEdge = useCallback(() => {
    hoveredEdgeRef.current = null
    setHoveredEdge(null)
  }, [])

  return { hoveredEdge, hoveredEdgeRef, clearHoveredEdge }
}
