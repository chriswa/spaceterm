/** One sign's side in viewBox units, the gap between signs, and the stroke. */
const SIGN = 5
const GAP = 2.2
const STROKE = 2

/**
 * A row of bold minus or plus signs, one per effort level away from the
 * default: minuses to the left of the hat's spot, pluses to its right. Like
 * `CrabHat`, a sibling of the crab's masked mark, placed by `className`.
 */
export function CrabEffortSigns({ steps, className }: { steps: number; className: string }) {
  if (steps === 0) return null
  const count = Math.abs(steps)
  const width = count * SIGN + (count - 1) * GAP
  const bar = (SIGN - STROKE) / 2
  return (
    <svg
      className={`crab-effort crab-effort--${steps > 0 ? 'more' : 'less'} ${className}`}
      data-steps={steps}
      viewBox={`0 0 ${width} ${SIGN}`}
      style={{ aspectRatio: `${width} / ${SIGN}` }}
      aria-hidden="true"
    >
      {Array.from({ length: count }, (_, i) => {
        const x = i * (SIGN + GAP)
        return (
          <g key={i}>
            <rect x={x} y={bar} width={SIGN} height={STROKE} />
            {steps > 0 && <rect x={x + bar} y={0} width={STROKE} height={SIGN} />}
          </g>
        )
      })}
    </svg>
  )
}
