import { useEffect, useRef } from 'react'
import { isWindowVisible } from './useWindowVisible'

/**
 * Drives an FPS counter by writing directly to a DOM element's textContent,
 * avoiding React state updates that would re-render the Toolbar every second.
 */
export function useFps(elRef: React.RefObject<HTMLSpanElement | null>) {
  const framesRef = useRef(0)
  const lastTimeRef = useRef(performance.now())
  const rafRef = useRef(0)

  useEffect(() => {
    const tick = (now: number) => {
      framesRef.current++
      const elapsed = now - lastTimeRef.current
      if (elapsed >= 1000) {
        const fps = Math.round((framesRef.current * 1000) / elapsed)
        framesRef.current = 0
        lastTimeRef.current = now
        if (elRef.current) elRef.current.textContent = String(fps)
      }
      rafRef.current = requestAnimationFrame(tick)
    }

    const startLoop = () => { if (!rafRef.current) rafRef.current = requestAnimationFrame(tick) }
    const stopLoop = () => { if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = 0 } }

    const unsubVisibility = window.api.window.onVisibilityChanged((visible) => {
      if (visible) { lastTimeRef.current = performance.now(); framesRef.current = 0; startLoop() } else { stopLoop(); if (elRef.current) elRef.current.textContent = '0' }
    })

    if (isWindowVisible()) startLoop()

    return () => { stopLoop(); unsubVisibility() }
  }, [elRef])
}
