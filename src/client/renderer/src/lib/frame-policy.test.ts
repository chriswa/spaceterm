import { describe, it, expect, beforeEach } from 'vitest'
import {
  ACTIVITY_TAIL_MS,
  DEFAULT_CEILING_HZ,
  FrameLimiter,
  REDUCED_HZ,
  frameCeilingHz,
  pokeFrames,
  quantizeClock,
  resetFramePolicyForTest,
  setFrameCeilingHz,
  setUnfocusedFrames,
  setWindowFocused,
  setWindowVisible,
  targetFrameHz,
} from './frame-policy'

beforeEach(() => resetFramePolicyForTest())

describe('the target rate', () => {
  it('is zero only when the window cannot be seen', () => {
    setWindowVisible(false)
    expect(targetFrameHz(0)).toBe(0)
    // Focus is irrelevant to this: a hidden window draws nothing either way.
    setWindowFocused(true)
    expect(targetFrameHz(0)).toBe(0)
  })

  it('caps a focused window rather than letting it take every frame offered', () => {
    // The whole point on a 120 Hz display: focused is not "uncapped".
    expect(targetFrameHz(0)).toBe(DEFAULT_CEILING_HZ)
  })

  it('drops an unfocused window to the reduced rate without pausing it', () => {
    setWindowFocused(false)
    expect(targetFrameHz(0)).toBe(REDUCED_HZ)
    // Never zero — an unfocused window may be the one being watched.
    expect(targetFrameHz(0)).toBeGreaterThan(0)
  })

  it('leaves an unfocused window at full rate when told to', () => {
    setWindowFocused(false)
    setUnfocusedFrames('full')
    expect(targetFrameHz(0)).toBe(DEFAULT_CEILING_HZ)
  })

  it('never reports a rate above the ceiling, even a reduced one', () => {
    setFrameCeilingHz(5)
    setWindowFocused(false)
    expect(targetFrameHz(0)).toBe(5)
  })

  it('clamps a ceiling that would stop the app or melt it', () => {
    setFrameCeilingHz(0)
    expect(frameCeilingHz()).toBeGreaterThan(0)
    setFrameCeilingHz(100_000)
    expect(frameCeilingHz()).toBeLessThanOrEqual(240)
  })
})

/**
 * The behaviour the second-monitor case rests on: a change has to beat the
 * throttle, or watching an unfocused window means watching a stale one.
 */
describe('activity', () => {
  it('restores full rate to an unfocused window', () => {
    setWindowFocused(false)
    expect(targetFrameHz(1_000)).toBe(REDUCED_HZ)
    pokeFrames(1_000)
    expect(targetFrameHz(1_000)).toBe(DEFAULT_CEILING_HZ)
  })

  it('expires, so one change does not leave it at full rate forever', () => {
    setWindowFocused(false)
    pokeFrames(1_000)
    expect(targetFrameHz(1_000 + ACTIVITY_TAIL_MS - 1)).toBe(DEFAULT_CEILING_HZ)
    expect(targetFrameHz(1_000 + ACTIVITY_TAIL_MS)).toBe(REDUCED_HZ)
  })

  it('does not wake a hidden window — there is nothing to show it on', () => {
    setWindowVisible(false)
    pokeFrames(1_000)
    expect(targetFrameHz(1_000)).toBe(0)
  })
})

describe('FrameLimiter', () => {
  it('runs the first frame it is asked about', () => {
    expect(new FrameLimiter().shouldRun(0)).toBe(true)
  })

  it('holds a 60 Hz loop to 60 on a 120 Hz display', () => {
    const limiter = new FrameLimiter()
    let ran = 0
    // Two seconds of 120 Hz frames.
    for (let i = 0; i < 240; i++) {
      if (limiter.shouldRun(i * (1000 / 120))) ran++
    }
    // Not 240, and not the 80 a naive `>= interval` test would give once
    // vsync jitter pushed each decision past the threshold.
    expect(ran).toBeGreaterThanOrEqual(118)
    expect(ran).toBeLessThanOrEqual(122)
  })

  it('absorbs jitter rather than halving the rate again', () => {
    const limiter = new FrameLimiter(60)
    let ran = 0
    let now = 0
    for (let i = 0; i < 240; i++) {
      // A frame clock that runs a hair slow — the case that used to collapse a
      // 60 Hz target to 40.
      now += (1000 / 120) * (i % 2 === 0 ? 0.98 : 1.02)
      if (limiter.shouldRun(now)) ran++
    }
    expect(ran).toBeGreaterThanOrEqual(115)
  })

  it('takes the lower of its own rate and the policy', () => {
    const limiter = new FrameLimiter(30)
    expect(limiter.shouldRun(0)).toBe(true)
    // 1/60s is due for the policy but not for a 30 Hz loop.
    expect(limiter.shouldRun(1000 / 60)).toBe(false)
    expect(limiter.shouldRun(1000 / 30)).toBe(true)
  })

  it('never runs while the window is hidden, whatever its own rate says', () => {
    const limiter = new FrameLimiter(30)
    setWindowVisible(false)
    expect(limiter.shouldRun(0)).toBe(false)
    expect(limiter.shouldRun(10_000)).toBe(false)
  })

  it('does not wedge when the clock goes backwards', () => {
    const limiter = new FrameLimiter()
    expect(limiter.shouldRun(10_000)).toBe(true)
    expect(limiter.shouldRun(0)).toBe(true)
  })

  it('makes the first frame after a reset due immediately', () => {
    const limiter = new FrameLimiter(1)
    expect(limiter.shouldRun(0)).toBe(true)
    expect(limiter.shouldRun(1)).toBe(false)
    limiter.reset()
    expect(limiter.shouldRun(1)).toBe(true)
  })
})

/**
 * `quantizeClock` is what makes a facet's declared rate free to honour: the
 * frames in between are handed a value identical to the last one, so the frame
 * gate skips them without knowing anything about animation rates.
 */
describe('quantizeClock', () => {
  it('treats an undeclared rate as fully animated', () => {
    // The safe direction for a facet from a mod that has not considered this.
    expect(quantizeClock(1234.5, undefined)).toBe(1234.5)
  })

  it('reports a static facet as having no clock at all', () => {
    expect(quantizeClock(1234.5, 0)).toBeNull()
  })

  it('holds one value for the whole of a step, then advances', () => {
    // 10 Hz — a 100 ms step.
    expect(quantizeClock(0, 10)).toBe(0)
    expect(quantizeClock(99, 10)).toBe(0)
    expect(quantizeClock(100, 10)).toBe(100)
    expect(quantizeClock(199, 10)).toBe(100)
  })

  it('advances monotonically, so a shader clock never runs backwards', () => {
    let previous = -Infinity
    for (let now = 0; now < 2000; now += 7.3) {
      const value = quantizeClock(now, 30)!
      expect(value).toBeGreaterThanOrEqual(previous)
      previous = value
    }
  })

  it('yields exactly `hz` distinct values a second', () => {
    const seen = new Set<number>()
    // Sampled at 120 Hz across one second, a 10 Hz clock has ten positions.
    for (let i = 0; i < 120; i++) seen.add(quantizeClock(i * (1000 / 120), 10)!)
    expect(seen.size).toBe(10)
  })
})
