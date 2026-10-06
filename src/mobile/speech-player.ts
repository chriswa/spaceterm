import type { RemoteSpeechApi } from '../shared/api'
import { audioContext, noteSilenced, noteSounding } from './cues'
import { describeAudioSession } from './audio-session'
import { recordMobileEvent } from './mobile-events'

/**
 * Plays speech sent to this phone (src/server/remote-speech.ts): Summary
 * Chat's answers, synthesized by Voice Operator on the Mac and sent here a
 * sentence at a time.
 *
 * Sentences are scheduled back to back on the audio clock as they arrive, so
 * a fast synthesizer plays without gaps and a slow one simply pauses between
 * sentences. Jobs queue the same way, one after another — "let me check" and
 * the answer behind it used to be scheduled each from now, and played over
 * each other. Each sentence's start and end are reported, and the server turns
 * them into how far the listener got — what an interruption needs.
 *
 * iOS lets a page start audio only from a tap, and an answer arrives seconds
 * after the tap that asked for it. So every tap anywhere wakes the shared
 * audio context; by the time the first sentence lands it is running.
 */

interface Playing {
  sources: AudioBufferSourceNode[]
  timers: number[]
  /** Audio-clock time the last scheduled sentence ends. */
  endsAt: number
}

/** Bytes of s16le PCM to a float buffer at its own rate. */
function toBuffer(ctx: AudioContext, pcmBase64: string, sampleRate: number): AudioBuffer {
  const bytes = Uint8Array.from(atob(pcmBase64), (c) => c.charCodeAt(0))
  const samples = new Int16Array(bytes.buffer, 0, bytes.length >> 1)
  const buffer = ctx.createBuffer(1, Math.max(1, samples.length), sampleRate)
  const out = buffer.getChannelData(0)
  for (let i = 0; i < samples.length; i++) out[i] = samples[i] / 32768
  return buffer
}

export function startSpeechPlayer(api: RemoteSpeechApi, log: (message: string) => void): () => void {
  const jobs = new Map<string, Playing>()
  /** Audio-clock time everything scheduled so far ends, across every job. */
  const queueEnd = () => Math.max(0, ...[...jobs.values()].map((job) => job.endsAt))

  const wake = () => {
    const ctx = audioContext()
    if (ctx && ctx.state !== 'running') void ctx.resume()
  }
  document.addEventListener('touchend', wake, { capture: true, passive: true })

  const stop = (id: string) => {
    const job = jobs.get(id)
    if (!job) return
    // Cut off by the server: interrupted, or superseded.
    recordMobileEvent('speech-stopped', { id: id.slice(0, 11) })
    jobs.delete(id)
    for (const timer of job.timers) clearTimeout(timer)
    for (const source of job.sources) {
      source.onended = null
      try { source.stop() } catch { /* never started */ }
    }
    // Cut off, so silent now — unless another job is still queued behind it.
    if (jobs.size === 0) noteSilenced()
  }

  const offAudio = api.onAudio(({ id, index, count, sampleRate, pcm }) => {
    const ctx = audioContext()
    if (!ctx) {
      api.progress(id, index, 'failed')
      return
    }
    if (ctx.state !== 'running') void ctx.resume()
    let job = jobs.get(id)
    if (!job) {
      job = { sources: [], timers: [], endsAt: 0 }
      jobs.set(id, job)
      // The ctx says whether a dictation or hands-free was under way: an answer talking over the speaker.
      recordMobileEvent('speech-start', { id: id.slice(0, 11), sentences: count, audio: ctx.state })
    }
    const playing = job
    const buffer = toBuffer(ctx, pcm, sampleRate)
    const source = ctx.createBufferSource()
    source.buffer = buffer
    source.connect(ctx.destination)
    const at = Math.max(ctx.currentTime + 0.05, queueEnd())
    playing.endsAt = at + buffer.duration
    source.onended = () => {
      api.progress(id, index, 'finished')
      if (index === count - 1) {
        jobs.delete(id)
        recordMobileEvent('speech-end', { id: id.slice(0, 11) })
      }
    }
    source.start(at)
    noteSounding(ctx, playing.endsAt)
    playing.sources.push(source)
    playing.timers.push(window.setTimeout(() => api.progress(id, index, 'started'), Math.max(0, (at - ctx.currentTime) * 1000)))
    // The session's mode is where it is heard: play-and-record with no microphone open plays at the earpiece.
    log(`[speech] ${id.slice(0, 11)} sentence ${index + 1}/${count}, ${buffer.duration.toFixed(1)}s in ${(at - ctx.currentTime).toFixed(1)}s (audio ${ctx.state}; ${describeAudioSession()})`)
  })

  const offStop = api.onStop(stop)

  return () => {
    document.removeEventListener('touchend', wake, { capture: true })
    offAudio()
    offStop()
    for (const id of [...jobs.keys()]) stop(id)
  }
}
