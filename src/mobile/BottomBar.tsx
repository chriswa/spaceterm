import type { ReactNode } from 'react'

/**
 * The phone's bottom bar: a solid band across the foot of the screen that the
 * canvas stops above (see `.app` in mobile.css), in three zones — readouts on
 * the left, voice in the middle, getting around on the right. The middle sits
 * on the screen's centre line whatever the sides hold.
 */
export function BottomBar({ start, middle, end }: { start?: ReactNode; middle?: ReactNode; end?: ReactNode }) {
  return (
    <div className="m-bar">
      <div className="m-bar__zone m-bar__zone--start">{start}</div>
      <div className="m-bar__zone m-bar__zone--middle">{middle}</div>
      <div className="m-bar__zone m-bar__zone--end">{end}</div>
    </div>
  )
}
