import { useEffect, useState } from 'react'
import { isWindowVisible, onWindowVisibleChange } from './useWindowVisible'

/** One `ps` a second is cheap; faster would be noise on a figure this size. */
const POLL_MS = 1000

/**
 * Polls the total resident memory of everything the PTY daemon is running.
 *
 * `null` until the first reading arrives, and again whenever there is no
 * daemon to ask. Polling stops while the window is hidden or occluded — a
 * readout nobody can see is not worth a subprocess a second — and takes a
 * fresh reading immediately on the way back, so the value on screen is never
 * one from before the window was hidden.
 */
export function useAgentMemory(): number | null {
  const [bytes, setBytes] = useState<number | null>(null)

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setInterval> | null = null

    const sample = (): void => {
      window.api.system.getAgentMemory()
        .then((next) => { if (!cancelled) setBytes(next) })
        .catch(() => { if (!cancelled) setBytes(null) })
    }

    const start = (): void => {
      if (timer) return
      sample()
      timer = setInterval(sample, POLL_MS)
    }
    const stop = (): void => {
      if (!timer) return
      clearInterval(timer)
      timer = null
    }

    const unsubscribe = onWindowVisibleChange((visible) => { if (visible) start(); else stop() })
    if (isWindowVisible()) start()

    return () => { cancelled = true; stop(); unsubscribe() }
  }, [])

  return bytes
}
