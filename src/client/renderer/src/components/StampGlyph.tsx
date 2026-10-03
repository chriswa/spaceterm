import type { CSSProperties, MouseEvent } from 'react'
import type { AutoStamp, NodeStamp } from '../../../../shared/state'

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
 * The marks beside a card, half its height and vertically centred: a manual
 * stamp to its left, the auto-stamp to its right. Rendered as a child of the
 * card shell, whose box is the card's.
 */
export function StampMark({ stamp, autoStamp, autoStampColor, onRegenerateAutoStamp }: {
  stamp: NodeStamp | undefined
  autoStamp?: AutoStamp
  /** The fill an auto-stamp is drawn in. */
  autoStampColor?: string
  onRegenerateAutoStamp?: () => void
}) {
  const manual = stamp && stamp !== 'none' ? stamp : undefined
  if (!manual && !autoStamp) return null
  return (
    <>
      {manual && (
        <div className="node-stamp-side node-stamp-side--left">
          <div className={`node-stamp node-stamp--${manual}`} aria-label={STAMP_LABELS[manual]}>
            <StampGlyph stamp={manual} />
          </div>
        </div>
      )}
      {autoStamp && (
        <div className="node-stamp-side node-stamp-side--right">
          <AutoStampMark autoStamp={autoStamp} color={autoStampColor} onRegenerate={onRegenerateAutoStamp} />
        </div>
      )}
    </>
  )
}

/**
 * A generated icon, drawn as a mask over a flat fill: whatever colours or
 * markup the model put in the SVG, only its shape shows and nothing in it runs.
 * Clicking asks for a different one.
 */
function AutoStampMark({ autoStamp, color, onRegenerate }: {
  autoStamp: AutoStamp
  color?: string
  onRegenerate?: () => void
}) {
  const { svg, status } = autoStamp
  // Quoted: WebKit drops an unquoted data URL in a mask (see the hat masks).
  const mask = svg ? `url("data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}")` : undefined
  // Every icon drawn for this node, regenerations included. A failure leads
  // with its reason, since an empty ring otherwise looks like one in progress.
  const spent = `$${autoStamp.costUsd.toFixed(3)} spent`
  const tooltip = status === 'failed' ? `Failed: ${autoStamp.error ?? 'unknown error'}. Click to retry. ${spent}` : spent
  return (
    <button
      type="button"
      className={`node-stamp-auto node-stamp-auto--${status}${svg ? '' : ' node-stamp-auto--empty'}`}
      style={{
        ...(mask ? { maskImage: mask, WebkitMaskImage: mask } : {}),
        ...(color ? { '--node-stamp-auto-color': color } : {}),
      } as CSSProperties}
      title={tooltip}
      aria-label={`Auto stamp: ${autoStamp.description ?? autoStamp.title}. ${tooltip}`}
      // Kept off the canvas, which would otherwise start a drag or a focus.
      onMouseDown={(e: MouseEvent) => e.stopPropagation()}
      onClick={(e: MouseEvent) => {
        e.stopPropagation()
        if (status !== 'generating') onRegenerate?.()
      }}
    />
  )
}
