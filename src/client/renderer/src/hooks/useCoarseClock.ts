import { useEffect, useState } from 'react'
import { ELAPSED_TICK_MS } from '../../../../shared/elapsed-label'
import { isWindowVisible, onWindowVisibleChange } from './useWindowVisible'

const coarseNow = () => Math.floor(Date.now() / ELAPSED_TICK_MS) * ELAPSED_TICK_MS

/**
 * A wall clock that advances in `ELAPSED_TICK_MS` steps, for the elapsed
 * captions under agent cards.
 *
 * Quantised rather than raw so the value is stable between ticks: everything
 * derived from it — the caption strings, the boxes measured from them, the
 * edge mask built out of those — recomputes once per step instead of on every
 * render that happens to land in between.
 *
 * The step is a second, which is the finest unit the captions show: a cache
 * countdown's last minute ticks down one second at a time. Quantising is what
 * keeps that affordable — the elapsed captions are laid out in their own memo,
 * so a tick re-measures those few boxes and leaves every name on the canvas
 * alone.
 */
export function useCoarseClock(): number {
  const [now, setNow] = useState(coarseNow)

  // Stopped while the window is not worth drawing for — occluded on the Mac;
  // locked, or under the terminal view or Control's transcript, on the phone —
  // since each tick re-renders the whole canvas. Caught up on the way back.
  useEffect(() => {
    let id: ReturnType<typeof setInterval> | null = null
    const run = (visible: boolean) => {
      if (visible && id === null) {
        setNow(coarseNow())
        id = setInterval(() => setNow(coarseNow()), ELAPSED_TICK_MS)
      } else if (!visible && id !== null) {
        clearInterval(id)
        id = null
      }
    }
    run(isWindowVisible())
    const off = onWindowVisibleChange(run)
    return () => {
      off()
      if (id !== null) clearInterval(id)
    }
  }, [])

  return now
}
