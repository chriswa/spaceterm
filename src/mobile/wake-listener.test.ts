import { describe, expect, it } from 'vitest'
import { DEFAULT_TUNING, LEAD_MS, UtteranceEndpointer, WakeListener, endSilenceFor, type UtteranceEvent } from './wake-listener'

/**
 * Synthetic audio: "speech" is a 200 Hz tone at about −20 dBFS, "quiet" is a
 * room's hiss at about −70 dBFS. Enough for an energy gate, which is all the
 * listener is; whether a burst is really the word is the Mac's question.
 */
const RATE = 16_000
let seed = 1
const noise = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1

function quiet(ms: number): Int16Array {
  const out = new Int16Array((ms / 1000) * RATE)
  for (let i = 0; i < out.length; i++) out[i] = Math.round(noise() * 10)
  return out
}

function speech(ms: number): Int16Array {
  const out = new Int16Array((ms / 1000) * RATE)
  for (let i = 0; i < out.length; i++) out[i] = Math.round(Math.sin((2 * Math.PI * 200 * i) / RATE) * 4000 + noise() * 10)
  return out
}

/** Feed in odd-sized blocks, as a microphone does. */
function feed<E>(push: (block: Int16Array) => E[], ...parts: Int16Array[]): E[] {
  const all = new Int16Array(parts.reduce((n, p) => n + p.length, 0))
  let offset = 0
  for (const p of parts) { all.set(p, offset); offset += p.length }
  const events: E[] = []
  for (let i = 0; i < all.length; i += 1234) events.push(...push(all.subarray(i, i + 1234)))
  return events
}

const seconds = (samples: number) => samples / RATE

describe('WakeListener', () => {
  it('hands out the first second of speech that follows a quiet spell, and remembers where it began', () => {
    const listener = new WakeListener()
    const candidates = feed((b) => listener.push(b), quiet(1500), speech(3000), quiet(500))
    expect(candidates).toHaveLength(1)
    const [c] = candidates
    // About the window plus the lead, not the whole sentence.
    expect(seconds(c.clip.length)).toBeGreaterThan(1.1)
    expect(seconds(c.clip.length)).toBeLessThan(1.4)
    expect(seconds(c.start)).toBeCloseTo(1.5, 1)
    expect(c.quietBeforeMs).toBeGreaterThanOrEqual(1400)
  })

  it('hands out a word said on its own as soon as it stops', () => {
    const listener = new WakeListener()
    const candidates = feed((b) => listener.push(b), quiet(1500), speech(500), quiet(400))
    expect(candidates).toHaveLength(1)
    expect(seconds(candidates[0].clip.length)).toBeLessThan(1)
  })

  it('ignores speech that follows other talk too closely: the wake word has to come first', () => {
    const listener = new WakeListener()
    const candidates = feed((b) => listener.push(b), quiet(1500), speech(1500), quiet(300), speech(1500), quiet(300), speech(500), quiet(800))
    // Only the start of the first sentence; nothing said mid-conversation.
    expect(candidates).toHaveLength(1)
    expect(seconds(candidates[0].start)).toBeCloseTo(1.5, 1)
  })

  it('ignores a click too short to be a word', () => {
    const listener = new WakeListener()
    expect(feed((b) => listener.push(b), quiet(1500), speech(100), quiet(1500))).toEqual([])
  })

  it('keeps a short gap inside a word from splitting it', () => {
    const listener = new WakeListener()
    const candidates = feed((b) => listener.push(b), quiet(1500), speech(250), quiet(80), speech(250), quiet(800))
    expect(candidates).toHaveLength(1)
  })

  it('takes its thresholds from tuning', () => {
    const listener = new WakeListener({ ...DEFAULT_TUNING, silenceBeforeMs: 2000 })
    expect(feed((b) => listener.push(b), quiet(1500), speech(2000), quiet(800))).toEqual([])
    listener.setTuning({ ...DEFAULT_TUNING, onsetWindowMs: 500 })
    const [c] = feed((b) => listener.push(b), quiet(1500), speech(2000), quiet(800))
    expect(seconds(c.clip.length)).toBeLessThan(0.8)
  })

  it('needs quiet from the moment it resumes, whatever came before', () => {
    const listener = new WakeListener()
    feed((b) => listener.push(b), quiet(3000))
    listener.resume()
    // 300 ms after resuming is not 700 ms of quiet, though the room was quiet for seconds.
    expect(feed((b) => listener.push(b), quiet(300), speech(2000), quiet(800))).toEqual([])
  })

  it('still has everything since a candidate began, for a dictation that starts late', () => {
    const listener = new WakeListener()
    const [c] = feed((b) => listener.push(b), quiet(1500), speech(1200))
    // The check took a while; the user kept talking.
    feed((b) => listener.push(b), speech(2000))
    const since = listener.audioSince(c.start)
    expect(seconds(since.length)).toBeCloseTo(LEAD_MS / 1000 + 3.2, 1)
  })
})

describe('UtteranceEndpointer', () => {
  const run = (endpointer: UtteranceEndpointer, ...parts: Int16Array[]): UtteranceEvent[] => feed((b) => endpointer.push(b), ...parts)
  const kinds = (events: UtteranceEvent[]) => events.map((e) => e.kind === 'ended' ? `ended:${e.reason}` : e.kind)

  it('reports each pause once, as soon as it reaches pauseCheckMs, and speech resuming after it', () => {
    const events = run(new UtteranceEndpointer(), speech(2000), quiet(600), speech(1000), quiet(600))
    expect(kinds(events)).toEqual(['pause', 'resumed', 'pause'])
    const first = events[0] as Extract<UtteranceEvent, { kind: 'pause' }>
    expect(first.talkMs).toBeGreaterThan(2000)
    expect(first.talkMs).toBeLessThan(2500)
  })

  it('counts talk from before it started towards the speaker\'s patience', () => {
    const [pause] = run(new UtteranceEndpointer(DEFAULT_TUNING, 4000), speech(1000), quiet(600))
    expect((pause as Extract<UtteranceEvent, { kind: 'pause' }>).talkMs).toBeGreaterThan(5000)
  })

  it('ends a short request after endSilenceMinMs of quiet, but not on a shorter pause', () => {
    expect(kinds(run(new UtteranceEndpointer(), speech(2000), quiet(1000), speech(1000), quiet(1000)))).not.toContain('ended:silence')
    expect(kinds(run(new UtteranceEndpointer(), speech(2000), quiet(2000)))).toContain('ended:silence')
  })

  it('waits far longer for the next thought deep into a monologue', () => {
    const endpointer = new UtteranceEndpointer(DEFAULT_TUNING, 300_000)
    expect(kinds(run(endpointer, speech(1000), quiet(10_000)))).toEqual(['pause'])
  })

  it('stops at the cap, and only ends once', () => {
    const endpointer = new UtteranceEndpointer({ ...DEFAULT_TUNING, maxUtteranceMs: 3000 })
    expect(kinds(run(endpointer, speech(5000), quiet(6000)))).toEqual(['ended:too-long'])
  })
})

describe('endSilenceFor', () => {
  it('grows from the minimum for a quick request to the maximum at the ramp, and no further', () => {
    expect(endSilenceFor(0, DEFAULT_TUNING)).toBe(1500)
    expect(endSilenceFor(150_000, DEFAULT_TUNING)).toBe(10_750)
    expect(endSilenceFor(300_000, DEFAULT_TUNING)).toBe(20_000)
    expect(endSilenceFor(900_000, DEFAULT_TUNING)).toBe(20_000)
  })
})
