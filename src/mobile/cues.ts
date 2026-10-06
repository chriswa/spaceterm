/**
 * Voice Operator's audio cues, on the phone.
 *
 * The same sounds, made the same way: Voice Operator synthesises every cue as
 * a short run of sine notes rather than shipping sound files
 * (~/voiceop/Sources/VoiceOperator/Core/SoundEffects.swift), so the note
 * tables below are copied from it verbatim, and the synthesis is its `chirp`
 * ported — 5 ms fades, `speedup` 2, output gain 0.35. Keep the two in step.
 *
 * Except the two hold cues, which are Spaceterm's own: the microphone held
 * open (held-microphone.ts) taking hold and letting go. Two taps and a leap,
 * so they never sound like a dictation starting or stopping.
 */

import { recordMobileEvent } from './mobile-events'

export type Cue = 'listeningStarted' | 'listeningFinished' | 'pasted' | 'transcriptionFailed' | 'captureFailed'
  | 'holdEngaged' | 'holdReleased' | 'conversationClosed'

/** (frequency Hz, duration s) at natural speed; frequency 0 is a rest. */
const SEGMENTS: Record<Cue, Array<[number, number]>> = {
  listeningStarted: [[660, 0.09], [990, 0.11]],
  listeningFinished: [[990, 0.09], [660, 0.11]],
  pasted: [[523, 0.09], [659, 0.09], [784, 0.09], [1047, 0.14]],
  transcriptionFailed: [[523, 0.10], [392, 0.10], [262, 0.22]],
  captureFailed: [[196, 0.20], [0, 0.07], [196, 0.30]],
  holdEngaged: [[392, 0.06], [0, 0.04], [392, 0.06], [0, 0.04], [784, 0.18]],
  holdReleased: [[587, 0.06], [0, 0.04], [587, 0.06], [0, 0.04], [294, 0.18]],
  // Spaceterm's own too: hands-free's conversation window has closed, and "Control" is needed again. Three steps down, softly.
  conversationClosed: [[880, 0.08], [0, 0.03], [659, 0.08], [0, 0.03], [440, 0.18]]
}

const SPEEDUP = 2
const SAMPLE_RATE = 44_100
const FADE_S = 0.005
/** SoundBank's player volume. */
const OUTPUT_GAIN = 0.35

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

let context: AudioContext | null = null

/** The shared context, made on first use; throws where there is no Web Audio. */
function ensureContext(): AudioContext {
  if (context) return context
  const made = new AudioContext()
  // Suspended or interrupted is when an answer plays to nobody.
  made.onstatechange = () => recordMobileEvent('playback-context', { state: made.state })
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
  try {
    const ctx = ensureContext()
    if (ctx.state === 'suspended') void ctx.resume()
    const samples = cueSamples(cue)
    const buffer = ctx.createBuffer(1, samples.length, SAMPLE_RATE)
    buffer.copyToChannel(samples, 0)
    const source = ctx.createBufferSource()
    const gain = ctx.createGain()
    gain.gain.value = OUTPUT_GAIN
    source.buffer = buffer
    source.connect(gain).connect(ctx.destination)
    source.start()
    noteSounding(ctx, ctx.currentTime + buffer.duration)
    // In the server log, so a cue that seems quiet or missing can be traced.
    window.api?.log(`[cue] ${cue} (audio ${ctx.state})`)
    recordMobileEvent('cue', { cue, audio: ctx.state })
  } catch {
    // No audio device, or a policy refusal: the cue is skipped.
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
