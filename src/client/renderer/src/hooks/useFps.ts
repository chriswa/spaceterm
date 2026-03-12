import { useEffect, useRef } from 'react'
import { isWindowVisible } from './useWindowVisible'

const RING_SIZE = 180
const WINDOW_MS = 1000

/**
 * Drives an FPS counter using a ring buffer of frame timestamps.
 * Computes a rolling 1-second FPS that updates every frame, writing
 * directly to a DOM element's textContent to avoid React re-renders.
 */
export function useFps(elRef: React.RefObject<HTMLSpanElement | null>) {
  const rafRef = useRef(0)

  useEffect(() => {
    const ring = new Float64Array(RING_SIZE)
    let cursor = 0
    let count = 0     // how many valid entries are in the ring
    let lastWritten = -1

    const tick = (now: number) => {
      // Push timestamp into ring buffer
      ring[cursor] = now
      cursor = (cursor + 1) % RING_SIZE
      if (count < RING_SIZE) count++

      // Count frames within the rolling window
      const cutoff = now - WINDOW_MS
      let inWindow = 0
      for (let i = 0; i < count; i++) {
        if (ring[i] >= cutoff) inWindow++
      }

      // Scale to per-second: if the oldest in-window frame is recent,
      // the actual span may be less than WINDOW_MS, so normalise.
      // Find the oldest timestamp that's still in the window.
      let oldest = now
      for (let i = 0; i < count; i++) {
        if (ring[i] >= cutoff && ring[i] < oldest) oldest = ring[i]
      }
      const span = now - oldest
      const fps = span > 0 ? Math.round((inWindow - 1) * 1000 / span) : 0

      // Only touch the DOM when the displayed number actually changes
      if (fps !== lastWritten) {
        lastWritten = fps
        if (elRef.current) elRef.current.textContent = String(fps)
      }

      rafRef.current = requestAnimationFrame(tick)
    }

    const reset = () => { count = 0; cursor = 0; lastWritten = -1 }
    const startLoop = () => { if (!rafRef.current) rafRef.current = requestAnimationFrame(tick) }
    const stopLoop = () => { if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = 0 } }

    const unsubVisibility = window.api.window.onVisibilityChanged((visible) => {
      if (visible) { reset(); startLoop() } else { stopLoop(); if (elRef.current) elRef.current.textContent = '0' }
    })

    if (isWindowVisible()) startLoop()

    return () => { stopLoop(); unsubVisibility() }
  }, [elRef])
}
