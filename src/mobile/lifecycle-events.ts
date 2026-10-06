import { mobileEvents, recordMobileEvent, type Detail } from './mobile-events'
import { holdState } from './held-microphone'
import { useHandsFree } from './hands-free'
import { useDictationSession } from './dictation-session'
import { Dictation } from './dictation'
import { describeAudioSession } from './audio-session'
import { quietForMs } from './cues'

/**
 * What feeds the phone's audio and lifecycle record (mobile-events.ts) from
 * outside any one audio module: the page and the app coming and going, the
 * page being put to sleep and woken, audio devices appearing and leaving, and
 * the iPhone app's own events (NativeMicrophone.swift) — the audio session's
 * interruptions and route changes, the app going to the background, the
 * screen locking.
 *
 * iOS gives a page no event for being suspended. A five-second tick that fires
 * late says it was, and for how long; a heartbeat while hidden says when it was
 * still running. The last tick is also kept in storage, so a page iOS killed
 * says, on its next load, when it was last alive.
 */

const TICK_MS = 5000
/** A tick this late means the page was asleep in between. */
const ASLEEP_AFTER_MS = 15_000
/** While hidden, a heartbeat this often: the page is still running. */
const HIDDEN_HEARTBEAT_MS = 60_000
const LAST_ALIVE_KEY = 'spaceterm:mobile-last-alive'
/** The highest app event number this browser has taken into the record, and the highest the server has. */
const NATIVE_TAKEN_KEY = 'spaceterm:native-events-taken'
const NATIVE_ACKED_KEY = 'spaceterm:native-events-acked'

/** One of the app's events, as NativeEvents.swift hands it over. */
interface NativeEvent { seq: number; t: string; kind: string; detail?: Detail }

declare global {
  interface Window {
    /** What the iPhone app calls with its own events; returns true once taken. */
    spacetermNativeEvents?: { push(events: NativeEvent[]): boolean }
  }
}

/** Every event says what the audio was doing at the time. */
function addAudioContext(): void {
  mobileEvents.addContext('vis', () => document.visibilityState)
  mobileEvents.addContext('hold', holdState)
  mobileEvents.addContext('handsFree', () => useHandsFree.getState().phase)
  mobileEvents.addContext('dictation', () => useDictationSession.getState().mic.kind)
  mobileEvents.addContext('liveDictations', () => Dictation.live)
  mobileEvents.addContext('session', describeAudioSession)
  mobileEvents.addContext('playing', () => quietForMs() === 0)
}

function readNumber(key: string): number {
  try { return Number(localStorage.getItem(key)) || 0 } catch { return 0 }
}

function writeNumber(key: string, value: number): void {
  try { localStorage.setItem(key, String(value)) } catch { /* private mode */ }
}

/**
 * Take the app's events, and tell the app when the server has them — only
 * then does it forget them (NativeEvents.swift). Installed before anything
 * else, so the app can hand them over from the first moment the page exists;
 * they wait in the record until the server is there.
 *
 * The app hands every new page all it still holds, so some are already in
 * this browser's record — skipped by number. Those the server already has
 * are acknowledged again: the last acknowledgement may have died with the
 * page that sent it.
 */
export function installNativeEventBridge(): void {
  const post = window.webkit?.messageHandlers?.nativeEvents
  const ack = (through: number) => post?.postMessage({ action: 'ack', through })
  window.spacetermNativeEvents = {
    push(events) {
      let taken = readNumber(NATIVE_TAKEN_KEY)
      const acked = readNumber(NATIVE_ACKED_KEY)
      let reAck = false
      for (const e of events) {
        if (e.seq <= taken) {
          if (e.seq <= acked) reAck = true
          continue
        }
        mobileEvents.record(e.kind, e.detail, { src: 'native', t: e.t, nativeSeq: e.seq })
        taken = e.seq
      }
      writeNumber(NATIVE_TAKEN_KEY, taken)
      if (reAck) ack(acked)
      return true
    },
  }
  mobileEvents.onAcknowledged((batch) => {
    const highest = Math.max(readNumber(NATIVE_ACKED_KEY), ...batch.map((e) => e.nativeSeq ?? 0))
    writeNumber(NATIVE_ACKED_KEY, highest)
    // The high-water mark every time, so one lost acknowledgement is made good by the next.
    if (highest > 0) ack(highest)
  })
}

function readLastAlive(): string | null {
  try { return localStorage.getItem(LAST_ALIVE_KEY) } catch { return null }
}

function writeLastAlive(at: number): void {
  try { localStorage.setItem(LAST_ALIVE_KEY, new Date(at).toISOString()) } catch { /* private mode */ }
}

/** Audio inputs and outputs by name: AirPods arriving and leaving. Labels need the microphone granted once. */
async function audioDevices(): Promise<Detail> {
  const devices = await navigator.mediaDevices?.enumerateDevices?.() ?? []
  const named = (kind: MediaDeviceKind) => devices.filter((d) => d.kind === kind).map((d) => d.label || '(unnamed)')
  return { inputs: named('audioinput'), outputs: named('audiooutput') }
}

export function installLifecycleEvents(): void {
  addAudioContext()
  recordMobileEvent('page-load', {
    lastAlive: readLastAlive(),
    processRestarts: window.spacetermProcessRestarts ?? 0,
    app: window.webkit?.messageHandlers?.nativeMicrophone !== undefined,
    nativeVersion: window.spacetermNativeVersion ?? null,
  })

  document.addEventListener('visibilitychange', () => recordMobileEvent('visibility', { state: document.visibilityState }))
  window.addEventListener('pagehide', (e) => recordMobileEvent('pagehide', { persisted: e.persisted }))
  window.addEventListener('pageshow', (e) => recordMobileEvent('pageshow', { persisted: e.persisted }))
  document.addEventListener('freeze', () => recordMobileEvent('freeze'))
  document.addEventListener('resume', () => recordMobileEvent('resume'))
  window.addEventListener('focus', () => recordMobileEvent('focus', { focused: true }))
  window.addEventListener('blur', () => recordMobileEvent('focus', { focused: false }))
  window.addEventListener('online', () => recordMobileEvent('network', { online: true }))
  window.addEventListener('offline', () => recordMobileEvent('network', { online: false }))

  // WebKit's own view of the page's audio: `interrupted` is the page's sound cut off by iOS.
  const session = (navigator as Navigator & { audioSession?: EventTarget & { state?: string; type?: string } }).audioSession
  session?.addEventListener?.('statechange', () => recordMobileEvent('web-audio-session', { state: session.state ?? null, type: session.type ?? null }))

  // The microphone permission being withdrawn, in Settings or by iOS.
  void navigator.permissions?.query?.({ name: 'microphone' as PermissionName }).then((status) => {
    recordMobileEvent('mic-permission', { state: status.state })
    status.addEventListener('change', () => recordMobileEvent('mic-permission', { state: status.state }))
  }, () => undefined)

  navigator.mediaDevices?.addEventListener?.('devicechange', () => {
    void audioDevices().then((devices) => recordMobileEvent('devices-changed', devices), (err) => {
      recordMobileEvent('devices-changed', { error: err instanceof Error ? err.message : String(err) })
    })
  })

  let lastTick = Date.now()
  let lastHeartbeat = lastTick
  writeLastAlive(lastTick)
  setInterval(() => {
    const now = Date.now()
    const gap = now - lastTick
    lastTick = now
    writeLastAlive(now)
    if (gap > ASLEEP_AFTER_MS) {
      recordMobileEvent('woke', { asleepMs: gap - TICK_MS, since: new Date(now - gap).toISOString() })
      lastHeartbeat = now
      // Woken is when a send that died with the socket is worth trying again.
      mobileEvents.flush()
      return
    }
    if (document.visibilityState === 'hidden' && now - lastHeartbeat >= HIDDEN_HEARTBEAT_MS) {
      lastHeartbeat = now
      recordMobileEvent('heartbeat')
    }
    mobileEvents.flush()
  }, TICK_MS)
}
