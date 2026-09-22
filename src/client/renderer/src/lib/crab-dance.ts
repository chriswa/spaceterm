export interface DanceValues {
  /** Raised-cosine glow pulse, 0..1 */
  glowPulse: number
  /** Rock angle in degrees (signed), scaled by confidence */
  rock: number
  /** Bounce offset in pixels (always non-negative) */
  bounce: number
}

/**
 * Time-based dance computation (~0.5 Hz).
 * Call tick() each animation frame to get computed values.
 *
 * - glowPulse: gentle sine, 0..1
 * - rock: ±5° squared cosine
 * - bounce: 2px absolute sine at double frequency
 *
 * ## Who still calls this
 *
 * `CrabGroup` — the toolbar — and nothing else. It drives every crab in the
 * bar from one loop, with a `FrameLimiter`, a visibility gate and a
 * skip-if-unchanged on the write, which is what a JS-driven animation has to
 * do to be affordable.
 *
 * The card marks used to call it too, from a `requestAnimationFrame` loop
 * *per card* with none of those three things. They are CSS keyframes now
 * (`terminal-card-crab-dance` in index.css), generated from the arithmetic
 * below: it is a pure function of `performance.now() % 2000` — no state, no
 * input — which is the definition of something that did not need a frame loop
 * to begin with.
 *
 * **If you change these curves, regenerate those keyframes.** They are a copy,
 * and nothing enforces that they agree; the header above the keyframes says
 * how they were sampled.
 */
export class CrabDance {
  tick(): DanceValues {
    const now = performance.now()
    const t = (now % 2000) / 2000
    const glowPulse = 0.5 + 0.5 * Math.sin(2 * Math.PI * t)

    const maxRock = 5
    const c = Math.cos(2 * Math.PI * t)
    const rock = maxRock * c * Math.abs(c)

    const bounce = 2 * Math.abs(Math.sin(2 * Math.PI * t * 2))

    return { glowPulse, rock, bounce }
  }
}
