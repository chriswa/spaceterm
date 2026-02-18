import { useEffect, useRef, useState } from 'react'
import { isWindowVisible } from './useWindowVisible'

export function useFps() {
  const [fps, setFps] = useState(0)
  const framesRef = useRef(0)
  const lastTimeRef = useRef(performance.now())
  const rafRef = useRef(0)

  useEffect(() => {
    const tick = (now: number) => {
      framesRef.current++
      const elapsed = now - lastTimeRef.current
      if (elapsed >= 1000) {
        setFps(Math.round((framesRef.current * 1000) / elapsed))
        framesRef.current = 0
        lastTimeRef.current = now
      }
      rafRef.current = requestAnimationFrame(tick)
    }

    const startLoop = () => { if (!rafRef.current) rafRef.current = requestAnimationFrame(tick) }
    const stopLoop = () => { if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = 0 } }

    const unsubVisibility = window.api.window.onVisibilityChanged((visible) => {
      if (visible) { lastTimeRef.current = performance.now(); framesRef.current = 0; startLoop() } else { stopLoop(); setFps(0) }
    })

    if (isWindowVisible()) startLoop()

    return () => { stopLoop(); unsubVisibility() }
  }, [])

  return fps
}
