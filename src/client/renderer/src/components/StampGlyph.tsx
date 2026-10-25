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
/** A gear, the mark of an automation's run. Eight teeth around a ring, as one evenodd path. */
const GEAR_SVG = (() => {
  const teeth = Array.from({ length: 8 }, (_, i) => {
    const a = (i * Math.PI) / 4
    const x = 50 + 38 * Math.sin(a)
    const y = 50 - 38 * Math.cos(a)
    return `<rect x="${(x - 8).toFixed(2)}" y="${(y - 9).toFixed(2)}" width="16" height="18" rx="3" transform="rotate(${i * 45} ${x.toFixed(2)} ${y.toFixed(2)})"/>`
  }).join('')
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">'
    + `<g fill="#000">${teeth}</g>`
    + '<path fill="#000" fill-rule="evenodd" d="M50 18a32 32 0 1 0 0.01 0zM50 37a13 13 0 1 1 -0.01 0z"/>'
    + '</svg>'
})()
const GEAR_MASK = autoStampMask(GEAR_SVG)

export function StampMark({ stamp, autoStamp, automationRun, autoStampColor, onRegenerateAutoStamp }: {
  stamp: NodeStamp | undefined
  autoStamp?: AutoStamp
  /**
   * An automation's run: a fixed gear takes the auto-stamp's place, since runs
   * are never drawn an icon (see `isAutomationRun`). Wins over an auto-stamp
   * the surface was drawn before it was moved under an automation.
   */
  automationRun?: boolean
  /** The fill an auto-stamp is drawn in. */
  autoStampColor?: string
  onRegenerateAutoStamp?: () => void
}) {
  const manual = stamp && stamp !== 'none' ? stamp : undefined
  if (!manual && !autoStamp && !automationRun) return null
  return (
    <>
      {manual && (
        <div className="node-stamp-side node-stamp-side--left">
          <div className={`node-stamp node-stamp--${manual}`} aria-label={STAMP_LABELS[manual]}>
            <StampGlyph stamp={manual} />
          </div>
        </div>
      )}
      {automationRun ? (
        <div className="node-stamp-side node-stamp-side--right">
          <div
            className="node-stamp-auto node-stamp-auto--ready"
            style={{
              maskImage: GEAR_MASK,
              WebkitMaskImage: GEAR_MASK,
              ...(autoStampColor ? { '--node-stamp-auto-color': autoStampColor } : {}),
            } as CSSProperties}
            title="Started by an automation"
            aria-label="Started by an automation"
          />
        </div>
      ) : autoStamp && (
        <div className="node-stamp-side node-stamp-side--right">
          <AutoStampMark autoStamp={autoStamp} color={autoStampColor} onRegenerate={onRegenerateAutoStamp} />
        </div>
      )}
    </>
  )
}

/** An auto-stamp's SVG as a CSS mask image. */
export function autoStampMask(svg: string): string {
  // Quoted: WebKit drops an unquoted data URL in a mask (see the hat masks).
  return `url("data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}")`
}


/**
 * A clockwise refresh arrow, shown in an auto-stamp's place while one is being
 * drawn, first time or regeneration alike, and spun by the stylesheet.
 */
const REFRESH_ARROW_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">'
  + '<path d="M50 16A34 34 0 1 0 84 50" fill="none" stroke="#000" stroke-width="12" stroke-linecap="round"/>'
  + '<polygon points="70,16 48,0 48,32" fill="#000"/>'
  + '</svg>'

/**
 * A generated icon, drawn as a mask over a flat fill: whatever colours or
 * markup the model put in the SVG, only its shape shows and nothing in it runs.
 * Clicking asks for a different one; until it arrives, the refresh arrow
 * stands in for the old icon, so the click visibly took.
 */
function AutoStampMark({ autoStamp, color, onRegenerate }: {
  autoStamp: AutoStamp
  color?: string
  onRegenerate?: () => void
}) {
  const { status } = autoStamp
  const svg = status === 'generating' ? REFRESH_ARROW_SVG : autoStamp.svg
  const mask = svg ? autoStampMask(svg) : undefined
  // Every icon drawn for this node, regenerations included. A failure leads
  // with its reason, since an empty ring says only that there is no icon.
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
      aria-label={`Auto stamp: ${status === 'generating' ? 'drawing' : autoStamp.description ?? autoStamp.title}. ${tooltip}`}
      // Kept off the canvas, which would otherwise start a drag or a focus.
      onMouseDown={(e: MouseEvent) => e.stopPropagation()}
      onClick={(e: MouseEvent) => {
        e.stopPropagation()
        if (status !== 'generating') onRegenerate?.()
      }}
    />
  )
}
