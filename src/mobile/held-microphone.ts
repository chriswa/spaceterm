import { beginRecordingSession } from './audio-session'
import { nativeMicrophoneAvailable, openNativeMicrophone, type NativeCaptureHandle } from './native-microphone'
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
 * Off at every launch: not remembered, so a relaunched app never starts
 * listening on its own. iOS only opens a microphone inside a tap, so after iOS
 * takes the microphone away in the background, the hold comes back on the
 * next touch anywhere, or with the next dictation.
 */

const log = (message: string) => window.api?.log(`[held-mic] ${message}`)

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
  const began = performance.now()
  const context = new AudioContext()
  void context.resume()
  // Earpiece-default play-and-record only while the microphone is open.
  const releaseSession = beginRecordingSession()
  let stream: MediaStream
  /** How long each step took, for `mic-open-steps`: where a slow start went. */
  const steps: Record<string, number> = {}
  let stepStart = began
  const step = (name: string) => {
    const now = performance.now()
    steps[name] = Math.round(now - stepStart)
    stepStart = now
  }
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
  step('getUserMedia')
  const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }))
  try {
    await context.audioWorklet.addModule(url)
    step('worklet')
    const source = context.createMediaStreamSource(stream)
    const node = new AudioWorkletNode(context, 'spaceterm-tap')
    source.connect(node)
    step('nodes')
    let closed = false
    recordMobileEvent('mic-opened', { source: 'web', input: stream.getAudioTracks()[0]?.label ?? '' })
    recordMobileEvent('mic-open-steps', { ...steps, totalMs: Math.round(performance.now() - began) })
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

/** Every capture of WebKit's microphone, as opposed to the app's own. */
const webCaptures = new WeakSet<Capture>()

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
  const capture: Capture = {
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
  webCaptures.add(capture)
  return capture
}

/**
 * `preparing`: turned on, but not holding a microphone yet — opening one, or
 * waiting for a headset or for the tap that lets iOS open it.
 */
export type HoldState = 'off' | 'preparing' | 'held'

let wanted = false
/**
 * `headset`: the label of a held web microphone, rechecked when devices change.
 * `native`: the app's own, which the page never closes while the hold is on —
 * see `installNativeHold`.
 */
let held: { capture: Capture; close: () => void; headset?: string; native?: boolean } | undefined
let opening: Promise<Capture> | undefined
const stateListeners = new Set<(state: HoldState) => void>()
let lastState: HoldState = 'off'

export function holdState(): HoldState {
  if (!wanted) return 'off'
  return held?.capture.healthy() ? 'held' : 'preparing'
}

export function onHoldStateChange(fn: (state: HoldState) => void): () => void {
  stateListeners.add(fn)
  return () => { stateListeners.delete(fn) }
}

/**
 * Tell the button the hold taking or letting go of the microphone: the moment
 * the always-on mode really starts or stops, not the tap that asked. Silent:
 * the lock button shows it, and the microphone reopening itself after a stall
 * used to sound as a release and a take, over and over.
 */
function announce(): void {
  const state = holdState()
  const before = lastState
  lastState = state
  if (state === before) return
  recordMobileEvent('hold-state', { from: before, to: state })
  for (const fn of stateListeners) fn(state)
}

export function holdsMicrophone(): boolean {
  return wanted
}


/**
 * The microphone held open now, if it is: what hands-free mode listens to.
 * The app's own stays the one even while it delivers nothing: the app is
 * bringing it back, and hands-free carries on with it when it does.
 */
export function heldCapture(): Capture | undefined {
  if (held?.native) return held.capture
  return held?.capture.healthy() ? held.capture : undefined
}

/**
 * Turn holding on or off, until the app is next launched. In a browser call
 * it inside a tap: turning it on opens the microphone now.
 */
export function setHoldMicrophone(on: boolean): void {
  wanted = on
  log(on ? 'turned on' : 'turned off')
  recordMobileEvent('hold-wanted', { on })
  if (on) void acquire().then((capture) => capture.release(), () => undefined)
  else closeHeld('turned off')
  announce()
}

function closeHeld(why: string): void {
  if (!held) return
  log(`closing: ${why}`)
  recordMobileEvent('hold-closed', { why, capture: held.capture.describe() })
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
  if (held?.capture.healthy() || held?.native) {
    log(held.capture.healthy() ? 'using the held microphone' : 'using the held microphone, which the app is bringing back')
    return Promise.resolve(held.capture)
  }
  if (held) closeHeld('it stopped delivering')
  if (opening) return opening
  opening = (async () => {
    // The app's own microphone: no headset needed, and no tap.
    if (wanted && nativeMicrophoneAvailable()) {
      const native = await openNativeMicrophone()
      // Released by each dictation, broken or not, and kept: the app recovers its own microphone.
      const capture = nativeCapture(native, () => undefined)
      held = { capture, close: () => native.close(), native: true }
      log('holding the app\'s own microphone open')
      recordMobileEvent('hold-opened', { source: 'native', input: native.describe() })
      announce()
      return capture
    }
    // In the app, every dictation uses the app's own microphone. WebKit's
    // interrupts other apps' audio — music stops — and never tells it to
    // carry on (it deactivates without notifying others), so Spotify stayed
    // stopped after every dictation; the app stops it too, but tells it to
    // carry on once the dictation is over (NativeMicrophone.swift `Others`). It also skips WebKit's second-long
    // freeze of the page while its microphone starts.
    if (nativeMicrophoneAvailable()) return openAppCapture()
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

function nativeCapture(native: NativeCaptureHandle, release: (broken: boolean) => void): Capture {
  return {
    sampleRate: native.sampleRate,
    listen: (fn) => native.listen(fn),
    healthy: () => native.healthy(),
    describe: () => native.describe(),
    release: (broken = false) => release(broken),
  }
}

/** The app's own microphone for one dictation, closed when it is released. */
async function openAppCapture(): Promise<Capture> {
  const native = await openNativeMicrophone({ mute: true })
  recordMobileEvent('mic-opened', { source: 'native', input: native.describe() })
  return nativeCapture(native, () => native.close())
}

/**
 * The app's own microphone in place of a capture of WebKit's that has sent
 * nothing — live, granted, and silent, as WebKit's was after the app had been
 * away (October 2026); the silent one is closed first, as iOS lets only one
 * recorder win. Undefined for any other capture, or in a browser, where there
 * is nothing else to try. In the app every dictation now uses the app's own
 * microphone (`acquire`), so this is a guard for a WebKit capture that should
 * no longer happen there.
 */
export async function replaceSilentCapture(capture: Capture): Promise<Capture | undefined> {
  if (!webCaptures.has(capture) || !nativeMicrophoneAvailable()) return undefined
  log(`WebKit's microphone sent nothing (${capture.describe()}): using the app's own`)
  recordMobileEvent('web-mic-silent', { capture: capture.describe() })
  capture.release(true)
  return openAppCapture()
}

/** Movement that still counts as a tap. */
const TAP_SLOP_PX = 10
/** How often the app's own microphone is checked on: opened if there is none, a stall recorded. */
const NATIVE_CHECK_MS = 5000

/**
 * Hands-free in the app: once the hold is on, the app's microphone is opened
 * and never closed or reopened from here until the hold is turned off. The
 * app keeps it running itself — in place after iOS stops its engine, on a new
 * one when AirPods come or go (NativeMicrophone.swift). The page used to
 * close it and open a new one whenever it went quiet for three seconds, which
 * the app's own restarts routinely caused: each time the session was given
 * up, the AirPods dropped out of their microphone link, and with the screen
 * locked iOS would not let it record again (October 2026: "Control" went
 * unheard for a minute, until the phone was unlocked). Here it is only opened
 * when there is none — at first, or after the app could not start it — and a
 * stall is recorded, not acted on.
 */
function installNativeHold(): () => void {
  let stalled = false
  const check = () => {
    announce()
    if (!wanted || opening) return
    if (held) {
      const healthy = held.capture.healthy()
      if (healthy !== !stalled) {
        stalled = !healthy
        log(stalled ? `the app's microphone is delivering nothing; waiting for the app to bring it back (${held.capture.describe()})` : 'the app\'s microphone is delivering again')
        recordMobileEvent(stalled ? 'hold-stalled' : 'hold-recovered', { capture: held.capture.describe() })
      }
      return
    }
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
 * Bring the hold back after a background trip. In a browser iOS
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
