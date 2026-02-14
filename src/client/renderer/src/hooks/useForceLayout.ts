import { useCallback, useEffect, useRef, useState } from 'react'
import type { TreeNode } from './useTerminalManager'
import { nodePixelSize } from './useTerminalManager'
import { nodeCenter } from '../lib/tree-placement'
import {
  ROOT_NODE_RADIUS,
  CHILD_PLACEMENT_DISTANCE,
  FORCE_REPULSION_STRENGTH,
  FORCE_ATTRACTION_STRENGTH,
  FORCE_PADDING,
  FORCE_DEFAULT_SPEED,
  FORCE_MIN_SPEED,
  FORCE_MAX_SPEED
} from '../lib/constants'

interface Body {
  id: string
  cx: number
  cy: number
  hw: number
  hh: number
  parentId: string
  fixed: boolean
  dragging: boolean
  fx: number
  fy: number
}

interface ForceLayoutOptions {
  nodesRef: React.RefObject<TreeNode[]>
  draggingRef: React.RefObject<Set<string>>
  batchMoveNodes: (moves: Array<{ id: string; dx: number; dy: number }>) => void
}

export function useForceLayout(opts: ForceLayoutOptions) {
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(FORCE_DEFAULT_SPEED)
  const playingRef = useRef(playing)
  playingRef.current = playing
  const speedRef = useRef(speed)
  speedRef.current = speed
  const optsRef = useRef(opts)
  optsRef.current = opts

  useEffect(() => {
    let lastTime = 0
    let rafId = 0

    const tick = (now: number) => {
      rafId = requestAnimationFrame(tick)

      if (!playingRef.current) {
        lastTime = now
        return
      }

      if (lastTime === 0) {
        lastTime = now
        return
      }

      const dt = Math.min((now - lastTime) / 1000, 0.05) // cap at 50ms
      lastTime = now

      const { nodesRef, draggingRef, batchMoveNodes } = optsRef.current
      const nodes = nodesRef.current
      if (!nodes || nodes.length === 0) return

      // Build bodies
      const bodies: Body[] = []

      // Root node as fixed body
      bodies.push({
        id: 'root',
        cx: 0,
        cy: 0,
        hw: ROOT_NODE_RADIUS,
        hh: ROOT_NODE_RADIUS,
        parentId: '',
        fixed: true,
        dragging: false,
        fx: 0,
        fy: 0
      })

      const dragging = draggingRef.current
      for (const node of nodes) {
        const size = nodePixelSize(node)
        const center = nodeCenter(node.x, node.y, size.width, size.height)
        bodies.push({
          id: node.id,
          cx: center.x,
          cy: center.y,
          hw: size.width / 2,
          hh: size.height / 2,
          parentId: node.parentId,
          fixed: false,
          dragging: dragging.has(node.id),
          fx: 0,
          fy: 0
        })
      }

      // Repulsive forces (all pairs)
      for (let i = 0; i < bodies.length; i++) {
        for (let j = i + 1; j < bodies.length; j++) {
          const a = bodies[i]
          const b = bodies[j]

          // Check AABB overlap with padding
          const overlapX = (a.hw + b.hw + FORCE_PADDING) - Math.abs(a.cx - b.cx)
          const overlapY = (a.hh + b.hh + FORCE_PADDING) - Math.abs(a.cy - b.cy)

          if (overlapX <= 0 || overlapY <= 0) continue

          // Push apart proportional to overlap along center-to-center vector
          let dx = b.cx - a.cx
          let dy = b.cy - a.cy
          const dist = Math.sqrt(dx * dx + dy * dy)

          if (dist < 0.1) {
            // Nodes at same position - push along axis of minimum overlap
            // Use index comparison for deterministic opposite directions
            if (overlapX <= overlapY) {
              dx = i < j ? 1 : -1
              dy = 0
            } else {
              dx = 0
              dy = i < j ? 1 : -1
            }
          } else {
            dx /= dist
            dy /= dist
          }

          const overlap = Math.min(overlapX, overlapY)
          const force = overlap * FORCE_REPULSION_STRENGTH

          a.fx -= dx * force
          a.fy -= dy * force
          b.fx += dx * force
          b.fy += dy * force
        }
      }

      // Attractive forces (parent-child edges)
      const bodyMap = new Map(bodies.map(b => [b.id, b]))
      for (const body of bodies) {
        if (body.id === 'root') continue
        const parent = bodyMap.get(body.parentId)
        if (!parent) continue

        const dx = parent.cx - body.cx
        const dy = parent.cy - body.cy
        const dist = Math.sqrt(dx * dx + dy * dy)

        if (dist <= CHILD_PLACEMENT_DISTANCE) continue

        const excess = dist - CHILD_PLACEMENT_DISTANCE
        const nx = dx / dist
        const ny = dy / dist
        const force = excess * FORCE_ATTRACTION_STRENGTH

        // 100% to child, 20% counter-force to parent
        body.fx += nx * force
        body.fy += ny * force
        parent.fx -= nx * force * 0.2
        parent.fy -= ny * force * 0.2
      }

      // Compute mass for each body: 1 + number of descendants in subtree.
      // Heavier nodes (with more children) resist movement, so children
      // spread out around their parent rather than pushing the parent away.
      const mass = new Map<string, number>()
      for (const body of bodies) mass.set(body.id, 1)
      for (const body of bodies) {
        if (body.fixed) continue
        let ancestorId = body.parentId
        while (ancestorId) {
          mass.set(ancestorId, (mass.get(ancestorId) ?? 1) + 1)
          const ancestor = bodyMap.get(ancestorId)
          if (!ancestor) break
          ancestorId = ancestor.parentId
        }
      }

      // Apply forces with speed cap
      const maxSpeed = speedRef.current
      const moves: Array<{ id: string; dx: number; dy: number }> = []

      for (const body of bodies) {
        if (body.fixed || body.dragging) continue
        if (Math.abs(body.fx) < 0.01 && Math.abs(body.fy) < 0.01) continue

        const m = mass.get(body.id) ?? 1
        let moveX = (body.fx / m) * dt
        let moveY = (body.fy / m) * dt

        // Cap displacement at maxSpeed * dt
        const moveDist = Math.sqrt(moveX * moveX + moveY * moveY)
        const maxDisplacement = maxSpeed * dt
        if (moveDist > maxDisplacement) {
          moveX = (moveX / moveDist) * maxDisplacement
          moveY = (moveY / moveDist) * maxDisplacement
        }

        // Skip negligible moves
        if (moveDist < 0.05) continue

        moves.push({ id: body.id, dx: moveX, dy: moveY })
      }

      if (moves.length > 0) {
        batchMoveNodes(moves)
      }
    }

    rafId = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafId)
  }, [])

  const togglePlaying = useCallback(() => {
    setPlaying(p => !p)
  }, [])

  const increaseSpeed = useCallback(() => {
    setSpeed(s => Math.min(s * 2, FORCE_MAX_SPEED))
  }, [])

  const decreaseSpeed = useCallback(() => {
    setSpeed(s => Math.max(s / 2, FORCE_MIN_SPEED))
  }, [])

  return { playing, speed, togglePlaying, increaseSpeed, decreaseSpeed }
}
