/**
 * Voice Operator's audio cues, on the phone.
 *
 * The same sounds, made the same way: Voice Operator synthesises every cue as
 * a short run of sine notes rather than shipping sound files
 * (~/voiceop/Sources/VoiceOperator/Core/SoundEffects.swift), so the note
 * tables below are copied from it verbatim, and the synthesis is its `chirp`
 * ported — 5 ms fades, `speedup` 2, output gain 0.35. Keep the two in step.
 */

export type Cue = 'listeningStarted' | 'listeningFinished' | 'pasted' | 'transcriptionFailed' | 'captureFailed'

/** (frequency Hz, duration s) at natural speed; frequency 0 is a rest. */
const SEGMENTS: Record<Cue, Array<[number, number]>> = {
  listeningStarted: [[660, 0.09], [990, 0.11]],
  listeningFinished: [[990, 0.09], [660, 0.11]],
  pasted: [[523, 0.09], [659, 0.09], [784, 0.09], [1047, 0.14]],
  transcriptionFailed: [[523, 0.10], [392, 0.10], [262, 0.22]],
  captureFailed: [[196, 0.20], [0, 0.07], [196, 0.30]]
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

/**
 * Play a cue. Fire-and-forget, and silent rather than throwing when audio is
 * unavailable: a cue is confirmation, never a reason for something to fail.
 */
export function playCue(cue: Cue): void {
  try {
    context ??= new AudioContext()
    if (context.state === 'suspended') void context.resume()
    const samples = cueSamples(cue)
    const buffer = context.createBuffer(1, samples.length, SAMPLE_RATE)
    buffer.copyToChannel(samples, 0)
    const source = context.createBufferSource()
    const gain = context.createGain()
    gain.gain.value = OUTPUT_GAIN
    source.buffer = buffer
    source.connect(gain).connect(context.destination)
    source.start()
    // In the server log, so a cue that seems quiet or missing can be traced.
    window.api?.log(`[cue] ${cue} (audio ${context.state})`)
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
    context ??= new AudioContext()
    void context.resume()
  } catch { /* as above */ }
}
