import type { RemoteSpeechApi } from '../shared/api'
import { audioContext, noteSilenced, noteSounding } from './cues'
import { describeAudioSession } from './audio-session'
import { recordMobileEvent } from './mobile-events'
import { nativeSpeech } from './native-microphone'

/**
 * Plays speech sent to this phone (src/server/remote-speech.ts): Control's
 * replies while this phone holds it, synthesized by Voice Operator on the Mac
 * and sent here a sentence at a time.
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
 *
 * In the app, while it holds the microphone, an answer is played by the app
 * instead (native-microphone.ts `nativeSpeech`): through the microphone's own
 * engine, with echo cancellation, so hands-free can hear the user say
 * "Control" over it. The app reports each sentence's start and end, which go
 * to the server just the same. A job stays wherever its first sentence went —
 * unless the app says nothing of it at all (`NATIVE_SILENT_MS`), and then the
 * page takes it back and plays it itself.
 */

/**
 * How long the app may take to say it has begun a job sent while it had
 * nothing else to play. It answers at once when it can; silence means its
 * engine is not running whatever it last said — iOS stopped it under the
 * app (October 2026: the page's own dictation interrupted it, and Control
 * was never heard again until the app was restarted).
 */
export const NATIVE_SILENT_MS = 3000

interface NativeJob {
  count: number
  /** Until the app says anything of it: its sentences, to play in the page instead. */
  unheard?: Sentence[]
  watchdog?: number
}

/** Jobs the app is playing, by id. */
const nativeJobs = new Map<string, NativeJob>()
let lastOutputDb: number | undefined
/** The app's `engineEpoch` when it last went silent on a job: not trusted again until its engine has changed. */
let silentAtEpoch: number | undefined

/** What hands-free needs of the app's playback: whether it is playing, and how loud. */
export const nativePlayback = {
  playing: (): boolean => nativeJobs.size > 0,
  /** The loudness of the last sentence it began, RMS dBFS. */
  outputDb: (): number | undefined => lastOutputDb,
}

type Sentence = Parameters<Parameters<RemoteSpeechApi['onAudio']>[0]>[0]

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
    const native = nativeJobs.get(id)
    if (native) {
      clearTimeout(native.watchdog)
      nativeJobs.delete(id)
      recordMobileEvent('speech-stopped', { id: id.slice(0, 11), native: true })
      nativeSpeech.stop(id)
      return
    }
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

  const offNative = nativeSpeech.onEvent(({ id, index, event, outputDb }) => {
    const job = nativeJobs.get(id)
    if (!job) return
    clearTimeout(job.watchdog)
    // Could not play the first of it at all: the page can.
    if (event === 'failed' && job.unheard) return takeBack(id, 'could not play it')
    job.unheard = undefined
    if (outputDb !== undefined && event === 'started') lastOutputDb = outputDb
    api.progress(id, index, event)
    if (event !== 'started' && index === job.count - 1) {
      nativeJobs.delete(id)
      recordMobileEvent('speech-end', { id: id.slice(0, 11), native: true })
    }
  })

  /** The app said nothing of a job it should have begun at once: take it back, and play it here. */
  function takeBack(id: string, why: string): void {
    const job = nativeJobs.get(id)
    if (!job?.unheard) return
    clearTimeout(job.watchdog)
    nativeJobs.delete(id)
    nativeSpeech.stop(id)
    silentAtEpoch = nativeSpeech.engineEpoch()
    recordMobileEvent('native-speech-taken-back', { id: id.slice(0, 11), why, sentences: job.unheard.length })
    log(`[speech] ${id.slice(0, 11)}: the app ${why} — playing it here, and not through the app until its engine starts again`)
    for (const sentence of job.unheard) playInPage(sentence)
  }

  const appCanPlay = () => nativeSpeech.available() && silentAtEpoch !== nativeSpeech.engineEpoch()

  const offAudio = api.onAudio((sentence) => {
    const { id, index, count, sampleRate, pcm } = sentence
    let native = nativeJobs.get(id)
    if (!native && !jobs.has(id) && appCanPlay()) {
      native = { count }
      // With nothing ahead of it, the app begins it at once — and says so.
      if (nativeJobs.size === 0) {
        native.unheard = []
        native.watchdog = window.setTimeout(() => takeBack(id, `said nothing of it in ${NATIVE_SILENT_MS / 1000}s`), NATIVE_SILENT_MS)
      }
      nativeJobs.set(id, native)
      recordMobileEvent('speech-start', { id: id.slice(0, 11), sentences: count, native: true, voiceProcessing: nativeSpeech.voiceProcessing() })
    }
    if (native) {
      native.unheard?.push(sentence)
      nativeSpeech.play(id, index, count, sampleRate, pcm)
      log(`[speech] ${id.slice(0, 11)} sentence ${index + 1}/${count} to the app (echo cancellation ${nativeSpeech.voiceProcessing() ? 'on' : 'off'})`)
      return
    }
    playInPage(sentence)
  })

  function playInPage({ id, index, count, sampleRate, pcm }: Sentence): void {
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
  }

  const offStop = api.onStop(stop)

  return () => {
    document.removeEventListener('touchend', wake, { capture: true })
    offAudio()
    offStop()
    offNative()
    for (const id of [...jobs.keys(), ...nativeJobs.keys()]) stop(id)
  }
}
