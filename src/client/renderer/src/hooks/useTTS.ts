import { useRef, useCallback } from 'react'

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

export function useTTS() {
  const speakingRef = useRef(false)
  const abortRef = useRef(false)
  const currentSourceRef = useRef<AudioBufferSourceNode | null>(null)

  const stop = useCallback(() => {
    abortRef.current = true
    speakingRef.current = false
    window.api.tts.stop()
    if (currentSourceRef.current) {
      try {
        currentSourceRef.current.stop()
      } catch {
        // Already stopped
      }
      currentSourceRef.current = null
    }
  }, [])

  const speak = useCallback(async (text: string) => {
    if (speakingRef.current) {
      stop()
      return
    }

    speakingRef.current = true
    abortRef.current = false

    try {
      const result = await window.api.tts.speak(text)
      const ctx = getAudioContext()

      for (const chunk of result.chunks) {
        if (abortRef.current) break

        // Data is Float32 PCM from the native module
        const samples = new Float32Array(chunk.samples)
        const audioBuffer = float32ToAudioBuffer(samples, chunk.sampleRate)
        const source = ctx.createBufferSource()
        source.buffer = audioBuffer
        source.connect(ctx.destination)
        currentSourceRef.current = source

        await new Promise<void>((resolve) => {
          source.onended = () => resolve()
          source.start()
        })

        currentSourceRef.current = null

        // Pause between chunks
        if (chunk.pauseAfterMs > 0 && !abortRef.current) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, chunk.pauseAfterMs)
            const check = setInterval(() => {
              if (abortRef.current) {
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
      speakingRef.current = false
      currentSourceRef.current = null
    }
  }, [stop])

  const isSpeaking = useCallback(() => speakingRef.current, [])

  return { speak, stop, isSpeaking }
}
