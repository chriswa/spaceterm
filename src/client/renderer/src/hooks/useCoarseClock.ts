import { useEffect, useState } from 'react'
import { ELAPSED_TICK_MS } from '../lib/elapsed-label'

/**
 * A wall clock that advances in `ELAPSED_TICK_MS` steps, for the elapsed
 * captions under agent cards.
 *
 * Quantised rather than raw so the value is stable between ticks: everything
 * derived from it — the caption strings, the boxes measured from them, the
 * edge mask built out of those — recomputes once per step instead of on every
 * render that happens to land in between.
 *
 * The step is far coarser than a second because the captions never show
 * seconds. A per-second clock would re-lay every label sixty times a minute to
 * produce the same text fifty-nine of them.
 */
export function useCoarseClock(): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / ELAPSED_TICK_MS) * ELAPSED_TICK_MS)

  useEffect(() => {
    const id = setInterval(() => {
      setNow(Math.floor(Date.now() / ELAPSED_TICK_MS) * ELAPSED_TICK_MS)
    }, ELAPSED_TICK_MS)
    return () => clearInterval(id)
  }, [])

  return now
}
