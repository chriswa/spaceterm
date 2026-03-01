let audioCtx: AudioContext | null = null

function getAudioContext(): AudioContext {
  if (!audioCtx) {
    audioCtx = new AudioContext()
  }
  return audioCtx
}

function float32ToAudioBuffer(samples: Float32Array, sampleRate: number): AudioBuffer {
  const ctx = getAudioContext()
  const buffer = ctx.createBuffer(1, samples.length, sampleRate)
  buffer.getChannelData(0).set(samples)
  return buffer
}

let speaking = false
let currentSource: AudioBufferSourceNode | null = null
/** Incremented on each speakText call so stale calls can detect pre-emption. */
let generation = 0

export function stopSpeaking(): void {
  generation++
  speaking = false
  window.api.tts.stop()
  if (currentSource) {
    try {
      currentSource.stop()
    } catch {
      // Already stopped
    }
    currentSource = null
  }
}

/**
 * Speak text aloud. If already speaking, stops current speech first.
 * Returns false if TTS is unavailable (module not installed).
 */
export async function speakText(text: string): Promise<boolean> {
  if (speaking) {
    stopSpeaking()
  }

  const myGeneration = ++generation
  speaking = true

  try {
    const result = await window.api.tts.speak(text)

    // Another call pre-empted us while we were awaiting synthesis
    if (myGeneration !== generation) return true

    if (!result.available) {
      return false
    }

    const ctx = getAudioContext()

    for (const chunk of result.chunks) {
      if (myGeneration !== generation) break

      // Data is Float32 PCM from the native module
      const samples = new Float32Array(chunk.samples)
      const audioBuffer = float32ToAudioBuffer(samples, chunk.sampleRate)
      const source = ctx.createBufferSource()
      source.buffer = audioBuffer
      source.connect(ctx.destination)
      currentSource = source

      await new Promise<void>((resolve) => {
        source.onended = () => resolve()
        source.start()
      })

      currentSource = null

      // Pause between chunks
      if (chunk.pauseAfterMs > 0 && myGeneration === generation) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, chunk.pauseAfterMs)
          const check = setInterval(() => {
            if (myGeneration !== generation) {
              clearTimeout(timer)
              clearInterval(check)
              resolve()
            }
          }, 50)
          setTimeout(() => clearInterval(check), chunk.pauseAfterMs + 100)
        })
      }
    }
  } catch {
    // TTS failed
  } finally {
    // Only clear state if we're still the active generation
    if (myGeneration === generation) {
      speaking = false
      currentSource = null
    }
  }
  return true
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
