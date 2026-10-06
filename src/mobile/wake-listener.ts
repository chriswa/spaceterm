import type { HandsFreeTuning } from '../shared/protocol'
import { TARGET_SAMPLE_RATE } from './pcm'

/**
 * Hands-free mode's ears: what the held-open microphone hears, cut into speech
 * and not-speech, and two questions asked of it.
 *
 * Speech is *speech*, not loudness: each 32 ms frame arrives scored by a
 * voice-activity model (Silero VAD, speech-detector.ts) with the probability
 * that someone is talking in it, so music, a television's hum, a fan or a
 * noisy room are not speech, however loud. Without the model, loudness against
 * the room's level stands in (`EnergyScorer`).
 *
 * While waiting for the wake word (`WakeListener`): has the user just started
 * talking, with nobody talking just before? Then the first second of it is a
 * *candidate* — handed out to be checked on the Mac for a leading "Control" —
 * and the audio from its start stays in an eight-second buffer, so that a
 * dictation can be fed everything said from the first syllable, however long
 * the check took. Everything else is forgotten as it scrolls out of the
 * buffer; nothing is kept, transcribed or sent.
 *
 * After the wake word (`UtteranceEndpointer`): has the user paused — time to
 * ask the turn model whether they sound finished — and has the pause gone on
 * long enough to end it regardless?
 *
 * Pure: scored frames in, events out, time measured in samples. No clock, no
 * microphone, no model — so every threshold is testable with synthetic frames.
 * All audio here is 16 kHz signed 16-bit mono.
 */

export const DEFAULT_TUNING: HandsFreeTuning = {
  noSpeechBeforeMs: 700,
  onsetWindowMs: 1000,
  wordMinMs: 250,
  pauseCheckMs: 300,
  turnThreshold: 0.5,
  wakeWordOnlyMs: 1500,
  afterWakeWordMs: 5000,
  endSilenceMinMs: 1500,
  endSilenceMaxMs: 20_000,
  endSilenceRampMs: 300_000,
  maxUtteranceMs: 600_000,
  playbackTailMs: 400,
}

/** One analysis frame: 32 ms, what Silero VAD takes at 16 kHz. */
export const FRAME_SAMPLES = 512
const FRAME_MS = (FRAME_SAMPLES / TARGET_SAMPLE_RATE) * 1000
const ms = (samples: number) => (samples / TARGET_SAMPLE_RATE) * 1000
const samplesOf = (milliseconds: number) => Math.round((milliseconds / 1000) * TARGET_SAMPLE_RATE)

/** A frame of audio, and the probability that someone is speaking in it. */
export interface ScoredFrame {
  pcm: Int16Array
  p: number
}

/** The frame's loudness, RMS in dBFS. */
export function levelDb(frame: Int16Array): number {
  let sum = 0
  for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i]
  const rms = Math.sqrt(sum / Math.max(1, frame.length)) / 32768
  return rms > 0 ? 20 * Math.log10(rms) : -120
}

/**
 * Speech starting and stopping, from frame probabilities, with Silero's own
 * hysteresis: it starts at `START` held for `START_FRAMES` frames (a click is
 * one), and stops after `HANGOVER_FRAMES` below `STOP` — the closure inside a
 * word like "con-trol" must not split it.
 */
export class SpeechGate {
  static readonly START = 0.5
  static readonly STOP = 0.35
  static readonly START_FRAMES = 2
  static readonly HANGOVER_FRAMES = 5

  private run = 0
  private quiet = 0
  speaking = false

  /** 'start' when speech began (`START_FRAMES` ago), 'stop' when it ended (`HANGOVER_FRAMES` ago), otherwise null. */
  push(p: number): 'start' | 'stop' | null {
    if (!this.speaking) {
      this.run = p >= SpeechGate.START ? this.run + 1 : 0
      if (this.run >= SpeechGate.START_FRAMES) {
        this.speaking = true
        this.quiet = 0
        return 'start'
      }
      return null
    }
    this.quiet = p < SpeechGate.STOP ? this.quiet + 1 : 0
    if (this.quiet >= SpeechGate.HANGOVER_FRAMES) {
      this.speaking = false
      this.run = 0
      return 'stop'
    }
    return null
  }

  reset(): void {
    this.speaking = false
    this.run = 0
    this.quiet = 0
  }
}

/**
 * Speech by loudness, for when the voice-activity model is unavailable:
 * louder than the room by a margin. The room's level falls at once to anything
 * quieter and creeps back up slowly, so a fan raises it but a voice does not.
 * Music and chatter, unlike the model, it hears as speech.
 */
export class EnergyScorer {
  static readonly MARGIN_DB = 12
  static readonly ABSOLUTE_MIN_DB = -58
  /** Per frame: about 2.5 dB/s. */
  static readonly FLOOR_RISE_DB = 0.08
  readonly name = 'loudness'
  private floorDb = -70

  score(frame: Int16Array): number {
    const db = levelDb(frame)
    const loud = db > this.floorDb + EnergyScorer.MARGIN_DB && db > EnergyScorer.ABSOLUTE_MIN_DB
    if (db < this.floorDb) this.floorDb = Math.max(-100, db)
    else if (!loud) this.floorDb += EnergyScorer.FLOOR_RISE_DB
    return loud ? 0.9 : 0.05
  }

  reset(): void { /* the room's level is the room's */ }
}

/** Splits arbitrary blocks into whole frames. */
export class Framer {
  private pending = new Int16Array(0)

  frames(block: Int16Array): Int16Array[] {
    const all = new Int16Array(this.pending.length + block.length)
    all.set(this.pending)
    all.set(block, this.pending.length)
    const out: Int16Array[] = []
    let offset = 0
    for (; offset + FRAME_SAMPLES <= all.length; offset += FRAME_SAMPLES) out.push(all.slice(offset, offset + FRAME_SAMPLES))
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
 * Speech began with nobody speaking before it, and here is its start — the
 * first `onsetWindowMs`, or all of it if it stopped sooner. `start` is the
 * sample it began at, for `WakeListener.audioSince`.
 */
export interface WakeCandidate {
  id: number
  clip: Int16Array
  start: number
  noSpeechBeforeMs: number
  /** How long it had been speech when handed out: the whole burst if it stopped, else the window. */
  spokeMs: number
}

/**
 * Every burst of speech the listener noticed, and what it made of it — for the
 * record, so a wake word that never triggered can be explained. Timings and
 * levels only; nothing of what was said.
 */
export interface SpeechSighting {
  /** `checked`: its start went to the Mac. `after-speech`: someone was talking too recently. `too-short`: a click or a cough. */
  verdict: 'checked' | 'after-speech' | 'too-short'
  durationMs: number
  noSpeechBeforeMs: number
  /** Its loudest frame, dBFS. */
  peakDb: number
}

/** Audio kept before the speech began, so its soft first consonant reaches the check and Wispr. */
export const LEAD_MS = 200

/** Listening for the wake word: see the file comment. */
export class WakeListener {
  private readonly gate = new SpeechGate()
  private readonly recent = new Recent(8)
  /** Absolute sample number of the next frame. */
  private at = 0
  /** Where the last speech ended (or listening resumed): "no speech before" is measured from here. */
  private quietFrom = 0
  /** Speech under way: where it began, what came before, how loud, and whether its start was handed out. */
  private speech: { start: number; noSpeechBefore: number; peakDb: number; eligible: boolean; handedOut: boolean } | null = null
  private nextId = 1

  constructor(private tuning: HandsFreeTuning = DEFAULT_TUNING, private readonly onSpeech: (s: SpeechSighting) => void = () => {}) {}

  setTuning(tuning: HandsFreeTuning): void { this.tuning = tuning }

  /**
   * Start over, as if everything before now were speech: a candidate needs a
   * full `noSpeechBeforeMs` from here. For after Control's voice or a cue,
   * which the microphone heard too.
   */
  resume(): void {
    this.gate.reset()
    this.recent.clear()
    this.speech = null
    this.quietFrom = this.at
  }

  /** Everything heard from sample `from` (with `LEAD_MS` before it) up to now, as far back as the buffer goes. */
  audioSince(from: number): Int16Array {
    return this.recent.slice(from - samplesOf(LEAD_MS), this.at)
  }

  push(frames: ScoredFrame[]): WakeCandidate[] {
    const candidates: WakeCandidate[] = []
    for (const { pcm, p } of frames) {
      this.recent.push(pcm)
      const frameStart = this.at
      this.at += pcm.length
      const change = this.gate.push(p)
      if (change === 'start') {
        // It began START_FRAMES ago; the frames that set it off are speech.
        const start = frameStart - (SpeechGate.START_FRAMES - 1) * FRAME_SAMPLES
        const noSpeechBefore = start - this.quietFrom
        this.speech = { start, noSpeechBefore, peakDb: -120, eligible: ms(noSpeechBefore) >= this.tuning.noSpeechBeforeMs, handedOut: false }
      }
      if (this.speech) this.speech.peakDb = Math.max(this.speech.peakDb, levelDb(pcm))
      if (change === 'stop' && this.speech) {
        // It ended HANGOVER_FRAMES ago.
        const end = this.at - SpeechGate.HANGOVER_FRAMES * FRAME_SAMPLES
        this.quietFrom = end
        const speech = this.speech
        this.speech = null
        const durationMs = ms(end - speech.start)
        if (!speech.handedOut) {
          // Stopped before its window filled: hand out what there was — unless it was a click or a cough.
          const verdict = !speech.eligible ? 'after-speech' : durationMs < this.tuning.wordMinMs ? 'too-short' : 'checked'
          if (verdict === 'checked') candidates.push(this.candidate(speech, durationMs))
          this.onSpeech({ verdict, durationMs: Math.round(durationMs), noSpeechBeforeMs: Math.round(ms(speech.noSpeechBefore)), peakDb: Math.round(speech.peakDb) })
        }
      }
      if (this.speech?.eligible && !this.speech.handedOut && ms(this.at - this.speech.start) >= this.tuning.onsetWindowMs) {
        this.speech.handedOut = true
        candidates.push(this.candidate(this.speech, ms(this.at - this.speech.start)))
        this.onSpeech({ verdict: 'checked', durationMs: Math.round(ms(this.at - this.speech.start)), noSpeechBeforeMs: Math.round(ms(this.speech.noSpeechBefore)), peakDb: Math.round(this.speech.peakDb) })
      }
    }
    return candidates
  }

  private candidate(speech: { start: number; noSpeechBefore: number }, spokeMs: number): WakeCandidate {
    return {
      id: this.nextId++,
      clip: this.audioSince(speech.start),
      start: speech.start,
      noSpeechBeforeMs: Math.round(ms(speech.noSpeechBefore)),
      spokeMs: Math.round(spokeMs),
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
  /**
   * Quiet for `pauseCheckMs`: ask whether they sound finished. Once per pause.
   * `wakeWordOnly`: nothing has been said yet but the wake word — "Control."
   * and a breath — which the turn model would hear as finished; don't ask.
   */
  | { kind: 'pause'; talkMs: number; wakeWordOnly: boolean }
  /** Speech again, after a pause was reported: whatever was asked about it no longer holds. */
  | { kind: 'resumed' }
  /** The quiet outlasted `endSilenceFor`, or the whole thing reached `maxUtteranceMs`. Once. */
  | { kind: 'ended'; reason: 'silence' | 'too-long' }

/**
 * After the wake word, while the user is talking. It starts mid-speech — the
 * wake word began it — so quiet counts from now, and `alreadyMs` (the time
 * since the speech began, out of the listener's buffer) counts towards the
 * speaker's patience.
 *
 * A first pause after less than `wakeWordOnlyMs` of actual speech — counting
 * `alreadySpokeMs` from before it started — is the pause after "Control." on
 * its own: until speech resumes, it waits at least `afterWakeWordMs`, and the
 * pause is not one to ask the turn model about. Speech, not time: the Mac's
 * check may have taken a second, which is not the speaker talking.
 */
export class UtteranceEndpointer {
  private readonly gate = new SpeechGate()
  private at = 0
  private lastSpeech = 0
  private pauses = 0
  private spokeMs: number
  private pauseReported = false
  /** Only the wake word has been said: the first pause came this early and speech has not resumed. */
  private wakeWordOnly = false
  private done = false

  constructor(private readonly tuning: HandsFreeTuning = DEFAULT_TUNING, private readonly alreadyMs = 0, alreadySpokeMs = 0) {
    this.spokeMs = alreadySpokeMs
  }

  push(frames: ScoredFrame[]): UtteranceEvent[] {
    const events: UtteranceEvent[] = []
    if (this.done) return events
    for (const { pcm, p } of frames) {
      this.at += pcm.length
      if (this.gate.speaking) this.spokeMs += FRAME_MS
      if (this.gate.push(p) === 'start' && this.pauseReported) {
        this.pauseReported = false
        this.wakeWordOnly = false
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
        this.pauses++
        this.wakeWordOnly = this.pauses === 1 && this.spokeMs < this.tuning.wakeWordOnlyMs
        events.push({ kind: 'pause', talkMs: Math.round(talkMs), wakeWordOnly: this.wakeWordOnly })
      }
      const patience = this.wakeWordOnly ? Math.max(this.tuning.afterWakeWordMs, endSilenceFor(talkMs, this.tuning)) : endSilenceFor(talkMs, this.tuning)
      if (quietMs >= patience) {
        this.done = true
        events.push({ kind: 'ended', reason: 'silence' })
        break
      }
    }
    return events
  }
}
