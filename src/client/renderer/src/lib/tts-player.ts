let audioCtx: AudioContext | null = null
function getAudioContext(): AudioContext {
  if (!audioCtx) audioCtx = new AudioContext()
  return audioCtx
}

/** Play a tiny frequency-sweep cue. Rising = start, falling = stop. */
function playCue(rising: boolean): void {
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

let speaking = false
/** Incremented on each speakText call so stale calls can detect pre-emption. */
let generation = 0

export function stopSpeaking(): void {
  generation++
  speaking = false
  window.api.tts.stop()
  playCue(false)
}

/**
 * Speak text aloud via cartesia-read subprocess.
 * Resolves when speech finishes (or is stopped).
 * Returns false if TTS is unavailable.
 */
export async function speakText(text: string): Promise<boolean> {
  if (speaking) {
    stopSpeaking()
  }

  const myGeneration = ++generation
  speaking = true
  playCue(true)

  try {
    const result = await window.api.tts.speak(text)
    if (!result.available) return false
    return true
  } catch {
    return false
  } finally {
    if (myGeneration === generation) {
      speaking = false
      playCue(false)
    }
  }
}

/** Toggle speech: if speaking, stop; if not, speak. Returns false if TTS unavailable. */
export async function toggleSpeak(text: string): Promise<boolean> {
  if (speaking) {
    stopSpeaking()
    return true
  }
  return speakText(text)
}

export function isSpeaking(): boolean {
  return speaking
}
