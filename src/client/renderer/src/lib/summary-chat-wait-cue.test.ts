import { describe, it, expect } from 'vitest'
import { SummaryChatWaitCue, type WaitCueDeps } from './summary-chat-wait-cue'
import { asNodeId } from '../../../../shared/ids'

const A = asNodeId('node-aaaa1111')
const B = asNodeId('node-bbbb2222')

/**
 * A fake clock plus a fake tone player. The cue's Web Audio graph is not the
 * interesting part — its *schedule* is, and that is what an unbounded echo is a
 * bug in. jsdom has no AudioContext, so the schedule is driven through the
 * same deps seam the real implementation supplies by default.
 */
function harness() {
  let now = 0
  let nextHandle = 1
  const timers = new Map<number, { at: number; fn: () => void }>()
  let playing = 0
  let played = 0

  const schedule = (fn: () => void, ms: number): number => {
    const handle = nextHandle++
    timers.set(handle, { at: now + ms, fn })
    return handle
  }

  /** A real echo lasts this long before it ends on its own. */
  const TONE_MS = 1_500

  const deps: WaitCueDeps = {
    playTone: () => {
      playing++
      played++
      let ended = false
      const end = () => {
        if (ended) return
        ended = true
        playing--
      }
      schedule(end, TONE_MS)
      return end
    },
    setTimer: schedule,
    clearTimer: (handle) => { timers.delete(handle) },
  }

  return {
    cue: new SummaryChatWaitCue(deps),
    /** Tones started and not yet silenced. */
    get playing() { return playing },
    /** Tones started since the beginning of the test. */
    get played() { return played },
    advance(ms: number) {
      const target = now + ms
      // Fire due timers in time order; a timer may schedule its successor.
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0]
        if (!due) break
        const [handle, timer] = due
        timers.delete(handle)
        now = timer.at
        timer.fn()
      }
      now = target
    },
  }
}

describe('SummaryChatWaitCue', () => {
  it('stays silent for a wait that resolves quickly', () => {
    const h = harness()
    h.cue.setWaiting(A, true)
    h.advance(1_000)
    h.cue.setWaiting(A, false)
    h.advance(10_000)

    expect(h.played).toBe(0)
  })

  it('repeats while a surface is still waiting', () => {
    const h = harness()
    h.cue.setWaiting(A, true)
    h.advance(10_000)

    expect(h.played).toBeGreaterThan(1)
  })

  it('goes silent the instant the surface stops waiting', () => {
    // The reported bug: the echo kept playing underneath the spoken answer.
    // `false` arrives when the surface leaves the thinking phase, and nothing
    // may be audible after that.
    const h = harness()
    h.cue.setWaiting(A, true)
    h.advance(2_000)
    expect(h.playing).toBe(1)

    h.cue.setWaiting(A, false)
    expect(h.playing).toBe(0)

    const before = h.played
    h.advance(60_000)
    expect(h.played).toBe(before)
  })

  it('keeps playing until the last waiting surface is done', () => {
    const h = harness()
    h.cue.setWaiting(A, true)
    h.cue.setWaiting(B, true)
    h.advance(3_000)
    const afterA = h.played

    h.cue.setWaiting(A, false)
    h.advance(5_000)
    expect(h.played).toBeGreaterThan(afterA)

    h.cue.setWaiting(B, false)
    const afterB = h.played
    h.advance(60_000)
    expect(h.played).toBe(afterB)
  })

  it('stops itself if the surface never reports that it is done', () => {
    // A server restart mid-answer, or a dropped socket, means the `ready` that
    // ends a wait may simply never arrive. An echo is unbounded audible
    // output, so it must not be able to run forever waiting for one.
    const h = harness()
    h.cue.setWaiting(A, true)
    h.advance(10 * 60_000)

    expect(h.playing).toBe(0)
    const before = h.played
    h.advance(10 * 60_000)
    expect(h.played).toBe(before)
  })

  it('restarts cleanly after the watchdog has fired', () => {
    const h = harness()
    h.cue.setWaiting(A, true)
    h.advance(10 * 60_000)
    const afterWatchdog = h.played

    h.cue.setWaiting(A, true)
    h.advance(5_000)
    expect(h.played).toBeGreaterThan(afterWatchdog)

    h.cue.setWaiting(A, false)
    const afterStop = h.played
    h.advance(60_000)
    expect(h.played).toBe(afterStop)
  })
})
