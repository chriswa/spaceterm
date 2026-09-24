import type { NodeStamp } from '../../../../shared/state'

type VisibleStamp = Exclude<NodeStamp, 'none'>

/** Five-pointed star, point up, in a 100×100 box. */
const STAR_POINTS = Array.from({ length: 10 }, (_, i) => {
  const r = i % 2 === 0 ? 48 : 19
  const a = -Math.PI / 2 + (i * Math.PI) / 5
  return `${(50 + r * Math.cos(a)).toFixed(2)},${(53 + r * Math.sin(a)).toFixed(2)}`
}).join(' ')

export const STAMP_LABELS: Record<NodeStamp, string> = {
  none: 'No stamp',
  star: 'Star',
  bang: 'Urgent',
}

/**
 * A stamp's shape, drawn in `currentColor` so the same glyph serves the picker
 * swatch and the mark beside the card. Scales to its box's height.
 */
export function StampGlyph({ stamp }: { stamp: VisibleStamp }) {
  if (stamp === 'star') {
    return (
      <svg viewBox="0 0 100 100" height="100%" fill="currentColor" aria-hidden="true">
        <polygon points={STAR_POINTS} strokeLinejoin="round" stroke="currentColor" strokeWidth="4" />
      </svg>
    )
  }
  return (
    <svg viewBox="0 0 64 100" height="100%" fill="currentColor" aria-hidden="true">
      <rect x="6" y="4" width="18" height="62" rx="9" />
      <circle cx="15" cy="86" r="10" />
      <rect x="40" y="4" width="18" height="62" rx="9" />
      <circle cx="49" cy="86" r="10" />
    </svg>
  )
}

/**
 * The stamp beside a card: to its left, half its height, vertically centred.
 * Rendered as a child of the card shell, whose box is the card's.
 */
export function StampMark({ stamp }: { stamp: NodeStamp | undefined }) {
  if (!stamp || stamp === 'none') return null
  return (
    <div className={`node-stamp node-stamp--${stamp}`} aria-label={STAMP_LABELS[stamp]}>
      <StampGlyph stamp={stamp} />
    </div>
  )
}
