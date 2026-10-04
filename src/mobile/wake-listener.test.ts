import { describe, expect, it } from 'vitest'
import { DEFAULT_TUNING, UtteranceEndpointer, WakeListener, type UtteranceEvent, type WakeEvent } from './wake-listener'

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

const kinds = (events: WakeEvent[]) => events.map((e) => e.kind)

describe('WakeListener', () => {
  it('hears a word said on its own, then the pause after it', () => {
    const listener = new WakeListener()
    const events = feed((b) => listener.push(b), quiet(1500), speech(500), quiet(800))
    expect(kinds(events)).toEqual(['candidate', 'pause'])
    const candidate = events[0] as Extract<WakeEvent, { kind: 'candidate' }>
    expect(candidate.wordMs).toBeGreaterThan(400)
    expect(candidate.wordMs).toBeLessThan(600)
    // The clip carries the word with a little either side, and nothing like the whole buffer.
    expect(candidate.clip.length / RATE).toBeGreaterThan(0.5)
    expect(candidate.clip.length / RATE).toBeLessThan(1)
  })

  it('ignores a word that follows other talk too closely', () => {
    const listener = new WakeListener()
    const events = feed((b) => listener.push(b), quiet(1500), speech(1500), quiet(300), speech(500), quiet(800))
    expect(kinds(events)).toEqual([])
  })

  it('ignores conversation: bursts too long to be one word', () => {
    const listener = new WakeListener()
    expect(kinds(feed((b) => listener.push(b), quiet(1500), speech(2500), quiet(1500)))).toEqual([])
  })

  it('ignores a click too short to be a word', () => {
    const listener = new WakeListener()
    expect(kinds(feed((b) => listener.push(b), quiet(1500), speech(100), quiet(1500)))).toEqual([])
  })

  it('withdraws a candidate when talk carries straight on ("control the lights")', () => {
    const listener = new WakeListener()
    const events = feed((b) => listener.push(b), quiet(1500), speech(500), quiet(200), speech(800), quiet(1000))
    expect(kinds(events)).toEqual(['candidate', 'withdrawn'])
  })

  it('keeps a short gap inside a word from splitting it', () => {
    const listener = new WakeListener()
    const events = feed((b) => listener.push(b), quiet(1500), speech(250), quiet(80), speech(250), quiet(800))
    expect(kinds(events)).toEqual(['candidate', 'pause'])
  })

  it('takes its thresholds from tuning', () => {
    const listener = new WakeListener({ ...DEFAULT_TUNING, silenceBeforeMs: 2000 })
    expect(kinds(feed((b) => listener.push(b), quiet(1500), speech(500), quiet(800)))).toEqual([])
    listener.setTuning({ ...DEFAULT_TUNING, silenceAfterMs: 1200 })
    // Quiet enough before, but the pause after is now too short.
    expect(kinds(feed((b) => listener.push(b), quiet(1500), speech(500), quiet(800)))).toEqual(['candidate'])
  })

  it('needs quiet from the moment it resumes, whatever came before', () => {
    const listener = new WakeListener()
    feed((b) => listener.push(b), quiet(3000))
    listener.resume()
    // 300 ms after resuming is not 700 ms of quiet, though the room was quiet for seconds.
    expect(kinds(feed((b) => listener.push(b), quiet(300), speech(500), quiet(800)))).toEqual([])
  })
})

describe('UtteranceEndpointer', () => {
  const ends = (events: UtteranceEvent[]) => events.filter((e) => e.kind === 'ended')

  it('ends after the user stops talking for endSilenceMs', () => {
    const endpointer = new UtteranceEndpointer()
    const events = feed((b) => endpointer.push(b), quiet(500), speech(2000), quiet(300), speech(1000), quiet(2000))
    expect(events[0]).toEqual({ kind: 'started' })
    expect(ends(events)).toEqual([{ kind: 'ended', reason: 'silence' }])
  })

  it('does not end on a pause shorter than endSilenceMs', () => {
    const endpointer = new UtteranceEndpointer()
    expect(ends(feed((b) => endpointer.push(b), speech(1000), quiet(1000)))).toEqual([])
  })

  it('gives up when nothing is said', () => {
    const endpointer = new UtteranceEndpointer({ ...DEFAULT_TUNING, noSpeechTimeoutMs: 2000 })
    expect(ends(feed((b) => endpointer.push(b), quiet(2500)))).toEqual([{ kind: 'ended', reason: 'no-speech' }])
  })

  it('stops at the cap, and only ends once', () => {
    const endpointer = new UtteranceEndpointer({ ...DEFAULT_TUNING, maxUtteranceMs: 3000 })
    expect(ends(feed((b) => endpointer.push(b), speech(5000), quiet(3000)))).toEqual([{ kind: 'ended', reason: 'too-long' }])
  })
})
