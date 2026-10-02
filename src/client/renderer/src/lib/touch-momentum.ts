/**
 * Momentum after a finger lets go of a pan, the way iOS scroll views do it.
 *
 * Not an invention: UIScrollView decelerates exponentially, multiplying the
 * velocity by a fixed rate every millisecond — `DecelerationRate.normal` is
 * 0.998. Travel during a step is that decay integrated exactly, so the glide
 * comes out the same whatever the frame rate.
 */

/** UIScrollView.DecelerationRate.normal: velocity kept per millisecond. */
export const DECELERATION_RATE = 0.998
/** Below this speed (px/ms) the glide is over. */
export const MIN_SPEED = 0.02
/** Only the last stretch of a drag says how fast it was going at release. */
const VELOCITY_WINDOW_MS = 100
/** A finger that held still this long before lifting meant to stop. */
const STALE_MS = 60

/** Finger positions over time, for the velocity at release. */
export class VelocityTracker {
  private samples: Array<{ x: number; y: number; t: number }> = []

  reset(): void {
    this.samples = []
  }

  add(x: number, y: number, t: number): void {
    this.samples.push({ x, y, t })
    while (this.samples.length > 2 && t - this.samples[0].t > VELOCITY_WINDOW_MS) this.samples.shift()
  }

  /** Velocity in px/ms at `now`; zero if the finger had stopped. */
  velocity(now: number): { vx: number; vy: number } {
    const n = this.samples.length
    if (n < 2) return { vx: 0, vy: 0 }
    const first = this.samples[0]
    const last = this.samples[n - 1]
    const dt = last.t - first.t
    if (dt <= 0 || now - last.t > STALE_MS) return { vx: 0, vy: 0 }
    return { vx: (last.x - first.x) / dt, vy: (last.y - first.y) / dt }
  }
}

/** One glide, stepped per frame. */
export class Momentum {
  private static readonly LN_RATE = Math.log(DECELERATION_RATE)

  constructor(private vx: number, private vy: number) {}

  get moving(): boolean {
    return Math.hypot(this.vx, this.vy) >= MIN_SPEED
  }

  /** Distance travelled over the next `dtMs`, or null once the glide has ended. */
  step(dtMs: number): { dx: number; dy: number } | null {
    if (!this.moving) return null
    const decay = Math.pow(DECELERATION_RATE, dtMs)
    // ∫ v·r^t dt from 0 to dt = v·(r^dt − 1) / ln r
    const factor = (decay - 1) / Momentum.LN_RATE
    const step = { dx: this.vx * factor, dy: this.vy * factor }
    this.vx *= decay
    this.vy *= decay
    return step
  }
}
