import { BUBBLE, type RadialLayout } from './radial-menu'

/**
 * Draws a long press's menu around the thumb (see radial-menu.ts for where
 * things go and which is chosen). Only draws: the terminal view's touch
 * handlers do the choosing, since the finger never lifts until it has chosen.
 */
export function RadialMenu({ layout, selected, options }: {
  layout: RadialLayout
  selected: number | null
  options: Array<{ label: string; icon: string }>
}) {
  return (
    <div className="m-radial" aria-hidden>
      <div className="m-radial__hub" style={{ left: layout.center.x, top: layout.center.y }} />
      {layout.items.map((at, i) => (
        <div
          key={options[i].label}
          className={`m-radial__item${selected === i ? ' m-radial__item--selected' : ''}`}
          style={{ left: at.x - BUBBLE / 2, top: at.y - BUBBLE / 2, width: BUBBLE, height: BUBBLE }}
        >
          <span className="m-radial__icon">{options[i].icon}</span>
          <span className="m-radial__label">{options[i].label}</span>
        </div>
      ))}
    </div>
  )
}
