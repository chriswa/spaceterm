/**
 * The phone's audio cues — few, and only where Control is heard.
 *
 * The microphone's states are haptics on the phone (`nativeHaptic`,
 * native-microphone.ts); a button dictation has no tone, which competed with
 * the ducking around the microphone and played into AirPods still switching
 * profile. These play only when replies are Hear (`cuesAudible`) — on
 * Read or Off the phone makes no sound of its own:
 *
 * - `error`: something failed — the microphone, a transcription, or Control
 *   itself. Two low notes, the same pitch.
 * - `nothingToSay`: Control finished thinking and chose to say nothing. Not a
 *   failure: a soft "beep boop".
 *
 * Hands-free has tones of its own as well as its haptics, heard whatever
 * Off / Read / Hear is set to and through the Ring/Silent switch (`playHandsFreeCue`,
 * played by the app): `handsFreeReady`, three soft steps up, as the
 * microphone is held and listening after hands-free is turned on
 * (ready-cue.ts); `dictationStart`, two notes up, as its words begin to
 * be taken down; `dictationEnd`, two notes down, as they are sent; and
 * `conversationClosed`, three soft steps down, as the conversation window
 * runs out and "Control" is needed again; and `controlShutdown`, an octave
 * dropping into a long low note, for "Control, shutdown"; and `notWakeWord`,
 * a sad slide down from G5, as speech that needed "Control" turns out not to
 * start with it and is thrown away. While it decides whether such speech
 * starts with "Control", a beep repeats (`playPendingTone`).
 *
 * `heardUnattached`, a short odd little tune, plays the same way when the
 * microphone button's words reached Control while nobody holds it: taken,
 * but no reply is coming (`playHeardUnattachedCue`). A tritone leap up, a
 * stutter on one note, a drop, a pause, then a leap to a long high note
 * that lands a tritone from where it began — lopsided on purpose, so it
 * sounds like nothing else here. Seven notes, the most of any cue, and at
 * about 0.7 s the longest.
 *
 * The sonar while Control thinks, or waits for its voice to be made, is
 * thinking-cue.ts, shared with the desktop; here the app plays it where it
 * can (`playThinkingSonar`).
 *
 * Synthesised as Voice Operator synthesises its cues — a short run of sine
 * notes, its `chirp` ported (~/voiceop/Sources/VoiceOperator/Core/SoundEffects.swift):
 * 5 ms fades, `speedup` 2. `error` is its capture-failed table.
 */

import { controlMode, useReceptionistStore } from '@/stores/receptionistStore'
import { recordMobileEvent } from './mobile-events'
import { echoNotes, playEchoTone } from '@/lib/thinking-cue'
import { nativeCues, nativeSpeech } from './native-microphone'

export type Cue = 'error' | 'nothingToSay' | 'handsFreeReady' | 'conversationClosed' | 'dictationStart' | 'dictationEnd' | 'controlShutdown' | 'notWakeWord' | 'heardUnattached'

/**
 * Hands-free's tones (`playHandsFreeCue`), beside its haptics: ready to
 * listen — three steps up, the conversation window's closing turned round;
 * words being taken down — two notes up; taken down and sent — two notes down; the
 * conversation window running out — three steps down; and "Control,
 * shutdown" — an octave down, held low, unlike any of them. Asked for in
 * October 2026, to be heard whatever Off / Read / Hear is set to and whatever the
 * Ring/Silent switch says.
 */
export type HandsFreeCue = 'handsFreeReady' | 'dictationStart' | 'dictationEnd' | 'conversationClosed' | 'controlShutdown' | 'notWakeWord'

/** (frequency Hz, duration s) at natural speed; frequency 0 is a rest. */
const SEGMENTS: Record<Cue, Array<[number, number]>> = {
  error: [[196, 0.20], [0, 0.07], [196, 0.30]],
  nothingToSay: [[784, 0.10], [0, 0.04], [523, 0.16]],
  handsFreeReady: [[440, 0.08], [0, 0.03], [659, 0.08], [0, 0.03], [880, 0.18]],
  conversationClosed: [[880, 0.08], [0, 0.03], [659, 0.08], [0, 0.03], [440, 0.18]],
  dictationStart: [[659, 0.08], [0, 0.03], [988, 0.12]],
  dictationEnd: [[988, 0.08], [0, 0.03], [659, 0.12]],
  controlShutdown: [[523, 0.10], [262, 0.36]],
  // From the pending beep's G5, sliding sadly down a semitone at a time, then dropping to a long D5.
  notWakeWord: [[784, 0.16], [740, 0.16], [698, 0.16], [587, 0.56]],
  // G5, C#6, A#5 A#5, D#5 — pause — G#5, D#6.
  heardUnattached: [[784, 0.12], [0, 0.04], [1109, 0.12], [0, 0.04], [932, 0.08], [0, 0.03], [932, 0.08], [0, 0.04], [622, 0.22], [0, 0.10], [831, 0.12], [0, 0.04], [1245, 0.36]],
}

/** Each cue's volume. Voice Operator plays at 0.35; the phone's are quieter, being heard in an ear. */
const GAINS: Record<Cue, number> = { error: 0.3, nothingToSay: 0.2, handsFreeReady: 0.2, conversationClosed: 0.2, dictationStart: 0.2, dictationEnd: 0.2, controlShutdown: 0.2, notWakeWord: 0.2, heardUnattached: 0.2 }

/** Replies are Hear here: this phone holds Control, unmuted. The only time it makes a sound of its own. */
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
 * One of hands-free's tones: whatever Off / Read / Hear is set to, and in the app
 * played by the app — the page's sound is WebKit's ambient type, which the
 * Ring/Silent switch silences, and the app's session is not. In a browser,
 * or from an app too old to play them, the page plays it.
 */
export function playHandsFreeCue(cue: HandsFreeCue): void {
  playWhateverReplies(cue)
}

/**
 * Hands-free's tone while, outside the conversation window, it hears what may
 * be speech — perhaps only a cough — and has not yet decided whether it
 * starts with "Control": a soft medium-high beep (G5), repeating, until the
 * `dictationStart` chirp says the words are being taken down (from their
 * first syllable), or until they turn out to be nothing — or not to start
 * with "Control", which `notWakeWord` then says. In the window, where any
 * words will do, there is none. Asked for in October 2026.
 *
 * One beep and the rest after it, repeated: four a second. Seconds as played, not before `SPEEDUP`.
 */
const PENDING_TONE: Array<[number, number]> = [[784, 0.09], [0, 0.16]]
/** Quieter than a cue, being repeated. */
const PENDING_GAIN = 0.12

let pendingTone = false

/**
 * What the app's one repeating tone is, as far as the page knows: hands-free's
 * pending beep, Control's sonar, or nothing. A cue the app plays stops it, and
 * so does a new engine (`epoch`, `nativeSpeech.engineEpoch`).
 */
let repeating: { tone: 'pending' | 'sonar'; epoch: number } | null = null

/**
 * Start hands-free's pending tone, or stop it.
 * Only the app plays it, through Control's voice player and only where
 * nothing played leaks into the microphone — so hands-free goes on hearing
 * the speech it is about. Nowhere else: the page's own sound would make
 * hands-free stand aside, deaf to the very words the tone is for. While
 * Control's voice plays the app does not start it, its one player being
 * busy, and Control's voice arriving stops it.
 */
export function playPendingTone(on: boolean): void {
  if (on === pendingTone) return
  pendingTone = on
  if (!on) {
    nativeCues.stopRepeating()
    repeating = null
  } else if (nativeCues.canRepeat()) {
    nativeCues.repeat('pending', PENDING_TONE, PENDING_GAIN)
    repeating = { tone: 'pending', epoch: nativeSpeech.engineEpoch() }
  }
}

/**
 * One tick of the sonar while Control thinks (thinking-cue.ts `ThinkingCue`,
 * through `thinkingCueScope.playTone`). Played by the app where it can, which
 * loops it on Control's voice player: the page's sound is silenced by the
 * screen lock and the Ring/Silent switch, and turned down by hands-free's
 * microphone, which under hands-free left the sonar unheard from October 12
 * 2026. The app's loop keeps the cue's time (`echoNotes`), so a tick only
 * starts it again where the page knows it stopped: a cue, the pending beep, a
 * new engine. Never over the pending beep, which has the one repeating tone
 * while hands-free decides about what may be speech; the sonar comes back on
 * the tick after it ends. Elsewhere the page plays it, on its one audio
 * context, which it wakes if it was suspended.
 *
 * Returns the function that silences it.
 */
export function playThinkingSonar(): () => void {
  if (pendingTone) return stopSonarLoop
  if (nativeCues.canRepeatNotes()) {
    const epoch = nativeSpeech.engineEpoch()
    if (repeating?.tone !== 'sonar' || repeating.epoch !== epoch) {
      const notes = echoNotes()
      const peak = Math.max(...notes.map(([, , gain]) => gain))
      nativeCues.repeat('sonar', notes.map(([freq, seconds, gain]) => [freq, seconds, gain / peak]), peak)
      repeating = { tone: 'sonar', epoch }
      recordMobileEvent('thinking-sonar', { on: true, by: 'app' })
    }
    return stopSonarLoop
  }
  // The app cannot take it now: its loop, if it had it, stops for the page's.
  stopSonarLoop()
  const ctx = audioContext()
  if (!ctx) return stopSonarLoop
  if (ctx.state === 'suspended') void ctx.resume()
  recordMobileEvent('thinking-sonar', { on: true, by: 'page', audio: ctx.state })
  const stop = playEchoTone(ctx)
  return () => {
    stop()
    stopSonarLoop()
  }
}

/** The app's sonar loop stopped, if it has it. */
function stopSonarLoop(): void {
  if (repeating?.tone !== 'sonar') return
  repeating = null
  nativeCues.stopRepeating()
  recordMobileEvent('thinking-sonar', { on: false })
}

/**
 * The microphone button's words were taken, but nobody holds Control, so no
 * reply is coming. Heard whatever Off / Read / Hear is set to — it is set to Off.
 */
export function playHeardUnattachedCue(): void {
  playWhateverReplies('heardUnattached')
}

/**
 * Played by the app where it can, so the Ring/Silent switch does not silence
 * it; else by the page. Asked for as the app's microphone stops, it waits for
 * that to finish: the app drops a cue sent while it takes its engine down.
 */
function playWhateverReplies(cue: HandsFreeCue | 'heardUnattached'): void {
  nativeCues.whenSettled(() => {
    if (nativeCues.available()) {
      nativeCues.play(cue, SEGMENTS[cue].map(([freq, dur]) => [freq, dur / SPEEDUP]), GAINS[cue])
      // The app stops whatever it was repeating for a cue.
      repeating = null
      return
    }
    playInPage(cue)
  })
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
