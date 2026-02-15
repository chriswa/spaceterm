export interface TreeLineNode {
  id: string
  parentId: string
  x: number
  y: number
}

interface TreeLinesProps {
  nodes: TreeLineNode[]
}

const NUM_LINES = 7
const LINE_SPACING = 2
const DASH = 2
const GAP = 18
const PERIOD = DASH + GAP // 20
const STAGGER = 2.25
const ANIMATION_DURATION = 2.0
const LINE_INDICES = [-3, -2, -1, 0, 1, 2, 3]

interface ParallelLine {
  x1: number
  y1: number
  x2: number
  y2: number
  animationDelay: number
}

export function computeParallelLines(
  px: number,
  py: number,
  cx: number,
  cy: number,
): ParallelLine[] {
  const dx = cx - px
  const dy = cy - py
  const len = Math.sqrt(dx * dx + dy * dy)
  if (len === 0) return []

  // Perpendicular unit normal
  const nx = -dy / len
  const ny = dx / len

  return LINE_INDICES.map((j) => {
    const offset = j * LINE_SPACING
    return {
      x1: px + offset * nx,
      y1: py + offset * ny,
      x2: cx + offset * nx,
      y2: cy + offset * ny,
      animationDelay:
        -((PERIOD - Math.abs(j) * STAGGER) / PERIOD) * ANIMATION_DURATION,
    }
  })
}

import { memo } from 'react'

export const TreeLines = memo(function TreeLines({ nodes }: TreeLinesProps) {
  return (
    <svg
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        overflow: 'visible',
        pointerEvents: 'none',
        zIndex: 0,
      }}
    >
      {nodes.map((n) => {
        let parent: { x: number; y: number }
        if (n.parentId === 'root') {
          parent = { x: 0, y: 0 }
        } else {
          const parentNode = nodes.find((p) => p.id === n.parentId)
          if (!parentNode) {
            parent = { x: 0, y: 0 }
          } else {
            parent = { x: parentNode.x, y: parentNode.y }
          }
        }

        const lines = computeParallelLines(
          parent.x,
          parent.y,
          n.x,
          n.y,
        )

        return (
          <g key={n.id}>
            {lines.map((l, i) => (
              <line
                key={i}
                x1={l.x1}
                y1={l.y1}
                x2={l.x2}
                y2={l.y2}
                className="tree-line-chevron"
                style={{ animationDelay: `${l.animationDelay}s` }}
              />
            ))}
          </g>
        )
      })}
    </svg>
  )
})
