import { describe, it, expect } from 'vitest'
import { Momentum, VelocityTracker, DECELERATION_RATE, MIN_SPEED } from './touch-momentum'

describe('VelocityTracker', () => {
  it('measures the speed of the last stretch of a drag', () => {
    const v = new VelocityTracker()
    v.add(0, 0, 0)
    v.add(10, 0, 200) // slow start, outside the window by the end
    v.add(60, 20, 250)
    v.add(110, 40, 300)
    const { vx, vy } = v.velocity(300)
    expect(vx).toBeCloseTo(1)
    expect(vy).toBeCloseTo(0.4)
  })

  it('reads a finger that stopped before lifting as stopped', () => {
    const v = new VelocityTracker()
    v.add(0, 0, 0)
    v.add(100, 0, 50)
    expect(v.velocity(200)).toEqual({ vx: 0, vy: 0 })
  })
})

describe('Momentum', () => {
  it('glides the distance an exponential decay predicts, whatever the frame rate', () => {
    // Total travel for v0 decaying by r per ms is v0 / -ln(r).
    const expected = 1 / -Math.log(DECELERATION_RATE)
    for (const frame of [8, 16.7, 33]) {
      const m = new Momentum(1, 0)
      let total = 0
      for (let step = m.step(frame); step; step = m.step(frame)) total += step.dx
      // Stops a little short: the tail below MIN_SPEED is cut off.
      expect(total).toBeGreaterThan(expected - MIN_SPEED / -Math.log(DECELERATION_RATE) - 1)
      expect(total).toBeLessThanOrEqual(expected)
    }
  })

  it('slows every step, in the direction it was thrown', () => {
    const m = new Momentum(-0.8, 0.6)
    const a = m.step(16)!
    const b = m.step(16)!
    expect(a.dx).toBeLessThan(0)
    expect(a.dy).toBeGreaterThan(0)
    expect(Math.abs(b.dx)).toBeLessThan(Math.abs(a.dx))
  })

  it('does not glide at all from a near-standstill', () => {
    expect(new Momentum(0.01, 0).step(16)).toBeNull()
  })
})
