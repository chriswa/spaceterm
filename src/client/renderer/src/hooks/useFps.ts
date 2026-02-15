import { useEffect, useRef, useState } from 'react'

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
    rafRef.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafRef.current)
  }, [])

  return fps
}
