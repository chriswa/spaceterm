import { useEffect } from 'react'
import { useAudioStore } from '../stores/audioStore'

/**
 * Drives --pulse-spread and --pulse-alpha CSS custom properties on #root
 * via a single requestAnimationFrame loop. Interpolates the PLP phase at
 * 60fps for a smooth sine wave, falling back to a gentle sine when no
 * BPM estimate exists.
 */
export function useBeatPulse(): void {
  useEffect(() => {
    let rafId = 0
    const root = document.getElementById('root')

    // Local interpolation state
    let localPhase = 0
    let lastBpm = 0
    let lastStorePhase = 0
    let prevTime = performance.now()

    const tick = () => {
      rafId = requestAnimationFrame(tick)
      if (!root) return

      const now = performance.now()
      const dt = now - prevTime
      prevTime = now

      const { phase, bpm } = useAudioStore.getState()

      let pulse: number

      if (bpm > 0) {
        const beatPeriodMs = 60000 / bpm

        // Sync local phase when store updates
        if (phase !== lastStorePhase || bpm !== lastBpm) {
          localPhase = phase
          lastStorePhase = phase
          lastBpm = bpm
        } else {
          // Advance local phase based on elapsed time
          localPhase += dt / beatPeriodMs
          if (localPhase >= 1) localPhase -= Math.floor(localPhase)
        }

        // Raised cosine: 1.0 on beat, 0.0 at midpoint
        pulse = 0.5 + 0.5 * Math.cos(2 * Math.PI * localPhase)
      } else {
        // No BPM estimate yet: gentle sine oscillation at ~0.67Hz (period 1500ms)
        pulse = 0.5 + 0.5 * Math.sin(2 * Math.PI * now / 1500)
      }

      const spread = 2 + 8 * pulse
      const alpha = 0.6 * pulse

      root.style.setProperty('--pulse-spread', spread + 'px')
      root.style.setProperty('--pulse-alpha', String(alpha))
    }

    rafId = requestAnimationFrame(tick)

    return () => {
      cancelAnimationFrame(rafId)
    }
  }, [])
}
