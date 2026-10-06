import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TUNING, EnergyScorer, FRAME_SAMPLES, LEAD_MS, UtteranceEndpointer, WakeListener, endSilenceFor,
  type ScoredFrame, type SpeechSighting, type UtteranceEvent,
} from './wake-listener'

/**
 * Frames as the speech detector hands them over: audio, and the probability
 * someone is talking in it. "speech" is p 0.95, "silence" p 0.02, and
 * "noise" is loud but not speech — music, a fan, a room — p 0.05.
 */
const RATE = 16_000
const framesOf = (ms: number, p: number, amplitude: number): ScoredFrame[] =>
  Array.from({ length: Math.round((ms / 1000) * RATE / FRAME_SAMPLES) }, () => ({
    pcm: Int16Array.from({ length: FRAME_SAMPLES }, (_, i) => Math.round(Math.sin(i / 3) * amplitude)),
    p,
  }))
const speech = (ms: number) => framesOf(ms, 0.95, 4000)
const silence = (ms: number) => framesOf(ms, 0.02, 10)
const noise = (ms: number) => framesOf(ms, 0.05, 8000)
const seconds = (samples: number) => samples / RATE

function listen(tuning = DEFAULT_TUNING) {
  const sightings: SpeechSighting[] = []
  const listener = new WakeListener(tuning, (s) => sightings.push(s))
  return { listener, sightings, hear: (...parts: ScoredFrame[][]) => listener.push(parts.flat()) }
}

describe('WakeListener', () => {
  it('hands out the first second of speech that follows no speech, and remembers where it began', () => {
    const { hear } = listen()
    const candidates = hear(silence(1500), speech(3000), silence(500))
    expect(candidates).toHaveLength(1)
    const [c] = candidates
    expect(seconds(c.clip.length)).toBeGreaterThan(1.1)
    expect(seconds(c.clip.length)).toBeLessThan(1.4)
    expect(seconds(c.start)).toBeCloseTo(1.5, 1)
    expect(c.spokeMs).toBeGreaterThanOrEqual(1000)
  })

  it('is not put off by loud sound that is not speech: music, a fan, a noisy room', () => {
    const { hear } = listen()
    const candidates = hear(noise(1500), speech(500), noise(800))
    expect(candidates).toHaveLength(1)
    expect(candidates[0].noSpeechBeforeMs).toBeGreaterThanOrEqual(1400)
  })

  it('hands out a word said on its own as soon as it stops, with how long it was', () => {
    const { hear } = listen()
    const [c] = hear(silence(1500), speech(600), silence(400))
    expect(seconds(c.clip.length)).toBeLessThan(1.1)
    expect(c.spokeMs).toBeGreaterThan(500)
    expect(c.spokeMs).toBeLessThan(700)
  })

  it('ignores speech that follows other speech too closely: the wake word has to come first', () => {
    const { hear, sightings } = listen()
    const candidates = hear(silence(1500), speech(1500), silence(300), speech(1500), silence(300), speech(500), silence(800))
    expect(candidates).toHaveLength(1)
    expect(sightings.map((s) => s.verdict)).toEqual(['checked', 'after-speech', 'after-speech'])
  })

  it('records every burst of speech and why it was or was not checked — timings and levels only', () => {
    const { hear, sightings } = listen()
    hear(silence(1500), speech(100), silence(1000), speech(600), silence(800))
    expect(sightings.map((s) => s.verdict)).toEqual(['too-short', 'checked'])
    expect(sightings[1].durationMs).toBeGreaterThan(500)
    expect(sightings[1].noSpeechBeforeMs).toBeGreaterThan(900)
    expect(sightings[1].peakDb).toBeGreaterThan(-25)
  })

  it('takes its thresholds from tuning', () => {
    const { listener, hear } = listen({ ...DEFAULT_TUNING, noSpeechBeforeMs: 2000 })
    expect(hear(silence(1500), speech(2000), silence(800))).toEqual([])
    listener.setTuning({ ...DEFAULT_TUNING, onsetWindowMs: 500 })
    const [c] = hear(silence(1500), speech(2000), silence(800))
    expect(seconds(c.clip.length)).toBeLessThan(0.8)
  })

  it('needs a full spell without speech from the moment it resumes, whatever came before', () => {
    const { listener, hear } = listen()
    hear(silence(3000))
    listener.resume()
    expect(hear(silence(300), speech(2000), silence(800))).toEqual([])
  })

  it('still has everything since a candidate began, for a dictation that starts late', () => {
    const { listener, hear } = listen()
    const [c] = hear(silence(1500), speech(1200))
    hear(speech(2000))
    expect(seconds(listener.audioSince(c.start).length)).toBeCloseTo(LEAD_MS / 1000 + 3.2, 1)
  })
})

describe('UtteranceEndpointer', () => {
  const run = (endpointer: UtteranceEndpointer, ...parts: ScoredFrame[][]): UtteranceEvent[] => endpointer.push(parts.flat())
  const kinds = (events: UtteranceEvent[]) => events.map((e) =>
    e.kind === 'ended' ? `ended:${e.reason}` : e.kind === 'pause' && e.wakeWordOnly ? 'pause:wake-word-only' : e.kind)

  it('reports each pause once, and speech resuming after it', () => {
    const events = run(new UtteranceEndpointer(DEFAULT_TUNING, 0, 1000), speech(2000), silence(1000), speech(1000), silence(1000))
    expect(kinds(events)).toEqual(['pause', 'resumed', 'pause'])
  })

  it('treats the pause after "Control." alone as no time to ask, and waits for the rest', () => {
    // The wake word, 0.6 s of it, was said before the dictation began; the Mac's check took a second.
    const endpointer = new UtteranceEndpointer(DEFAULT_TUNING, 1800, 600)
    expect(kinds(run(endpointer, silence(3000)))).toEqual(['pause:wake-word-only'])
    // Still waiting at three seconds — a short request's patience would be up by now.
    expect(kinds(run(endpointer, speech(2000), silence(1000)))).toEqual(['resumed', 'pause'])
  })

  it('gives up on a wake word left alone after afterWakeWordMs', () => {
    const endpointer = new UtteranceEndpointer(DEFAULT_TUNING, 1000, 600)
    expect(kinds(run(endpointer, silence(5500)))).toEqual(['pause:wake-word-only', 'ended:silence'])
  })

  it('ends a short request after endSilenceMinMs, but not on a shorter pause', () => {
    expect(kinds(run(new UtteranceEndpointer(DEFAULT_TUNING, 0, 2000), speech(2000), silence(1000), speech(1000), silence(1000)))).not.toContain('ended:silence')
    expect(kinds(run(new UtteranceEndpointer(DEFAULT_TUNING, 0, 2000), speech(2000), silence(3500)))).toContain('ended:silence')
  })

  it('does not hear loud sound that is not speech as talking', () => {
    expect(kinds(run(new UtteranceEndpointer(DEFAULT_TUNING, 0, 2000), speech(2000), noise(3500)))).toContain('ended:silence')
  })

  it('waits far longer for the next thought deep into a monologue', () => {
    expect(kinds(run(new UtteranceEndpointer(DEFAULT_TUNING, 300_000, 200_000), speech(1000), silence(10_000)))).toEqual(['pause'])
  })

  it('stops at the cap, and only ends once', () => {
    const endpointer = new UtteranceEndpointer({ ...DEFAULT_TUNING, maxUtteranceMs: 3000 })
    expect(kinds(run(endpointer, speech(5000), silence(6000)))).toEqual(['ended:too-long'])
  })
})

describe('endSilenceFor', () => {
  it('grows from the minimum for a quick request to the maximum at the ramp, and no further', () => {
    expect(endSilenceFor(0, DEFAULT_TUNING)).toBe(3000)
    expect(endSilenceFor(150_000, DEFAULT_TUNING)).toBe(11_500)
    expect(endSilenceFor(300_000, DEFAULT_TUNING)).toBe(20_000)
    expect(endSilenceFor(900_000, DEFAULT_TUNING)).toBe(20_000)
  })
})

describe('EnergyScorer, the fallback', () => {
  it('hears a voice over a quiet room as speech, and the room as not', () => {
    const scorer = new EnergyScorer()
    const quiet = Int16Array.from({ length: FRAME_SAMPLES }, (_, i) => (i % 2 ? 8 : -8))
    const loud = Int16Array.from({ length: FRAME_SAMPLES }, (_, i) => Math.round(Math.sin(i / 3) * 4000))
    for (let i = 0; i < 20; i++) scorer.score(quiet)
    expect(scorer.score(quiet)).toBeLessThan(0.5)
    expect(scorer.score(loud)).toBeGreaterThan(0.5)
  })
})
