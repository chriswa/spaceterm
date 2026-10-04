import type { HandsFreeTuning } from '../shared/protocol'
import { TARGET_SAMPLE_RATE } from './pcm'

/**
 * Hands-free mode's ears: what the held-open microphone hears, cut into speech
 * and silence, and two questions asked of it.
 *
 * While waiting for the wake word (`WakeListener`): was that a burst of speech
 * one word long, with quiet before it? Then it is a *candidate* — its audio is
 * handed out to be checked on the Mac — and if the quiet after it lasts too,
 * that is the *pause* that says "I'm talking to you". Everything else is
 * forgotten as it scrolls out of a three-second buffer; nothing is kept,
 * transcribed or sent.
 *
 * After the cue (`UtteranceEndpointer`): has the user started talking, and
 * have they stopped?
 *
 * Pure: audio in, events out, time measured in samples. No clock, no
 * microphone, no network — so every threshold is testable with synthetic tones.
 * All audio here is 16 kHz signed 16-bit mono.
 */

export const DEFAULT_TUNING: HandsFreeTuning = {
  silenceBeforeMs: 700,
  silenceAfterMs: 400,
  wordMinMs: 250,
  wordMaxMs: 1000,
  endSilenceMs: 1500,
  noSpeechTimeoutMs: 6000,
  maxUtteranceMs: 60_000,
  playbackTailMs: 400,
}

/** One analysis frame: 20 ms. */
export const FRAME_SAMPLES = TARGET_SAMPLE_RATE / 50
const FRAME_MS = 20
const ms = (samples: number) => (samples / TARGET_SAMPLE_RATE) * 1000
const samplesOf = (milliseconds: number) => Math.round((milliseconds / 1000) * TARGET_SAMPLE_RATE)

/**
 * Speech and silence, frame by frame: louder than the room by a margin is
 * speech. The room's level — the noise floor — falls at once to anything
 * quieter and creeps back up slowly, so a fan or traffic raises it but a
 * voice does not.
 */
export class SpeechGate {
  /** Above the noise floor by this much is speech. */
  static readonly MARGIN_DB = 12
  /** Never speech below this, however quiet the room: breathing, the phone's own hiss. */
  static readonly ABSOLUTE_MIN_DB = -58
  /** How fast the floor climbs back, per frame (≈ 2.5 dB/s). */
  static readonly FLOOR_RISE_DB = 0.05
  /**
   * Speech frames in a row before speech is said to start (a click is one
   * frame), and quiet ones before it is said to stop: the closure inside a
   * word like "con-trol" is a short silence that must not split it.
   */
  static readonly START_FRAMES = 2
  static readonly HANGOVER_FRAMES = 8

  private floorDb = -70
  private run = 0
  private quiet = 0
  speaking = false

  /** The frame's loudness, RMS in dBFS. */
  static levelDb(frame: Int16Array): number {
    let sum = 0
    for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i]
    const rms = Math.sqrt(sum / Math.max(1, frame.length)) / 32768
    return rms > 0 ? 20 * Math.log10(rms) : -120
  }

  /**
   * Feed one frame. Returns 'start' when speech has begun (it began
   * `START_FRAMES` frames ago), 'stop' when it has ended (`HANGOVER_FRAMES`
   * frames ago), otherwise null.
   */
  push(frame: Int16Array): 'start' | 'stop' | null {
    const db = SpeechGate.levelDb(frame)
    const loud = db > this.floorDb + SpeechGate.MARGIN_DB && db > SpeechGate.ABSOLUTE_MIN_DB
    if (db < this.floorDb) this.floorDb = Math.max(-100, db)
    else if (!loud) this.floorDb += SpeechGate.FLOOR_RISE_DB
    if (!this.speaking) {
      this.run = loud ? this.run + 1 : 0
      if (this.run >= SpeechGate.START_FRAMES) {
        this.speaking = true
        this.quiet = 0
        return 'start'
      }
      return null
    }
    this.quiet = loud ? 0 : this.quiet + 1
    if (this.quiet >= SpeechGate.HANGOVER_FRAMES) {
      this.speaking = false
      this.run = 0
      return 'stop'
    }
    return null
  }

  /** Forget whether speech is under way (the floor, which is the room, stays). */
  reset(): void {
    this.speaking = false
    this.run = 0
    this.quiet = 0
  }
}

/** Splits arbitrary blocks into whole frames. */
class Framer {
  private pending = new Int16Array(0)

  frames(block: Int16Array): Int16Array[] {
    const all = new Int16Array(this.pending.length + block.length)
    all.set(this.pending)
    all.set(block, this.pending.length)
    const out: Int16Array[] = []
    let offset = 0
    for (; offset + FRAME_SAMPLES <= all.length; offset += FRAME_SAMPLES) out.push(all.subarray(offset, offset + FRAME_SAMPLES))
    this.pending = all.slice(offset)
    return out
  }

  reset(): void { this.pending = new Int16Array(0) }
}

/** The last few seconds of audio, by absolute sample number. */
class Recent {
  private readonly buffer: Int16Array
  /** Absolute sample number one past the newest sample held. */
  private end = 0

  constructor(seconds: number) {
    this.buffer = new Int16Array(seconds * TARGET_SAMPLE_RATE)
  }

  push(frame: Int16Array): void {
    for (let i = 0; i < frame.length; i++) this.buffer[(this.end + i) % this.buffer.length] = frame[i]
    this.end += frame.length
  }

  /** Samples [from, to), clamped to what is still held. */
  slice(from: number, to: number): Int16Array {
    const start = Math.max(from, this.end - this.buffer.length, 0)
    const stop = Math.min(to, this.end)
    const out = new Int16Array(Math.max(0, stop - start))
    for (let i = 0; i < out.length; i++) out[i] = this.buffer[(start + i) % this.buffer.length]
    return out
  }

  clear(): void { this.buffer.fill(0) }
}

export type WakeEvent =
  /** One word's worth of speech with quiet before it: is it the wake word? */
  | { kind: 'candidate'; id: number; clip: Int16Array; quietBeforeMs: number; wordMs: number }
  /** The candidate has been followed by the quiet the user leaves before talking. */
  | { kind: 'pause'; id: number }
  /** Speech came back before the pause was long enough: not said on its own. */
  | { kind: 'withdrawn'; id: number }

/** Audio kept either side of a candidate, so the word's soft edges reach the check. */
const CLIP_LEAD_MS = 200
const CLIP_TAIL_MS = 100

/** Listening for the wake word: see the file comment. */
export class WakeListener {
  private readonly gate = new SpeechGate()
  private readonly framer = new Framer()
  private readonly recent = new Recent(3)
  /** Absolute sample number of the next frame. */
  private at = 0
  /** Where the last speech ended (or listening resumed): quiet is measured from here. */
  private quietFrom = 0
  /** The speech under way: where it began, and the quiet before it. */
  private speech: { start: number; quietBefore: number } | null = null
  /** A candidate waiting for its pause: from the end of its speech. */
  private waiting: { id: number; end: number } | null = null
  private nextId = 1

  constructor(private tuning: HandsFreeTuning = DEFAULT_TUNING) {}

  setTuning(tuning: HandsFreeTuning): void { this.tuning = tuning }

  /**
   * Start over, as if everything before now were noise: a candidate needs a
   * full `silenceBeforeMs` of quiet from here. For after a cue or Control's
   * voice, which the microphone heard too.
   */
  resume(): void {
    this.gate.reset()
    this.framer.reset()
    this.recent.clear()
    this.speech = null
    this.waiting = null
    this.quietFrom = this.at
  }

  push(block: Int16Array): WakeEvent[] {
    const events: WakeEvent[] = []
    for (const frame of this.framer.frames(block)) {
      this.recent.push(frame)
      const frameStart = this.at
      this.at += frame.length
      const change = this.gate.push(frame)
      if (change === 'start') {
        // It began START_FRAMES ago; the frames that set it off are speech.
        const start = frameStart - (SpeechGate.START_FRAMES - 1) * FRAME_SAMPLES
        if (this.waiting) {
          events.push({ kind: 'withdrawn', id: this.waiting.id })
          this.waiting = null
        }
        this.speech = { start, quietBefore: start - this.quietFrom }
      } else if (change === 'stop' && this.speech) {
        // It ended HANGOVER_FRAMES ago.
        const end = this.at - SpeechGate.HANGOVER_FRAMES * FRAME_SAMPLES
        const { start, quietBefore } = this.speech
        this.speech = null
        this.quietFrom = end
        const wordMs = ms(end - start)
        if (ms(quietBefore) >= this.tuning.silenceBeforeMs && wordMs >= this.tuning.wordMinMs && wordMs <= this.tuning.wordMaxMs) {
          const id = this.nextId++
          const clip = this.recent.slice(start - samplesOf(CLIP_LEAD_MS), end + samplesOf(CLIP_TAIL_MS))
          events.push({ kind: 'candidate', id, clip, quietBeforeMs: Math.round(ms(quietBefore)), wordMs: Math.round(wordMs) })
          this.waiting = { id, end }
        }
      }
      if (this.waiting && !this.gate.speaking && ms(this.at - this.waiting.end) >= this.tuning.silenceAfterMs) {
        events.push({ kind: 'pause', id: this.waiting.id })
        this.waiting = null
      }
    }
    return events
  }
}

export type UtteranceEvent =
  | { kind: 'started' }
  /** `silence`: they stopped talking. `no-speech`: they never started. `too-long`: the cap. */
  | { kind: 'ended'; reason: 'silence' | 'no-speech' | 'too-long' }

/** After the cue: has the user started talking, and stopped? Ends exactly once. */
export class UtteranceEndpointer {
  private readonly gate = new SpeechGate()
  private readonly framer = new Framer()
  private at = 0
  private started = false
  private lastSpeech = 0
  private done = false

  constructor(private readonly tuning: HandsFreeTuning = DEFAULT_TUNING) {}

  push(block: Int16Array): UtteranceEvent[] {
    const events: UtteranceEvent[] = []
    if (this.done) return events
    for (const frame of this.framer.frames(block)) {
      this.at += frame.length
      const change = this.gate.push(frame)
      if (change === 'start' && !this.started) {
        this.started = true
        events.push({ kind: 'started' })
      }
      if (this.gate.speaking) this.lastSpeech = this.at
      const elapsed = ms(this.at)
      const reason = !this.started
        ? (elapsed >= this.tuning.noSpeechTimeoutMs ? 'no-speech' : null)
        : elapsed >= this.tuning.maxUtteranceMs
          ? 'too-long'
          : !this.gate.speaking && ms(this.at - this.lastSpeech) + (SpeechGate.HANGOVER_FRAMES * FRAME_MS) >= this.tuning.endSilenceMs
            ? 'silence'
            : null
      if (reason) {
        this.done = true
        events.push({ kind: 'ended', reason })
        break
      }
    }
    return events
  }
}
