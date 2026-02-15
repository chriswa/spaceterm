import { computeParallelLines } from './TreeLines'

interface ReparentPreviewLineProps {
  fromX: number
  fromY: number
  toX: number
  toY: number
}

export function ReparentPreviewLine({ fromX, fromY, toX, toY }: ReparentPreviewLineProps) {
  const lines = computeParallelLines(fromX, fromY, toX, toY)
  if (lines.length === 0) return null

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
      <g>
        {lines.map((l, i) => (
          <line
            key={i}
            x1={l.x1}
            y1={l.y1}
            x2={l.x2}
            y2={l.y2}
            className="tree-line-chevron tree-line-chevron--reparent"
            style={{ animationDelay: `${l.animationDelay}s` }}
          />
        ))}
      </g>
    </svg>
  )
}
