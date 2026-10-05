import type { HandsFreeTuning } from '../shared/protocol'
import { TARGET_SAMPLE_RATE } from './pcm'

/**
 * Hands-free mode's ears: what the held-open microphone hears, cut into speech
 * and silence, and two questions asked of it.
 *
 * While waiting for the wake word (`WakeListener`): has the user just started
 * talking after a quiet spell? Then the first second of it is a *candidate* —
 * handed out to be checked on the Mac for a leading "Control" — and the audio
 * from its start stays in an eight-second buffer, so that a dictation can be
 * fed everything said from the first syllable, however long the check took.
 * Everything else is forgotten as it scrolls out of the buffer; nothing is
 * kept, transcribed or sent.
 *
 * After the wake word (`UtteranceEndpointer`): has the user paused — time to
 * ask the turn model whether they sound finished — and has the pause gone on
 * long enough to end it regardless?
 *
 * Pure: audio in, events out, time measured in samples. No clock, no
 * microphone, no network — so every threshold is testable with synthetic tones.
 * All audio here is 16 kHz signed 16-bit mono.
 */

export const DEFAULT_TUNING: HandsFreeTuning = {
  silenceBeforeMs: 700,
  onsetWindowMs: 1000,
  wordMinMs: 250,
  pauseCheckMs: 300,
  turnThreshold: 0.5,
  endSilenceMinMs: 1500,
  endSilenceMaxMs: 20_000,
  endSilenceRampMs: 300_000,
  maxUtteranceMs: 600_000,
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

/**
 * Speech began after a quiet spell, and here is its start — the first
 * `onsetWindowMs`, or all of it if it stopped sooner. `start` is the sample it
 * began at, for `WakeListener.audioSince`.
 */
export interface WakeCandidate {
  id: number
  clip: Int16Array
  start: number
  quietBeforeMs: number
}

/** Audio kept before the speech began, so its soft first consonant reaches the check and Wispr. */
export const LEAD_MS = 200

/** Listening for the wake word: see the file comment. */
export class WakeListener {
  private readonly gate = new SpeechGate()
  private readonly framer = new Framer()
  private readonly recent = new Recent(8)
  /** Absolute sample number of the next frame. */
  private at = 0
  /** Where the last speech ended (or listening resumed): quiet is measured from here. */
  private quietFrom = 0
  /** Speech under way after enough quiet, not yet handed out. */
  private onset: { start: number; quietBefore: number } | null = null
  private nextId = 1

  constructor(private tuning: HandsFreeTuning = DEFAULT_TUNING) {}

  setTuning(tuning: HandsFreeTuning): void { this.tuning = tuning }

  /**
   * Start over, as if everything before now were noise: speech counts only
   * after a full `silenceBeforeMs` of quiet from here. For after Control's
   * voice or a cue, which the microphone heard too.
   */
  resume(): void {
    this.gate.reset()
    this.framer.reset()
    this.recent.clear()
    this.onset = null
    this.quietFrom = this.at
  }

  /** Everything heard from sample `from` (with `LEAD_MS` before it) up to now, as far back as the buffer goes. */
  audioSince(from: number): Int16Array {
    return this.recent.slice(from - samplesOf(LEAD_MS), this.at)
  }

  push(block: Int16Array): WakeCandidate[] {
    const candidates: WakeCandidate[] = []
    for (const frame of this.framer.frames(block)) {
      this.recent.push(frame)
      const frameStart = this.at
      this.at += frame.length
      const change = this.gate.push(frame)
      if (change === 'start') {
        // It began START_FRAMES ago; the frames that set it off are speech.
        const start = frameStart - (SpeechGate.START_FRAMES - 1) * FRAME_SAMPLES
        const quietBefore = start - this.quietFrom
        if (ms(quietBefore) >= this.tuning.silenceBeforeMs) this.onset = { start, quietBefore }
      } else if (change === 'stop') {
        // It ended HANGOVER_FRAMES ago.
        const end = this.at - SpeechGate.HANGOVER_FRAMES * FRAME_SAMPLES
        this.quietFrom = end
        // Stopped before its window filled: hand out what there was — unless it was a click or a cough.
        if (this.onset) {
          const onset = this.onset
          this.onset = null
          if (ms(end - onset.start) >= this.tuning.wordMinMs) candidates.push(this.candidate(onset))
        }
      }
      if (this.onset && ms(this.at - this.onset.start) >= this.tuning.onsetWindowMs) {
        candidates.push(this.candidate(this.onset))
        this.onset = null
      }
    }
    return candidates
  }

  private candidate(onset: { start: number; quietBefore: number }): WakeCandidate {
    return {
      id: this.nextId++,
      clip: this.audioSince(onset.start),
      start: onset.start,
      quietBeforeMs: Math.round(ms(onset.quietBefore)),
    }
  }
}

/**
 * How long a pause ends a dictation by itself: `endSilenceMinMs` for a short
 * request, growing linearly with how long the speaker has been going, to
 * `endSilenceMaxMs` at `endSilenceRampMs` — the longer the monologue, the
 * more room for the next thought.
 */
export function endSilenceFor(talkMs: number, tuning: HandsFreeTuning): number {
  const ramp = Math.min(1, talkMs / Math.max(1, tuning.endSilenceRampMs))
  return tuning.endSilenceMinMs + (tuning.endSilenceMaxMs - tuning.endSilenceMinMs) * ramp
}

export type UtteranceEvent =
  /** Quiet for `pauseCheckMs`: ask whether they sound finished. Once per pause. */
  | { kind: 'pause'; talkMs: number }
  /** Speech again, after a pause was reported: whatever was asked about it no longer holds. */
  | { kind: 'resumed' }
  /** The quiet outlasted `endSilenceFor`, or the whole thing reached `maxUtteranceMs`. Once. */
  | { kind: 'ended'; reason: 'silence' | 'too-long' }

/**
 * After the wake word, while the user is talking. It starts mid-speech — the
 * wake word began it — so quiet counts from now, and `alreadyMs` of talk (what
 * was said before it started, out of the listener's buffer) counts towards
 * the speaker's patience.
 */
export class UtteranceEndpointer {
  private readonly gate = new SpeechGate()
  private readonly framer = new Framer()
  private at = 0
  private lastSpeech = 0
  private pauseReported = false
  private done = false

  constructor(private readonly tuning: HandsFreeTuning = DEFAULT_TUNING, private readonly alreadyMs = 0) {}

  push(block: Int16Array): UtteranceEvent[] {
    const events: UtteranceEvent[] = []
    if (this.done) return events
    for (const frame of this.framer.frames(block)) {
      this.at += frame.length
      if (this.gate.push(frame) === 'start' && this.pauseReported) {
        this.pauseReported = false
        events.push({ kind: 'resumed' })
      }
      if (this.gate.speaking) this.lastSpeech = this.at
      const talkMs = this.alreadyMs + ms(this.at)
      if (talkMs >= this.tuning.maxUtteranceMs) {
        this.done = true
        events.push({ kind: 'ended', reason: 'too-long' })
        break
      }
      if (this.gate.speaking) continue
      const quietMs = ms(this.at - this.lastSpeech) + SpeechGate.HANGOVER_FRAMES * FRAME_MS
      if (!this.pauseReported && quietMs >= this.tuning.pauseCheckMs) {
        this.pauseReported = true
        events.push({ kind: 'pause', talkMs: Math.round(talkMs) })
      }
      if (quietMs >= endSilenceFor(talkMs, this.tuning)) {
        this.done = true
        events.push({ kind: 'ended', reason: 'silence' })
        break
      }
    }
    return events
  }
}
