import { beginRecordingSession } from './audio-session'
import { playCue } from './cues'
import { nativeMicrophoneAvailable, openNativeMicrophone } from './native-microphone'
import { recordMobileEvent } from './mobile-events'

/**
 * The microphone, held open between dictations — as Voice Operator does on the
 * Mac with "Keep Microphone Always On".
 *
 * Opening a microphone makes a Bluetooth headset renegotiate its codec: AirPods
 * drop out of their music profile into the voice one, and back again when it
 * closes. That is the wait before a dictation can hear you, and the quality
 * shift in whatever is playing. Held open, a dictation only starts listening to
 * a stream that is already flowing; between dictations the audio is dropped
 * here, on the phone, and nothing is sent anywhere.
 *
 * In the iPhone app, the app holds it (native-microphone.ts), with or without
 * a headset, and holding it is hands-free mode: the phone listens for
 * "Control" on its own (hands-free.ts).
 *
 * In a browser, only while the input is a headset. WebKit can hold a
 * microphone only in play-and-record, which on the phone's own speaker plays
 * through the earpiece — so held open without AirPods, every spoken answer
 * would come out as a whisper. Voice Operator has the same rule ("Only When
 * Using AirPods").
 *
 * Remembered per device. iOS only opens a microphone inside a tap, so after a
 * relaunch, or after iOS takes the microphone away in the background, the hold
 * comes back on the next touch anywhere, or with the next dictation.
 */

const log = (message: string) => window.api?.log(`[held-mic] ${message}`)

const KEY = 'mobile.holdMicrophone'

/** A microphone label that is a headset rather than the phone itself. */
export function isHeadset(label: string): boolean {
  return /airpods|bluetooth|headset|headphone|beats|buds|hands-?free/i.test(label)
}

/** One open microphone, and who is listening to it: the page's own, or the app's. */
export interface Capture {
  /** Hz of the blocks `listen` hands out. */
  readonly sampleRate: number
  /** Blocks of audio from now on, until the returned function is called. */
  listen(fn: (block: Float32Array) => void): () => void
  /** Whether it is still delivering: not closed, and its track still live. */
  healthy(): boolean
  /**
   * Done with it for this dictation. A held capture stays open unless it is
   * `broken` (it went silent); a capture that is not held closes.
   */
  release(broken?: boolean): void
  /** Its state, for the log. */
  describe(): string
}

const WORKLET = `
class Tap extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0]
    if (channel) this.port.postMessage(channel.slice(0))
    return true
  }
}
registerProcessor('spaceterm-tap', Tap)
`

/**
 * Open the microphone. Must be called inside a tap: the AudioContext is
 * created before the first await, as iOS requires.
 */
export async function openCapture(): Promise<{
  context: AudioContext; stream: MediaStream; node: AudioWorkletNode; close: () => void
}> {
  const context = new AudioContext()
  void context.resume()
  // Earpiece-default play-and-record only while the microphone is open.
  const releaseSession = beginRecordingSession()
  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    })
  } catch (err) {
    releaseSession()
    void context.close()
    recordMobileEvent('mic-open-failed', { source: 'web', error: err instanceof Error ? `${err.name} ${err.message}` : String(err) })
    log(`getUserMedia refused: ${err instanceof Error ? `${err.name} ${err.message}` : String(err)} (secure ${window.isSecureContext}, page ${document.visibilityState})`)
    throw new Error(
      window.isSecureContext
        ? 'Microphone permission was refused'
        : 'The microphone needs HTTPS — open Spaceterm through its tailscale address'
    )
  }
  const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }))
  try {
    await context.audioWorklet.addModule(url)
    const source = context.createMediaStreamSource(stream)
    const node = new AudioWorkletNode(context, 'spaceterm-tap')
    source.connect(node)
    let closed = false
    recordMobileEvent('mic-opened', { source: 'web', input: stream.getAudioTracks()[0]?.label ?? '' })
    const close = () => {
      if (closed) return
      closed = true
      recordMobileEvent('mic-closed', { source: 'web', input: stream.getAudioTracks()[0]?.label ?? '' })
      node.port.onmessage = null
      node.disconnect()
      stream.getTracks().forEach((t) => t.stop())
      void context.close()
      releaseSession()
    }
    return { context, stream, node, close }
  } catch (err) {
    stream.getTracks().forEach((t) => t.stop())
    releaseSession()
    void context.close()
    throw err
  } finally {
    URL.revokeObjectURL(url)
  }
}

/** The state of everything between the microphone and the worklet, for the log. */
function describeWebCapture(stream: MediaStream, context: AudioContext): string {
  const tracks = stream.getAudioTracks().map((t) => `${t.readyState}${t.muted ? ' muted' : ''}${t.enabled ? '' : ' disabled'} "${t.label}"`)
  return `context ${context.state} @${context.sampleRate}Hz, track ${tracks.join(', ') || 'none'}`
}

/** A capture's audio, fanned out to whoever is listening. */
function captureOf(opened: Awaited<ReturnType<typeof openCapture>>, release: (broken: boolean) => void): Capture {
  const listeners = new Set<(block: Float32Array) => void>()
  opened.node.port.onmessage = (event: MessageEvent<Float32Array>) => {
    for (const fn of listeners) fn(event.data)
  }
  const { context, stream } = opened
  context.onstatechange = () => {
    log(`context now ${context.state}`)
    recordMobileEvent('mic-context', { state: context.state })
  }
  for (const track of stream.getAudioTracks?.() ?? []) {
    const noted = (event: string) => () => {
      log(`track ${event}`)
      recordMobileEvent('mic-track', { event, input: track.label })
    }
    track.onmute = noted('muted')
    track.onunmute = noted('unmuted')
    track.onended = noted('ended')
  }
  return {
    sampleRate: context.sampleRate,
    describe: () => describeWebCapture(stream, context),
    listen(fn) {
      listeners.add(fn)
      return () => { listeners.delete(fn) }
    },
    healthy() {
      return opened.context.state !== 'closed' && opened.stream.getAudioTracks().some((t) => t.readyState === 'live')
    },
    release(broken = false) {
      listeners.clear()
      release(broken)
    },
  }
}

/**
 * `preparing`: turned on, but not holding a microphone yet — opening one, or
 * waiting for a headset or for the tap that lets iOS open it.
 */
export type HoldState = 'off' | 'preparing' | 'held'

let wanted = (() => {
  try { return localStorage.getItem(KEY) === '1' } catch { return false }
})()
/** `headset`: the label of a held web microphone, rechecked when devices change. Absent for the app's own. */
let held: { capture: Capture; close: () => void; headset?: string } | undefined
let opening: Promise<Capture> | undefined
const stateListeners = new Set<(state: HoldState) => void>()
/** Nothing is held at load: the hold, if wanted, comes back with the next tap. */
let lastState: HoldState = wanted ? 'preparing' : 'off'

export function holdState(): HoldState {
  if (!wanted) return 'off'
  return held?.capture.healthy() ? 'held' : 'preparing'
}

export function onHoldStateChange(fn: (state: HoldState) => void): () => void {
  stateListeners.add(fn)
  return () => { stateListeners.delete(fn) }
}

/**
 * Tell the button, and sound the hold taking or letting go of the microphone:
 * the moment the always-on mode really starts or stops, not the tap that asked.
 */
function announce(): void {
  const state = holdState()
  const before = lastState
  lastState = state
  if (state === before) return
  recordMobileEvent('hold-state', { from: before, to: state })
  if (state === 'held') playCue('holdEngaged')
  else if (before === 'held') playCue('holdReleased')
  for (const fn of stateListeners) fn(state)
}

export function holdsMicrophone(): boolean {
  return wanted
}


/** The microphone held open now, if it is: what hands-free mode listens to. */
export function heldCapture(): Capture | undefined {
  return held?.capture.healthy() ? held.capture : undefined
}

/**
 * Turn holding on or off, remembered on this phone. In a browser call it
 * inside a tap: turning it on opens the microphone now.
 */
export function setHoldMicrophone(on: boolean): void {
  wanted = on
  try { localStorage.setItem(KEY, on ? '1' : '0') } catch { /* private mode: this session only */ }
  log(on ? 'turned on' : 'turned off')
  recordMobileEvent('hold-wanted', { on })
  if (on) void acquire().then((capture) => capture.release(), () => undefined)
  else closeHeld('turned off')
  announce()
}

function closeHeld(why: string): void {
  if (!held) return
  log(`closing: ${why}`)
  recordMobileEvent('hold-closed', { why })
  held.close()
  held = undefined
  announce()
}

/**
 * A capture for one dictation: the held one if it is open and well, a newly
 * held one if holding is on and the input is a headset, otherwise one that
 * closes when the dictation releases it. Call inside a tap.
 */
export function acquire(): Promise<Capture> {
  if (held?.capture.healthy()) {
    log('using the held microphone')
    return Promise.resolve(held.capture)
  }
  if (held) closeHeld('it stopped delivering')
  if (opening) return opening
  opening = (async () => {
    // The app's own microphone: no headset needed, and no tap.
    if (wanted && nativeMicrophoneAvailable()) {
      const native = await openNativeMicrophone()
      const capture: Capture = {
        sampleRate: native.sampleRate,
        listen: (fn) => native.listen(fn),
        healthy: () => native.healthy(),
        describe: () => native.describe(),
        release: (broken = false) => { if (broken) closeHeld('it went silent') },
      }
      held = { capture, close: () => native.close() }
      log('holding the app\'s own microphone open')
      recordMobileEvent('hold-opened', { source: 'native', input: native.describe() })
      announce()
      return capture
    }
    const opened = await openCapture()
    const label = opened.stream.getAudioTracks()[0]?.label ?? ''
    if (wanted && isHeadset(label)) {
      const capture = captureOf(opened, (broken) => { if (broken) closeHeld('it went silent') })
      held = { capture, close: opened.close, headset: label }
      log(`holding "${label}" open`)
      recordMobileEvent('hold-opened', { source: 'web', input: label })
      announce()
      return capture
    }
    if (wanted) {
      log(`not holding "${label}": not a headset, and held open it would play through the earpiece`)
      recordMobileEvent('hold-skipped', { input: label, why: 'not a headset' })
    }
    return captureOf(opened, () => opened.close())
  })().finally(() => { opening = undefined })
  return opening
}

/** Movement that still counts as a tap. */
const TAP_SLOP_PX = 10
/** How often the app's own microphone is checked on, and taken back if it stopped. */
const NATIVE_CHECK_MS = 5000

/**
 * Bring the hold back after a relaunch or a background trip. In the app that
 * needs nothing from the user: its microphone is opened now, and again
 * whenever it is found to have stopped.
 */
function installNativeHold(): () => void {
  const check = () => {
    announce()
    if (!wanted || held?.capture.healthy() || opening) return
    if (held) closeHeld('it stopped delivering')
    void acquire().then((capture) => capture.release(), (err) => {
      const error = err instanceof Error ? err.message : String(err)
      log(`could not open the app's microphone: ${error}`)
      recordMobileEvent('mic-open-failed', { source: 'native', error })
    })
  }
  check()
  const timer = setInterval(check, NATIVE_CHECK_MS)
  const onVisible = () => { if (document.visibilityState === 'visible') check() }
  document.addEventListener('visibilitychange', onVisible)
  return () => {
    clearInterval(timer)
    document.removeEventListener('visibilitychange', onVisible)
  }
}

/**
 * Bring the hold back after a relaunch or a background trip. In a browser iOS
 * opens a microphone only inside a gesture, so the next tap anywhere does it,
 * and a headset coming or going is rechecked too.
 */
export function installHeldMicrophone(): () => void {
  if (nativeMicrophoneAvailable()) return installNativeHold()
  /**
   * Set when an attempt found no headset to hold (or no microphone at all):
   * nothing changes that until a device comes or goes. Without it every touch
   * opened the phone's microphone, an audio context and a worklet, and shut
   * them again — a burst of them per pinch.
   */
  let waitForDevice = false
  const reopen = () => {
    if (!wanted || waitForDevice || held?.capture.healthy() || opening) return
    void acquire().then((capture) => {
      if (held?.capture !== capture) waitForDevice = true
      capture.release()
    }, (err) => {
      waitForDevice = true
      log(`could not reopen: ${err instanceof Error ? err.message : String(err)}`)
    })
  }
  // A tap, not any touch: a pan or a pinch is no moment to be opening a
  // microphone. The tap's release still counts as the gesture iOS requires.
  const down = new Map<number, { x: number; y: number }>()
  /** The touch under way has had two fingers down at once: a pinch, whichever finger lifts last. */
  let manyFingers = false
  const onDown = (e: PointerEvent) => {
    down.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (down.size > 1) manyFingers = true
  }
  const onUp = (e: PointerEvent) => {
    const start = down.get(e.pointerId)
    down.delete(e.pointerId)
    const tapped = start && !manyFingers && Math.hypot(e.clientX - start.x, e.clientY - start.y) < TAP_SLOP_PX
    if (down.size === 0) manyFingers = false
    if (tapped) reopen()
  }
  const onCancel = (e: PointerEvent) => {
    down.delete(e.pointerId)
    if (down.size === 0) manyFingers = false
  }
  const onDeviceChange = () => {
    waitForDevice = false
    if (held && (!held.capture.healthy() || !isHeadset(held.headset ?? ''))) closeHeld('the headset went away')
  }
  const options = { capture: true, passive: true }
  document.addEventListener('pointerdown', onDown, options)
  document.addEventListener('pointerup', onUp, options)
  document.addEventListener('pointercancel', onCancel, options)
  navigator.mediaDevices?.addEventListener?.('devicechange', onDeviceChange)
  return () => {
    document.removeEventListener('pointerdown', onDown, options)
    document.removeEventListener('pointerup', onUp, options)
    document.removeEventListener('pointercancel', onCancel, options)
    navigator.mediaDevices?.removeEventListener?.('devicechange', onDeviceChange)
  }
}
