import { Fragment } from 'react'
import {
  TOOLBAR_WIDGETS,
  renderToolbarWidget,
  widgetsInSlot,
  type ToolbarHost,
  type ToolbarWidget
} from './toolbar/registry'

export type { CrabNavEvent } from './toolbar/CrabGroup'

/**
 * The toolbar is now the arrangement of its slots and nothing else.
 *
 * Everything it used to contain — nine inline SVG icons, five self-owned
 * toggles, a 416-line crab-nav group, a sparkline and a rate-limit meter —
 * lives in `toolbar/`, and *what appears where* lives in `toolbar/registry`.
 * See that file for why widgets are split into standalone and host-driven.
 */

export type ToolbarProps = ToolbarHost

export function Toolbar(props: ToolbarProps) {
  // A keyed Fragment, not a wrapper element: `.toolbar__zoom > :last-child` in
  // the stylesheet selects the final *element* in the status slot, and a
  // wrapper — even at `display: contents` — would win that match and drop the
  // rule on the floor. It would also match when the last widget renders
  // nothing, which the rate-limit meter does whenever `gh` is unavailable.
  const render = (widget: ToolbarWidget) => (
    <Fragment key={widget.id}>{renderToolbarWidget(widget, props)}</Fragment>
  )

  return (
    <div className="toolbar">
      {widgetsInSlot('buttons', TOOLBAR_WIDGETS).map(render)}
      <span className="toolbar__zoom">{widgetsInSlot('status', TOOLBAR_WIDGETS).map(render)}</span>
      {widgetsInSlot('surfaces', TOOLBAR_WIDGETS).map(render)}
    </div>
  )
}
