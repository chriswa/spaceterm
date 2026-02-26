import { useEffect, useRef } from 'react'
import { useAudioStore } from '../stores/audioStore'
import { angleBorderColor } from './angle-color'

export interface DanceValues {
  /** Raised-cosine glow pulse, 0..1 */
  glowPulse: number
  /** Rock angle in degrees (signed), scaled by confidence */
  rock: number
  /** Bounce offset in pixels (always non-negative) */
  bounce: number
}

/**
 * Beat-synced dance computation.
 * Call tick() each animation frame to advance state and get computed values.
 *
 * The dance runs at half beat-rate: dancePhase 0→2 over 4 real beats.
 * - glowPulse: raised cosine per real beat (2 pulses per dancePhase unit)
 * - rock: ±12° squared cosine, scaled by audio confidence
 * - bounce: 3px absolute sine, 1 bounce per real beat
 */
export class CrabDance {
  private dancePhase = 0
  private lastBpm = 0
  private lastStorePhase = -1
  private prevTime = performance.now()

  tick(): DanceValues {
    const now = performance.now()
    const dt = now - this.prevTime
    this.prevTime = now

    const { phase, bpm, confidence } = useAudioStore.getState()

    let glowPulse: number
    let rock = 0
    let bounce = 0

    if (bpm > 0) {
      const beatPeriodMs = 60000 / bpm

      if (phase !== this.lastStorePhase || bpm !== this.lastBpm) {
        const slot = Math.floor(this.dancePhase / 0.5)
        const slotPhase = (this.dancePhase / 0.5) % 1

        if (slotPhase > 0.7 && phase < 0.3) {
          const nextSlot = (slot + 1) % 4
          this.dancePhase = nextSlot * 0.5 + phase * 0.5
        } else if (slotPhase < 0.3 && phase > 0.7) {
          const prevSlot = (slot + 3) % 4
          this.dancePhase = prevSlot * 0.5 + phase * 0.5
        } else {
          this.dancePhase = slot * 0.5 + phase * 0.5
        }

        if (this.dancePhase >= 2) this.dancePhase -= 2
        if (this.dancePhase < 0) this.dancePhase += 2

        this.lastStorePhase = phase
        this.lastBpm = bpm
      } else {
        this.dancePhase += dt / (beatPeriodMs * 2)
        if (this.dancePhase >= 2) this.dancePhase -= 2
      }

      const beatPhase = (this.dancePhase * 2) % 1
      glowPulse = 0.5 + 0.5 * Math.cos(2 * Math.PI * beatPhase)

      const maxRock = 12
      const c = Math.cos(Math.PI * this.dancePhase)
      rock = maxRock * c * Math.abs(c) * confidence

      const maxBounce = 3
      bounce = maxBounce * Math.abs(Math.sin(2 * Math.PI * this.dancePhase))
    } else {
      glowPulse = 0.5 + 0.5 * Math.sin(2 * Math.PI * now / 2000)
    }

    return { glowPulse, rock, bounce }
  }
}

/**
 * Hook that drives bounce + rock on a single DOM element via a rAF loop.
 * Only applies animations when `active` is true. Cleans up styles when
 * inactive or unmounted. Does not apply glow or scale.
 *
 * `bounceScale` multiplies only the bounce (pixel offset) for elements
 * larger than the 20px toolbar crabs the default values are tuned for.
 * Rotation stays the same regardless of element size.
 *
 * Uses `style.transform` rather than the individual `translate`/`rotate` CSS
 * properties so that the element's CSS `translate` property (used for
 * positioning, e.g. centering) is not overridden.
 */
export function useCrabDance(
  ref: React.RefObject<HTMLElement | null>,
  active: boolean,
  bounceScale = 1
): void {
  const scaleRef = useRef(bounceScale)
  scaleRef.current = bounceScale

  useEffect(() => {
    if (!active) {
      const el = ref.current
      if (el) el.style.transform = ''
      return
    }

    const dance = new CrabDance()
    let rafId = 0

    const tick = () => {
      rafId = requestAnimationFrame(tick)
      const el = ref.current
      if (!el) return

      const { rock, bounce } = dance.tick()
      el.style.transform = `translateY(${-bounce * scaleRef.current}px) rotate(${rock}deg)`
    }

    rafId = requestAnimationFrame(tick)

    return () => {
      cancelAnimationFrame(rafId)
      const el = ref.current
      if (el) el.style.transform = ''
    }
  }, [active, ref])
}

/**
 * Hook that applies a beat-synced boxShadow glow to an element.
 * Reads camera.z directly from a ref each frame so glow updates in realtime
 * during zoom animations. Glow radius scales inversely with zoom so it
 * remains visible when zoomed out. Clears styles when inactive, letting
 * React inline styles (e.g. focus glow) take over without conflict.
 */
export function useUnreadGlow(
  ref: React.RefObject<HTMLElement | null>,
  color: string,
  cameraRef: React.RefObject<{ z: number }>,
  active: boolean
): void {
  const colorRef = useRef(color)
  colorRef.current = color

  useEffect(() => {
    if (!active) {
      const el = ref.current
      if (el) {
        el.style.boxShadow = ''
        el.style.borderColor = ''
      }
      return
    }

    const dance = new CrabDance()
    let rafId = 0

    const tick = () => {
      rafId = requestAnimationFrame(tick)
      const el = ref.current
      if (!el) return

      const { glowPulse } = dance.tick()
      const z = cameraRef.current.z
      const s = Math.max(1, 1 / z)
      const blur = (3 + 5 * glowPulse) * s
      const spread = (0.5 + 1.5 * glowPulse) * s
      const c = colorRef.current
      el.style.boxShadow = `0 0 ${blur}px ${spread}px ${c}`
      el.style.borderColor = c
    }

    rafId = requestAnimationFrame(tick)

    return () => {
      cancelAnimationFrame(rafId)
      const el = ref.current
      if (el) {
        el.style.boxShadow = ''
        el.style.borderColor = ''
      }
    }
  }, [active, ref, cameraRef])
}

/**
 * Hook that applies a steady scale-invariant glow to a card when its
 * corresponding toolbar icon is hovered. Uses angleBorderColor for the
 * position-based color (same as focus glow) and scales blur/spread
 * inversely with camera zoom so the glow remains visible when zoomed out.
 */
export function useToolbarHoverGlow(
  ref: React.RefObject<HTMLElement | null>,
  x: number,
  y: number,
  cameraRef: React.RefObject<{ z: number }>,
  active: boolean
): void {
  const coordsRef = useRef({ x, y })
  coordsRef.current = { x, y }

  useEffect(() => {
    if (!active) {
      const el = ref.current
      if (el) {
        el.style.boxShadow = ''
        el.style.borderColor = ''
      }
      return
    }

    let rafId = 0

    const tick = () => {
      rafId = requestAnimationFrame(tick)
      const el = ref.current
      if (!el) return

      const { x: cx, y: cy } = coordsRef.current
      if (!cameraRef.current) return
      const z = cameraRef.current.z
      const s = Math.max(1, 1 / z)
      const blur = 16 * s
      const spread = 4 * s
      const color = angleBorderColor(cx, cy, 1)
      el.style.boxShadow = `0 0 ${blur}px ${spread}px ${color}`
      el.style.borderColor = color
    }

    rafId = requestAnimationFrame(tick)

    return () => {
      cancelAnimationFrame(rafId)
      const el = ref.current
      if (el) {
        el.style.boxShadow = ''
        el.style.borderColor = ''
      }
    }
  }, [active, ref, cameraRef])
}
