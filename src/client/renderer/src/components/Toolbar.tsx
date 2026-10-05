import { Fragment } from 'react'
import {
  TOOLBAR_WIDGETS,
  renderToolbarWidget,
  widgetsInSlot,
  type ToolbarHost,
  type ToolbarWidget
} from './toolbar/registry'

export type { CrabNavEvent } from './toolbar/CrabGroup'

const CRAB_GROUP = 'crab-group'

/**
 * The toolbar is now the arrangement of its slots and nothing else.
 *
 * Everything it used to contain — nine inline SVG icons, five self-owned
 * toggles, a 416-line crab-nav group — lives in `toolbar/`, and *what appears
 * where* lives in `toolbar/registry`. See that file for why widgets are split
 * into standalone and host-driven.
 */

export type ToolbarProps = ToolbarHost & {
  /**
   * `bar`, along the bottom of the desktop window. `sheet`, the phone's: every
   * button and readout not marked `desktopOnly` in one strip that scrolls sideways, the readouts last,
   * then the surfaces as a list rather than a row of icons.
   */
  variant?: 'bar' | 'sheet'
}

export function Toolbar({ variant = 'bar', ...host }: ToolbarProps) {
  const props: ToolbarHost = variant === 'sheet' ? { ...host, crabLayout: 'list' } : host
  // A keyed Fragment, not a wrapper element: `.toolbar__zoom > :last-child` in
  // the stylesheet selects the final *element* in the status slot, and a
  // wrapper — even at `display: contents` — would win that match and drop the
  // rule on the floor. It would also match when the last widget renders
  // nothing, which the power monitor does unless it is switched on.
  const render = (widget: ToolbarWidget) => (
    <Fragment key={widget.id}>{renderToolbarWidget(widget, props)}</Fragment>
  )

  if (variant === 'sheet') {
    const strip = [
      ...widgetsInSlot('buttons', TOOLBAR_WIDGETS),
      ...widgetsInSlot('surfaces', TOOLBAR_WIDGETS).filter((w) => w.id !== CRAB_GROUP),
      ...widgetsInSlot('status', TOOLBAR_WIDGETS)
    ].filter((w) => !w.desktopOnly)
    const crabs = TOOLBAR_WIDGETS.find((w) => w.id === CRAB_GROUP)
    return (
      <div className="toolbar toolbar--sheet">
        <div className="toolbar__strip">
          {strip.map(render)}
        </div>
        {crabs && render(crabs)}
      </div>
    )
  }

  return (
    <div className="toolbar">
      {widgetsInSlot('buttons', TOOLBAR_WIDGETS).map(render)}
      <span className="toolbar__zoom">{widgetsInSlot('status', TOOLBAR_WIDGETS).map(render)}</span>
      {widgetsInSlot('surfaces', TOOLBAR_WIDGETS).map(render)}
    </div>
  )
}
