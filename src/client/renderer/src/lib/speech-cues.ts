/**
 * The two short tones that bracket spoken text.
 *
 * Rising when speech starts, falling when it stops. They exist because speech
 * can start without anyone pressing a key — an agent's MCP `TTS` call, or
 * `spaceterm-speak` — and a voice arriving out of nowhere is startling in a way
 * that a voice arriving after a chirp is not.
 *
 * Driven by the server's `speech-active` broadcast rather than by the gesture
 * that asked for speech, so the cue follows what the engine is actually doing.
 */

let audioCtx: AudioContext | null = null
function getAudioContext(): AudioContext {
  if (!audioCtx) audioCtx = new AudioContext()
  return audioCtx
}

/** Play a tiny frequency-sweep cue. Rising = start, falling = stop. */
export function playSpeechCue(rising: boolean): void {
  const ctx = getAudioContext()
  const now = ctx.currentTime
  const duration = 0.08
  const osc = ctx.createOscillator()
  const gain = ctx.createGain()
  osc.type = 'sine'
  osc.frequency.setValueAtTime(rising ? 520 : 780, now)
  osc.frequency.linearRampToValueAtTime(rising ? 780 : 520, now + duration)
  gain.gain.setValueAtTime(0.15, now)
  gain.gain.linearRampToValueAtTime(0, now + duration)
  osc.connect(gain).connect(ctx.destination)
  osc.start(now)
  osc.stop(now + duration)
}
