/**
 * The phone's audio cues — few, and only where Control is heard.
 *
 * The microphone's states are haptics on the phone (`nativeHaptic`,
 * native-microphone.ts); a button dictation has no tone, which competed with
 * the ducking around the microphone and played into AirPods still switching
 * profile. These play only when Replies are Aloud (`cuesAudible`) — on
 * Silent or Released the phone makes no sound of its own:
 *
 * - `error`: something failed — the microphone, a transcription, or Control
 *   itself. Two low notes, the same pitch.
 * - `nothingToSay`: Control finished thinking and chose to say nothing. Not a
 *   failure: a soft "beep boop".
 *
 * Hands-free has tones of its own as well as its haptics, heard whatever
 * Replies is set to and through the Ring/Silent switch (`playHandsFreeCue`,
 * played by the app): `handsFreeReady`, three soft steps up, as the
 * microphone is held and listening after hands-free is turned on
 * (ready-cue.ts); `dictationStart`, two notes up, as its words begin to
 * be taken down; `dictationEnd`, two notes down, as they are sent; and
 * `conversationClosed`, three soft steps down, as the conversation window
 * runs out and "Control" is needed again; and `controlShutdown`, an octave
 * dropping into a long low note, for "Control, shutdown".
 *
 * The sonar while Control thinks, or waits for its voice to be made, is
 * thinking-cue.ts, shared with the desktop.
 *
 * Synthesised as Voice Operator synthesises its cues — a short run of sine
 * notes, its `chirp` ported (~/voiceop/Sources/VoiceOperator/Core/SoundEffects.swift):
 * 5 ms fades, `speedup` 2. `error` is its capture-failed table.
 */

import { controlMode, useReceptionistStore } from '@/stores/receptionistStore'
import { recordMobileEvent } from './mobile-events'
import { nativeCues } from './native-microphone'

export type Cue = 'error' | 'nothingToSay' | 'handsFreeReady' | 'conversationClosed' | 'dictationStart' | 'dictationEnd' | 'controlShutdown'

/**
 * Hands-free's tones (`playHandsFreeCue`), beside its haptics: ready to
 * listen — three steps up, the conversation window's closing turned round;
 * words being taken down — two notes up; taken down and sent — two notes down; the
 * conversation window running out — three steps down; and "Control,
 * shutdown" — an octave down, held low, unlike any of them. Asked for in
 * October 2026, to be heard whatever Replies is set to and whatever the
 * Ring/Silent switch says.
 */
export type HandsFreeCue = 'handsFreeReady' | 'dictationStart' | 'dictationEnd' | 'conversationClosed' | 'controlShutdown'

/** (frequency Hz, duration s) at natural speed; frequency 0 is a rest. */
const SEGMENTS: Record<Cue, Array<[number, number]>> = {
  error: [[196, 0.20], [0, 0.07], [196, 0.30]],
  nothingToSay: [[784, 0.10], [0, 0.04], [523, 0.16]],
  handsFreeReady: [[440, 0.08], [0, 0.03], [659, 0.08], [0, 0.03], [880, 0.18]],
  conversationClosed: [[880, 0.08], [0, 0.03], [659, 0.08], [0, 0.03], [440, 0.18]],
  dictationStart: [[659, 0.08], [0, 0.03], [988, 0.12]],
  dictationEnd: [[988, 0.08], [0, 0.03], [659, 0.12]],
  controlShutdown: [[523, 0.10], [262, 0.36]],
}

/** Each cue's volume. Voice Operator plays at 0.35; the phone's are quieter, being heard in an ear. */
const GAINS: Record<Cue, number> = { error: 0.3, nothingToSay: 0.2, handsFreeReady: 0.2, conversationClosed: 0.2, dictationStart: 0.2, dictationEnd: 0.2, controlShutdown: 0.2 }

/** Replies are Aloud here: this phone holds Control, unmuted. The only time it makes a sound of its own. */
export function cuesAudible(): boolean {
  return controlMode(useReceptionistStore.getState()) === 'speak'
}

const SPEEDUP = 2
const SAMPLE_RATE = 44_100
const FADE_S = 0.005

/** The cue's samples, exactly as Voice Operator's `chirp` computes them. */
export function cueSamples(cue: Cue): Float32Array<ArrayBuffer> {
  const out: number[] = []
  const fade = Math.max(1, Math.floor(FADE_S * SAMPLE_RATE))
  for (const [freq, dur] of SEGMENTS[cue]) {
    const n = Math.floor((dur / SPEEDUP) * SAMPLE_RATE)
    for (let i = 0; i < n; i++) {
      const env = i < fade ? i / fade : i > n - fade ? (n - i) / fade : 1
      out.push(freq === 0 ? 0 : env * Math.sin((2 * Math.PI * freq * i) / SAMPLE_RATE) * (32000 / 32768))
    }
  }
  return new Float32Array(out)
}

/** A cue that waited this long for a stopped audio context is dropped rather than played late. */
export const CUE_STALE_MS = 400

interface TrackedCue {
  cue: Cue
  stop(): void
  requestedAt: number
  durationMs: number
  /** When it stops sounding, by `performance.now()`; unset while it waits for the context. */
  endsAt?: number
}

/**
 * What cues are sounding or waiting, so none pile up. A cue started on a
 * context that is not running (iOS suspends or interrupts it whenever the
 * app's own audio takes the session) does not play — it waits, its start
 * frozen with the context's clock, and every cue that waited sounds at once,
 * at full volume each, when the context runs again: a burst of overlapping
 * tones. So only the newest waiting cue is kept, and on resume one that has
 * waited more than `CUE_STALE_MS` is dropped. Pure, times passed in.
 */
export class CueTracker {
  private cues: TrackedCue[] = []

  /** A cue started now. `running`: the context was running, so it sounds at once. */
  started(cue: Omit<TrackedCue, 'endsAt'>, running: boolean, now: number): { overlapping: Cue[]; superseded: Cue[] } {
    this.cues = this.cues.filter((c) => c.endsAt === undefined || c.endsAt > now)
    const superseded: Cue[] = []
    if (!running) {
      for (const waiting of this.cues.filter((c) => c.endsAt === undefined)) {
        waiting.stop()
        superseded.push(waiting.cue)
      }
      this.cues = this.cues.filter((c) => c.endsAt !== undefined)
    }
    const overlapping = this.cues.filter((c) => c.endsAt !== undefined).map((c) => c.cue)
    this.cues.push({ ...cue, ...(running ? { endsAt: now + cue.durationMs } : {}) })
    return { overlapping, superseded }
  }

  /** The context runs again: waiting cues sound now, unless they are stale, which are stopped. */
  resumed(now: number): { dropped: Array<{ cue: Cue; lateMs: number }>; late: Array<{ cue: Cue; lateMs: number }> } {
    const dropped: Array<{ cue: Cue; lateMs: number }> = []
    const late: Array<{ cue: Cue; lateMs: number }> = []
    for (const c of this.cues) {
      if (c.endsAt !== undefined) continue
      const lateMs = Math.round(now - c.requestedAt)
      if (lateMs > CUE_STALE_MS) {
        c.stop()
        dropped.push({ cue: c.cue, lateMs })
      } else {
        c.endsAt = now + c.durationMs
        late.push({ cue: c.cue, lateMs })
      }
    }
    this.cues = this.cues.filter((c) => c.endsAt !== undefined)
    return { dropped, late }
  }
}

const tracker = new CueTracker()

let context: AudioContext | null = null

/** The shared context, made on first use; throws where there is no Web Audio. */
function ensureContext(): AudioContext {
  if (context) return context
  const made = new AudioContext()
  made.onstatechange = () => {
    // Suspended or interrupted is when an answer plays to nobody.
    recordMobileEvent('playback-context', { state: made.state })
    if (made.state !== 'running') return
    const { dropped, late } = tracker.resumed(performance.now())
    for (const d of dropped) {
      window.api?.log(`[cue] ${d.cue} dropped: it waited ${d.lateMs}ms for the audio to come back`)
      recordMobileEvent('cue-dropped', { cue: d.cue, lateMs: d.lateMs, why: 'stale' })
    }
    for (const l of late) recordMobileEvent('cue-sounded', { cue: l.cue, lateMs: l.lateMs })
  }
  context = made
  return made
}

/**
 * The page's one audio context — cues and spoken answers both play through it,
 * so a tap that wakes it for one has woken it for the other. Null when the
 * browser offers no Web Audio.
 */
export function audioContext(): AudioContext | null {
  try {
    return ensureContext()
  } catch {
    return null
  }
}

/**
 * When this page's sound stops being audible, by `performance.now()`. Cues and
 * spoken answers both report here, so hands-free mode can tell when the
 * microphone is hearing the phone itself rather than the room.
 */
let soundingUntil = 0

/** Something just scheduled on `ctx` is audible until `until` on its clock. */
export function noteSounding(ctx: AudioContext, until: number): void {
  soundingUntil = Math.max(soundingUntil, performance.now() + Math.max(0, until - ctx.currentTime) * 1000)
}

/** Everything this page was playing has been cut off. */
export function noteSilenced(): void {
  soundingUntil = Math.min(soundingUntil, performance.now())
}

/** How long this page has been silent, in ms; 0 while it is playing. */
export function quietForMs(): number {
  return Math.max(0, performance.now() - soundingUntil)
}

/** How long a cue lasts, in ms. */
export function cueMs(cue: Cue): number {
  return (cueSamples(cue).length / SAMPLE_RATE) * 1000
}

/**
 * Play a cue. Fire-and-forget, and silent rather than throwing when audio is
 * unavailable: a cue is confirmation, never a reason for something to fail.
 */
export function playCue(cue: Cue): void {
  if (!cuesAudible()) {
    recordMobileEvent('cue-dropped', { cue, why: 'replies are not aloud here' })
    return
  }
  playInPage(cue)
}

/**
 * One of hands-free's tones: whatever Replies is set to, and in the app
 * played by the app — the page's sound is WebKit's ambient type, which the
 * Ring/Silent switch silences, and the app's session is not. In a browser,
 * or from an app too old to play them, the page plays it.
 */
export function playHandsFreeCue(cue: HandsFreeCue): void {
  if (nativeCues.available()) {
    nativeCues.play(cue, SEGMENTS[cue].map(([freq, dur]) => [freq, dur / SPEEDUP]), GAINS[cue])
    return
  }
  playInPage(cue)
}

/**
 * One tone of the turn tone (turn-tone.ts), a tuning aid: played as
 * hands-free's tones are, but not recorded — there are ten a second.
 */
export function playTurnTone(frequency: number, seconds: number): void {
  const gain = 0.2
  if (nativeCues.available()) {
    nativeCues.play('turn-tone', [[frequency, seconds]], gain)
    return
  }
  try {
    const ctx = ensureContext()
    if (ctx.state !== 'running') return
    const osc = ctx.createOscillator()
    const env = ctx.createGain()
    osc.frequency.value = frequency
    const t = ctx.currentTime
    env.gain.setValueAtTime(0, t)
    env.gain.linearRampToValueAtTime(gain, t + FADE_S)
    env.gain.setValueAtTime(gain, t + seconds - FADE_S)
    env.gain.linearRampToValueAtTime(0, t + seconds)
    osc.connect(env).connect(ctx.destination)
    osc.start(t)
    osc.stop(t + seconds)
    noteSounding(ctx, t + seconds)
  } catch { /* no audio: the aid is silent */ }
}

function playInPage(cue: Cue): void {
  const gainValue = GAINS[cue]
  try {
    const ctx = ensureContext()
    if (ctx.state === 'suspended') void ctx.resume()
    const samples = cueSamples(cue)
    const buffer = ctx.createBuffer(1, samples.length, SAMPLE_RATE)
    buffer.copyToChannel(samples, 0)
    const source = ctx.createBufferSource()
    const gain = ctx.createGain()
    gain.gain.value = gainValue
    source.buffer = buffer
    source.connect(gain).connect(ctx.destination)
    source.start()
    noteSounding(ctx, ctx.currentTime + buffer.duration)
    const running = ctx.state === 'running'
    const { overlapping, superseded } = tracker.started(
      { cue, stop: () => { try { source.stop() } catch { /* never started */ } }, requestedAt: performance.now(), durationMs: buffer.duration * 1000 },
      running, performance.now(),
    )
    for (const old of superseded) recordMobileEvent('cue-dropped', { cue: old, why: `superseded by ${cue} while the audio was ${ctx.state}` })
    // Volume as played: this cue's gain, and its peak with any cue it overlaps (each the same level), in dBFS.
    const peakDb = Math.round(20 * Math.log10(gainValue * (32000 / 32768) * (1 + overlapping.length)) * 10) / 10
    // In the server log, so a cue that seems quiet, loud or missing can be traced.
    window.api?.log(`[cue] ${cue} (audio ${ctx.state}, gain ${gainValue}, peak ${peakDb} dBFS${overlapping.length ? `, over ${overlapping.join(', ')}` : ''}${running ? '' : ', waiting for the audio to resume'}${superseded.length ? `, replacing ${superseded.join(', ')}` : ''})`)
    recordMobileEvent('cue', { cue, audio: ctx.state, gain: gainValue, peakDb, overlapping, waiting: !running, ms: Math.round(buffer.duration * 1000) })
  } catch (err) {
    // No audio device, or a policy refusal: the cue is skipped.
    recordMobileEvent('cue-dropped', { cue, why: err instanceof Error ? err.message : String(err) })
  }
}

/**
 * Wake the audio context inside a user gesture, so cues played later — after
 * an await, outside the tap — are not blocked by the autoplay policy.
 */
export function primeCues(): void {
  try {
    void ensureContext().resume()
  } catch { /* as above */ }
}
