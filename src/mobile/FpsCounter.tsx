import { useEffect, useState } from 'react'

/** How long each reading counts frames over: steady enough to read, quick enough to follow a pinch. */
export const FPS_WINDOW_MS = 500

/**
 * The frame rate, tucked into the bar's corner above the rocket (mobile.css).
 * Only a number: frames counted over each half second, timed by the frame
 * callbacks' own timestamps, so it reads what the web view actually drew.
 * Not shown with the toolbar sheet up (MobileApp.tsx), where nothing moves.
 */
export function FpsCounter() {
  const [fps, setFps] = useState<number | null>(null)
  useEffect(() => {
    let frameId = 0
    let windowStart: number | null = null
    let frames = 0
    const frame = (t: number) => {
      if (windowStart === null) windowStart = t
      else frames++
      const elapsed = t - windowStart
      if (elapsed >= FPS_WINDOW_MS) {
        setFps(Math.round((frames * 1000) / elapsed))
        windowStart = t
        frames = 0
      }
      frameId = requestAnimationFrame(frame)
    }
    frameId = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(frameId)
  }, [])
  return <span className="m-fps" aria-label={fps === null ? undefined : `${fps} frames a second`}>{fps ?? ''}</span>
}
