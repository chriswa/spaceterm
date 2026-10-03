import { beginRecordingSession } from './audio-session'

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
 * Only while the input is a headset. WebKit can hold a microphone only in
 * play-and-record, which on the phone's own speaker plays through the earpiece
 * — so held open without AirPods, every spoken answer would come out as a
 * whisper. Voice Operator has the same rule ("Only When Using AirPods").
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

/** One open capture: the stream, the graph, and who is listening to it. */
export interface Capture {
  readonly context: AudioContext
  readonly stream: MediaStream
  /** Blocks of audio from now on, until the returned function is called. */
  listen(fn: (block: Float32Array) => void): () => void
  /** Whether it is still delivering: not closed, and its track still live. */
  healthy(): boolean
  /**
   * Done with it for this dictation. A held capture stays open unless it is
   * `broken` (it went silent); a capture that is not held closes.
   */
  release(broken?: boolean): void
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
    const close = () => {
      if (closed) return
      closed = true
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

/** A capture's audio, fanned out to whoever is listening. */
function captureOf(opened: Awaited<ReturnType<typeof openCapture>>, release: (broken: boolean) => void): Capture {
  const listeners = new Set<(block: Float32Array) => void>()
  opened.node.port.onmessage = (event: MessageEvent<Float32Array>) => {
    for (const fn of listeners) fn(event.data)
  }
  return {
    context: opened.context,
    stream: opened.stream,
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

let wanted = (() => {
  try { return localStorage.getItem(KEY) === '1' } catch { return false }
})()
let held: { capture: Capture; close: () => void } | undefined
let opening: Promise<Capture> | undefined
const changeListeners = new Set<(on: boolean) => void>()

export function holdsMicrophone(): boolean {
  return wanted
}

export function onHoldChange(fn: (on: boolean) => void): () => void {
  changeListeners.add(fn)
  return () => { changeListeners.delete(fn) }
}

/** Turn holding on or off, remembered on this phone. Call inside a tap: turning it on opens the microphone now. */
export function setHoldMicrophone(on: boolean): void {
  wanted = on
  try { localStorage.setItem(KEY, on ? '1' : '0') } catch { /* private mode: this session only */ }
  log(on ? 'turned on' : 'turned off')
  if (on) void acquire().then((capture) => capture.release(), () => undefined)
  else closeHeld('turned off')
  for (const fn of changeListeners) fn(on)
}

function closeHeld(why: string): void {
  if (!held) return
  log(`closing: ${why}`)
  held.close()
  held = undefined
}

/**
 * A capture for one dictation: the held one if it is open and well, a newly
 * held one if holding is on and the input is a headset, otherwise one that
 * closes when the dictation releases it. Call inside a tap.
 */
export function acquire(): Promise<Capture> {
  if (held?.capture.healthy()) {
    void held.capture.context.resume()
    log('using the held microphone')
    return Promise.resolve(held.capture)
  }
  if (held) closeHeld('it stopped delivering')
  if (opening) return opening
  opening = (async () => {
    const opened = await openCapture()
    const label = opened.stream.getAudioTracks()[0]?.label ?? ''
    if (wanted && isHeadset(label)) {
      const capture = captureOf(opened, (broken) => { if (broken) closeHeld('it went silent') })
      held = { capture, close: opened.close }
      log(`holding "${label}" open`)
      return capture
    }
    if (wanted) log(`not holding "${label}": not a headset, and held open it would play through the earpiece`)
    return captureOf(opened, () => opened.close())
  })().finally(() => { opening = undefined })
  return opening
}

/**
 * Bring the hold back after a relaunch or a background trip: iOS opens a
 * microphone only inside a gesture, so the next touch anywhere does it. A
 * headset coming or going is rechecked too.
 */
export function installHeldMicrophone(): void {
  const reopen = () => {
    if (!wanted || held?.capture.healthy() || opening) return
    void acquire().then((capture) => capture.release(), (err) => log(`could not reopen: ${err instanceof Error ? err.message : String(err)}`))
  }
  document.addEventListener('pointerdown', reopen, { capture: true, passive: true })
  navigator.mediaDevices?.addEventListener?.('devicechange', () => {
    const label = held?.capture.stream.getAudioTracks()[0]?.label
    if (held && (!held.capture.healthy() || !isHeadset(label ?? ''))) closeHeld('the headset went away')
  })
}
