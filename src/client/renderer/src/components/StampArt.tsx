import type { StampKind } from '../../../../shared/stamps'

/**
 * The glyph for each stamp, as SVG in a 100×100 box.
 *
 * SVG rather than an image or emoji because hit testing comes for free: every
 * shape carries `stamp-art__ink`, which is the only part of a stamp that takes
 * pointer events (`pointer-events: visiblePainted`). A click on the transparent
 * space around the star falls through to whatever is under it.
 */

const STAR_POINTS = (() => {
  const cx = 50, cy = 53, outer = 46, inner = 19
  const points: string[] = []
  for (let i = 0; i < 10; i++) {
    const r = i % 2 === 0 ? outer : inner
    const a = -Math.PI / 2 + (i * Math.PI) / 5
    points.push(`${(cx + r * Math.cos(a)).toFixed(2)},${(cy + r * Math.sin(a)).toFixed(2)}`)
  }
  return points.join(' ')
})()

/** One tapered bar and dot of an exclamation mark, centred on `cx`. */
function Bang({ cx }: { cx: number }) {
  return (
    <>
      <path
        className="stamp-art__ink"
        d={`M${cx - 11},12 Q${cx},0 ${cx + 11},12 L${cx + 6},62 Q${cx},70 ${cx - 6},62 Z`}
      />
      <circle className="stamp-art__ink" cx={cx} cy={85} r={10} />
    </>
  )
}

const ART: Record<StampKind, { fill: string; stroke: string; body: JSX.Element }> = {
  star: {
    fill: '#f7c531',
    stroke: '#9a6a00',
    body: <polygon className="stamp-art__ink" points={STAR_POINTS} />
  },
  'double-exclamation': {
    fill: '#e5383b',
    stroke: '#7a0c10',
    body: <><Bang cx={29} /><Bang cx={71} /></>
  }
}

export function StampArt({ kind, size }: { kind: StampKind; size: number | string }) {
  const art = ART[kind]
  return (
    <svg
      className="stamp-art"
      width={size}
      height={size}
      viewBox="-4 -4 108 108"
      fill={art.fill}
      stroke={art.stroke}
      strokeWidth={4}
      strokeLinejoin="round"
    >
      {art.body}
    </svg>
  )
}
