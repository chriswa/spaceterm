import { useEffect, useRef } from 'react'
import { isWindowVisible, onWindowVisibleChange } from './useWindowVisible'
import { FrameLimiter } from '../lib/frame-policy'

const RING_SIZE = 180
const WINDOW_MS = 1000

/**
 * How often the *number* is recomputed. Not how often frames are counted.
 *
 * Every frame still goes into the ring — that is the measurement, and skipping
 * samples would make the counter lie about the very thing it reports. What is
 * rated is the scan over the ring and the write, which is all of the cost and
 * none of the accuracy.
 *
 * Ten is chosen for the reader rather than for the budget: a frame counter
 * rewritten 120 times a second is a blur, and nobody can read a three-digit
 * number changing faster than this anyway.
 */
const READOUT_HZ = 10

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
    const limiter = new FrameLimiter(READOUT_HZ)

    const tick = (now: number) => {
      // Push timestamp into ring buffer. Before the gate: every frame is a
      // sample, whether or not this is a frame we report on.
      ring[cursor] = now
      cursor = (cursor + 1) % RING_SIZE
      if (count < RING_SIZE) count++

      rafRef.current = requestAnimationFrame(tick)
      if (!limiter.shouldRun(now)) return

      // One pass, not two. Counting the in-window frames and finding the
      // oldest of them are the same walk, and this ran 120 times a second
      // over a 180-entry ring to answer a question asked once a frame.
      const cutoff = now - WINDOW_MS
      let inWindow = 0
      let oldest = now
      for (let i = 0; i < count; i++) {
        const t = ring[i]
        if (t >= cutoff) {
          inWindow++
          if (t < oldest) oldest = t
        }
      }

      // Scale to per-second: if the oldest in-window frame is recent,
      // the actual span may be less than WINDOW_MS, so normalise.
      const span = now - oldest
      const fps = span > 0 ? Math.round((inWindow - 1) * 1000 / span) : 0

      // Only touch the DOM when the displayed number actually changes
      if (fps !== lastWritten) {
        lastWritten = fps
        if (elRef.current) elRef.current.textContent = String(fps)
      }
    }

    // The limiter too: the interval since the last readout is however long the
    // window was hidden, which says nothing about when the next one is wanted.
    const reset = () => { count = 0; cursor = 0; lastWritten = -1; limiter.reset() }
    const startLoop = () => { if (!rafRef.current) rafRef.current = requestAnimationFrame(tick) }
    const stopLoop = () => { if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = 0 } }

    const unsubVisibility = onWindowVisibleChange((visible) => {
      if (visible) { reset(); startLoop() } else { stopLoop(); if (elRef.current) elRef.current.textContent = '0' }
    })

    if (isWindowVisible()) startLoop()

    return () => { stopLoop(); unsubVisibility() }
  }, [elRef])
}
