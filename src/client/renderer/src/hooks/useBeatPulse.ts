import { useEffect } from 'react'
import { useAudioStore } from '../stores/audioStore'

/**
 * Drives --pulse-spread and --pulse-alpha CSS custom properties on #root
 * via a single requestAnimationFrame loop. Always outputs a consistent
 * oscillation: phase-locked to detected beats when a BPM estimate exists,
 * falling back to a gentle sine when there's no estimate yet.
 */
export function useBeatPulse(): void {
  useEffect(() => {
    let rafId = 0
    const root = document.getElementById('root')

    const tick = () => {
      rafId = requestAnimationFrame(tick)
      if (!root) return

      const now = performance.now()
      const { phase, bpm } = useAudioStore.getState()

      let pulse: number

      if (bpm > 0) {
        // Phase-driven beat pulse at full strength — no confidence scaling.
        // Always outputs a consistent oscillation as long as we have a BPM estimate.
        // Originally exp(-6 * phase) — reduced for a smoother, less spiky pulse
        pulse = Math.exp(-1 * phase)
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
