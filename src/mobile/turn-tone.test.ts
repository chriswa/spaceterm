import { describe, expect, it } from 'vitest'
import { startTurnTone, TURN_TONE_ENDING_SECONDS, TURN_TONE_SECONDS, turnTonePitch } from './turn-tone'

describe('turnTonePitch', () => {
  it('rises with the probability, from A3 to A6, in whole semitones', () => {
    expect(turnTonePitch(0)).toBe(220)
    expect(turnTonePitch(1)).toBe(1760)
    expect(turnTonePitch(0.4)).toBeLessThan(turnTonePitch(0.6))
    expect(turnTonePitch(0.5)).toBe(turnTonePitch(0.505))
    expect(turnTonePitch(-1)).toBe(220)
    expect(turnTonePitch(2)).toBe(1760)
  })
})

describe('startTurnTone', () => {
  /** A clock that moves only when the loop sleeps, and a model that answers from a list. */
  function harness(answers: Array<number | null>) {
    let now = 0
    const state = { quiet: true, checks: 0, onCheck: () => {} }
    const played: Array<[number, number]> = []
    const sleeps: number[] = []
    let wake: (() => void) | undefined
    const deps = {
      check: async () => { state.checks++; now += 40; state.onCheck(); return answers.shift() ?? null },
      quiet: () => state.quiet,
      play: (frequency: number, seconds: number) => { played.push([frequency, seconds]) },
      sleep: (ms: number) => new Promise<void>((resolve) => { sleeps.push(ms); now += ms; wake = resolve }),
      now: () => now,
    }
    const tick = async () => {
      for (let i = 0; i < 5; i++) await Promise.resolve()
      const w = wake
      wake = undefined
      w?.()
      for (let i = 0; i < 5; i++) await Promise.resolve()
    }
    return { deps, played, sleeps, tick, state }
  }

  it('plays each answer, longer at or above the threshold, and keeps them for the record', async () => {
    const h = harness([0.1, 0.9, null])
    const tone = startTurnTone(75, 0.85, h.deps)
    await h.tick()
    await h.tick()
    await h.tick()
    const samples = tone.stop()
    expect(h.played).toEqual([[turnTonePitch(0.1), TURN_TONE_SECONDS], [turnTonePitch(0.9), TURN_TONE_ENDING_SECONDS]])
    expect(samples.map(([, p]) => p)).toEqual([0.1, 0.9])
    // The model's 40 ms counts towards the interval.
    expect(h.sleeps[0]).toBe(35)
  })

  it('asks nothing while the speaker is talking, and starts once they stop', async () => {
    const h = harness([0.3])
    h.state.quiet = false
    const tone = startTurnTone(75, 0.85, h.deps)
    await h.tick()
    await h.tick()
    expect(h.state.checks).toBe(0)
    h.state.quiet = true
    await h.tick()
    expect(h.played).toEqual([[turnTonePitch(0.3), TURN_TONE_SECONDS]])
    tone.stop()
  })

  it('does not play an answer that arrives after the speaker started again', async () => {
    const h = harness([0.3])
    h.state.onCheck = () => { h.state.quiet = false }
    const tone = startTurnTone(75, 0.85, h.deps)
    await h.tick()
    expect(h.state.checks).toBe(1)
    expect(h.played).toEqual([])
    expect(tone.stop()).toEqual([])
  })

  it('plays nothing once stopped, even for an answer already on its way', async () => {
    const h = harness([0.5])
    const tone = startTurnTone(75, 0.85, h.deps)
    tone.stop()
    await h.tick()
    expect(h.played).toEqual([])
  })
})
