import { useEffect, useId, useState, type ReactNode } from 'react'
import type { SystemStatsBars, SystemStatsBattery, SystemStatsSnapshot, SystemStatsWidget } from '../shared/system-stats'

/**
 * The Mac's system monitor on the bottom bar, over the AI usage, drawn as
 * mini-stats draws it in the menu bar: a black box per module with its bar,
 * then the battery. Not the bars' stacked labels: too small to read at this
 * size, and a clip path and a text node per letter on every 2 s update. mini-stats decides every size and colour (see
 * src/shared/system-stats.ts); this only paints them, in menu-bar points
 * scaled up for a phone. The geometry follows mini-stats' `BarChart.swift`
 * and `Battery.swift`.
 */

/** Phone pixels per menu-bar point: a little over the menu bar's, to share the bottom bar's height with the usage bars. */
const SCALE = 1.2
/** Behind the readout, and the cut-out round the charger icon. */
const BACKDROP = '#11111b'
/** The menu bar's text colour, resolved for a dark bar, as mini-stats resolves its colours. */
const TEXT = '#ffffff'

const pct = (v: number) => `${Math.round(v * 100)}%`

function widgetWidth(w: SystemStatsWidget): number {
  // A battery's width is its body; add the border and the terminal nub.
  return w.kind === 'battery' ? w.width + 4 : w.width
}

function describe(w: SystemStatsWidget): string {
  if (w.kind === 'battery') {
    const level = w.level === undefined ? 'unknown' : pct(w.level)
    return `Battery ${level}${w.charger === 'charging' ? ', charging' : w.charger === 'plugged' ? ', plugged in' : ''}`
  }
  return `${w.module} ${w.bars.map((bar) => pct(bar.reduce((sum, s) => sum + s.value, 0))).join(' ')}`
}

function Bars({ w, x, top }: { w: SystemStatsBars; x: number; top: number }) {
  const n = w.bars.length
  const partition = n > 1 ? w.width / n - 0.5 : w.width
  const out: ReactNode[] = []
  if (w.box) out.push(<rect key="box" x={x} y={top} width={w.width} height={w.height} rx={2} fill="#000" />)
  w.bars.forEach((bar, i) => {
    const bx = x + i * (partition + 0.5)
    let y = top + w.height
    bar.forEach((s, j) => {
      const h = w.height * Math.max(0, s.value)
      y -= h
      out.push(<rect key={`${i}.${j}`} x={bx} y={y} width={partition} height={h} fill={s.color} />)
    })
  })
  if (w.box) {
    out.push(<rect key="edge" x={x + 0.25} y={top + 0.25} width={w.width - 0.5} height={w.height - 0.5} rx={2} fill="none" stroke="rgba(255,255,255,0.25)" strokeWidth={0.5} />)
  }
  return <>{out}</>
}

/** A charging bolt, or a plug, as mini-stats draws them (y flipped from AppKit's). */
function chargerPoints(kind: 'plugged' | 'charging', cx: number, cy: number): string {
  const up: [number, number][] = kind === 'charging'
    ? [[-3, -9], [4.5, 1.5], [1, 1.5], [3, 9], [-4.5, -1.5], [-1, -1.5]]
    : [
        [-1.5, -6.5], [1.5, -6.5], [1.5, -2.5], [4, 0.5], [4, 4.25],
        [2.75, 4.25], [2.75, 6.75], [0.25, 6.75], [0.25, 4.25],
        [-0.25, 4.25], [-0.25, 6.75], [-2.75, 6.75], [-2.75, 4.25],
        [-4, 4.25], [-4, 0.5], [-1.5, -2.5]
      ]
  return up.map(([dx, dy]) => `${cx + dx},${cy - dy}`).join(' ')
}

function Battery({ w, x, top, id }: { w: SystemStatsBattery; x: number; top: number; id: string }) {
  const radius = w.height >= 14 ? 3 : 2
  const innerRadius = w.height >= 14 ? 2 : 1
  const frame = { x: x + 1.5, y: top + 0.5, width: w.width - 1, height: w.height - 1 }
  const inner = { x: frame.x + 1.5, y: frame.y + 1.5, height: w.height - 4 }
  const maxWidth = w.width - 4
  const cx = frame.x + frame.width / 2
  const cy = frame.y + frame.height / 2
  const nubX = frame.x + frame.width + 1
  const digits = w.level === undefined ? '' : String(Math.round(w.level * 100))
  const fontSize = w.height >= 14 ? 9 : 8
  const digitsAt = (fill: string) => (
    <text x={inner.x + maxWidth / 2} y={cy} dy="0.36em" textAnchor="middle" fontSize={fontSize} fontWeight="bold" fontFamily="-apple-system, system-ui, sans-serif" fill={fill}>
      {digits}
    </text>
  )
  return (
    <>
      <rect {...frame} rx={radius} fill="none" stroke={TEXT} strokeOpacity={0.5} strokeWidth={1} />
      <path d={`M${nubX} ${cy - 2}h1a1 1 0 0 1 1 1v2a1 1 0 0 1 -1 1h-1z`} fill={TEXT} fillOpacity={0.5} />
      {w.level === undefined ? (
        <text x={cx} y={cy} dy="0.36em" textAnchor="middle" fontSize={11} fill={TEXT}>?</text>
      ) : (
        <>
          {w.track && <rect x={inner.x} y={inner.y} width={maxWidth} height={inner.height} rx={innerRadius} fill={w.track} />}
          <rect x={inner.x} y={inner.y} width={Math.max(1, maxWidth * w.level)} height={inner.height} rx={innerRadius} fill={w.fill} />
          {w.track && w.textOnTrack && w.textOnFill && (
            <>
              <clipPath id={id}>
                <rect x={inner.x} y={inner.y} width={Math.max(1, maxWidth * w.level)} height={inner.height} />
              </clipPath>
              {digitsAt(w.textOnTrack)}
              <g clipPath={`url(#${id})`}>{digitsAt(w.textOnFill)}</g>
            </>
          )}
        </>
      )}
      {w.charger !== 'none' && (
        <polygon points={chargerPoints(w.charger, cx, cy)} fill={TEXT} stroke={BACKDROP} strokeWidth={1} />
      )}
    </>
  )
}

export function SystemStatsReadout() {
  const [snapshot, setSnapshot] = useState<SystemStatsSnapshot | null>(null)
  useEffect(() => window.api.node.watchSystemStats(setSnapshot), [])
  if (!snapshot || snapshot.widgets.length === 0) return null
  return <SystemStatsPicture snapshot={snapshot} />
}

export function SystemStatsPicture({ snapshot }: { snapshot: SystemStatsSnapshot }) {
  // Clip paths are looked up by id across the whole page.
  const idPrefix = useId()
  const height = Math.max(...snapshot.widgets.map((w) => w.height))
  let x = 0
  const drawn = snapshot.widgets.map((w, i) => {
    if (i > 0) x += snapshot.spacing
    const at = x
    x += widgetWidth(w)
    const top = (height - w.height) / 2
    const id = `${idPrefix}${i}`
    return w.kind === 'bars'
      ? <Bars key={id} w={w} x={at} top={top} />
      : <Battery key={id} w={w} x={at} top={top} id={id} />
  })

  return (
    <div className="m-stats" role="img" aria-label={snapshot.widgets.map(describe).join(', ')}>
      <svg width={x * SCALE} height={height * SCALE} viewBox={`0 0 ${x} ${height}`} overflow="visible" aria-hidden="true">
        {drawn}
      </svg>
    </div>
  )
}
