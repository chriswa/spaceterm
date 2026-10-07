/**
 * The iPhone app's own microphone, as the page sees it.
 *
 * WebKit can hold a microphone open only in play-and-record, which on the
 * phone's speaker plays everything through the earpiece — so the page holds
 * one only with a headset (held-microphone.ts). The native app has no such
 * limit: it records with its own audio session, set to the speaker by default
 * and to mix with the page's sound, so Control still answers out loud. It
 * keeps recording with the screen locked, recovers from Siri and calls, and
 * follows AirPods coming and going, all without a tap. Verified on an iPhone
 * 17 (spike/native-audio-test, October 2026); see `NativeMicrophone.swift`.
 *
 * The page asks for it to start and stop; the app hands back 16 kHz signed
 * 16-bit mono a tenth of a second at a time, and says when it is running.
 *
 * Only ever one recorder: once the app holds the microphone, nothing on the
 * page may open its own (getUserMedia), or iOS cuts the app's off for good.
 */

export const NATIVE_SAMPLE_RATE = 16_000

/** How long without audio before the native microphone is taken to have stopped. */
const STALE_MS = 3000
/** How long a start may take: AVAudioEngine waits on the hardware. */
const START_TIMEOUT_MS = 5000

interface NativeState {
  running: boolean
  /** The input in use, e.g. "iPhone Microphone" or "AirPods Pro". */
  input?: string
  error?: string
  /** The app plays Control's voice itself while running (`speech-play`); an older app does not say so. */
  speech?: boolean
  /** Its engine has Apple's voice processing — echo cancellation — on. */
  voiceProcessing?: boolean
  /**
   * Its engine is up without the microphone, keeping the app awake while this
   * phone holds Control (`keepAppAwake`), and plays Control's voice all the
   * same. An older app does not say so.
   */
  awake?: boolean
}

/** A sentence of Control's voice, as the app plays it: begun, heard to its end, or not playable. */
export interface NativeSpeechEvent {
  id: string
  index: number
  event: 'started' | 'finished' | 'failed'
  /** The sentence's own loudness, RMS dBFS: what the microphone would hear of it uncancelled. */
  outputDb?: number
}

/** What the app calls on the page. Installed on `window` before the app sends anything. */
interface NativeMicrophoneHost {
  audio(pcmBase64: string): void
  state(state: NativeState): void
  speech(event: NativeSpeechEvent): void
}

declare global {
  interface Window {
    spacetermNativeMicrophone?: NativeMicrophoneHost
    webkit?: { messageHandlers?: Record<string, { postMessage(message: unknown): void } | undefined> }
  }
}

import { recordMobileEvent } from './mobile-events'

const log = (message: string) => window.api?.log(`[native-mic] ${message}`)

function handler() {
  return window.webkit?.messageHandlers?.nativeMicrophone
}

/** Whether this page runs inside the iPhone app, which has a microphone of its own. */
export function nativeMicrophoneAvailable(): boolean {
  return handler() !== undefined
}

let state: NativeState = { running: false }
let lastAudio = 0
let startedAt = 0
let receivedSamples = 0
const listeners = new Set<(block: Float32Array) => void>()
const speechListeners = new Set<(event: NativeSpeechEvent) => void>()
const stateWaiters = new Set<(state: NativeState) => void>()

function decode(pcmBase64: string): Float32Array {
  const bytes = Uint8Array.from(atob(pcmBase64), (c) => c.charCodeAt(0))
  const samples = new Int16Array(bytes.buffer, 0, bytes.length >> 1)
  const out = new Float32Array(samples.length)
  for (let i = 0; i < samples.length; i++) out[i] = samples[i] / 32768
  return out
}

function install(): void {
  if (window.spacetermNativeMicrophone) return
  window.spacetermNativeMicrophone = {
    audio(pcmBase64) {
      lastAudio = performance.now()
      const block = decode(pcmBase64)
      receivedSamples += block.length
      for (const fn of listeners) fn(block)
    },
    state(next) {
      if (next.running !== state.running || next.input !== state.input || next.error !== state.error) {
        log(`${next.running ? 'running' : 'stopped'}${next.input ? ` on "${next.input}"` : ''}${next.error ? `: ${next.error}` : ''}`)
        // The input changing is AirPods coming or going.
        recordMobileEvent('native-mic-state', { running: next.running, input: next.input ?? null, error: next.error ?? null, was: { running: state.running, input: state.input ?? null } })
      }
      state = next
      for (const fn of [...stateWaiters]) fn(next)
    },
    speech(event) {
      for (const fn of speechListeners) fn(event)
    },
  }
}

/**
 * Control's voice, played by the app — through the same engine as its
 * microphone, with echo cancellation, so hands-free can hear the user through
 * it (NativeMicrophone.swift); or, with the microphone off, through the engine
 * that keeps the app awake. Only while that engine runs, and only an app that
 * says it can.
 */
export const nativeSpeech = {
  /**
   * With the microphone on, only with echo cancellation on: played by the app
   * without it, Control's voice would be heard as someone talking — turning
   * itself down, and keeping "Control" from ever counting. Then the page
   * plays it, and hands-free stands aside, as before. With it off there is
   * nobody listening to hear it, and the app plays it: a page in the
   * background may not be able to.
   */
  available(): boolean {
    if (handler() === undefined || state.speech !== true) return false
    return state.running ? state.voiceProcessing === true : state.awake === true
  },
  voiceProcessing(): boolean {
    return state.voiceProcessing === true
  },
  play(id: string, index: number, count: number, sampleRate: number, pcm: string): void {
    handler()?.postMessage({ action: 'speech-play', id, index, count, sampleRate, pcm })
  },
  stop(id: string): void {
    handler()?.postMessage({ action: 'speech-stop', id })
  },
  /** Turn Control down while the user may be talking over it; back up with `false`. */
  duck(on: boolean): void {
    handler()?.postMessage({ action: 'speech-duck', on })
  },
  onEvent(fn: (event: NativeSpeechEvent) => void): () => void {
    install()
    speechListeners.add(fn)
    return () => { speechListeners.delete(fn) }
  },
}

/**
 * Keep the app running in the background, or let it be suspended again.
 *
 * iOS suspends an app whose audio is not running, and the page and its
 * connection with it, so Control could not be heard with the phone locked
 * unless hands-free held the microphone. Asked for while this phone holds
 * Control (`stay-awake.ts`); the app runs its audio engine without the
 * microphone to stay awake. Nothing in a browser.
 */
export function keepAppAwake(on: boolean): void {
  install()
  handler()?.postMessage({ action: 'stay-awake', on })
}

/** A tap the user can feel, from the app; nothing in a browser. */
export function nativeHaptic(): void {
  handler()?.postMessage({ action: 'haptic' })
}

/** The native microphone, opened. */
export interface NativeCaptureHandle {
  readonly sampleRate: number
  listen(fn: (block: Float32Array) => void): () => void
  healthy(): boolean
  describe(): string
  close(): void
}

/** Start the app's microphone. Needs no tap. Rejects with the app's reason. */
export async function openNativeMicrophone(): Promise<NativeCaptureHandle> {
  install()
  const post = handler()
  if (!post) throw new Error('This is not the Spaceterm app, so it has no microphone of its own')
  startedAt = performance.now()
  lastAudio = 0
  receivedSamples = 0
  const running = new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const check = (s: NativeState) => {
      if (!s.running && !s.error) return
      clearTimeout(timer)
      stateWaiters.delete(check)
      if (s.running) resolve()
      else reject(new Error(`The app's microphone could not start: ${s.error}`))
    }
    timer = setTimeout(() => { stateWaiters.delete(check); reject(new Error('The app\'s microphone did not start')) }, START_TIMEOUT_MS)
    stateWaiters.add(check)
  })
  post.postMessage({ action: 'start' })
  await running
  let closed = false
  return {
    sampleRate: NATIVE_SAMPLE_RATE,
    listen(fn) {
      listeners.add(fn)
      return () => { listeners.delete(fn) }
    },
    healthy() {
      if (closed || !state.running) return false
      const since = lastAudio || startedAt
      return performance.now() - since < STALE_MS
    },
    describe() {
      const seconds = receivedSamples / NATIVE_SAMPLE_RATE
      const age = lastAudio ? `${Math.round(performance.now() - lastAudio)}ms ago` : 'none yet'
      return `native ${state.running ? 'running' : 'stopped'} on "${state.input ?? '?'}", ${seconds.toFixed(1)}s received, last audio ${age}`
    },
    close() {
      if (closed) return
      closed = true
      listeners.clear()
      recordMobileEvent('mic-closed', { source: 'native' })
      post.postMessage({ action: 'stop' })
    },
  }
}
