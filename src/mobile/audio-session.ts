/**
 * What kind of audio the page is making, as iOS needs to be told — through
 * the Audio Session API (`navigator.audioSession`), the only handle a page
 * has on it. The app's own AVAudioSession is not the one WebKit plays through,
 * which is why overriding the route natively never helped.
 *
 * Left to itself WebKit switches to play-and-record while the microphone is
 * open, and that mode sends sound to the earpiece — and it stayed there after
 * the microphone closed, so a spoken answer that followed a dictation came out
 * at a whisper. So: play-and-record exactly while something is recording,
 * playback the rest of the time, and nowhere else decides.
 *
 * Unless the listener wants the earpiece — to hold the phone to their ear.
 * The earpiece *is* play-and-record's default route, so that preference is
 * simply staying in it. Remembered on this phone.
 */

type SessionType = 'playback' | 'play-and-record'

interface AudioSessionLike { type: string }

function session(): AudioSessionLike | undefined {
  return (navigator as Navigator & { audioSession?: AudioSessionLike }).audioSession
}

/** Recordings open now. Two can overlap briefly — one ending as the next begins. */
let recording = 0

const EARPIECE_KEY = 'mobile.earpiece'
let earpiece = (() => {
  try { return localStorage.getItem(EARPIECE_KEY) === '1' } catch { return false }
})()
const listeners = new Set<(earpiece: boolean) => void>()

/** What the page is set to when nothing is recording. */
const idleType = (): SessionType => earpiece ? 'play-and-record' : 'playback'

function apply(type: SessionType): void {
  const s = session()
  if (!s) {
    window.api?.log(`[audio-session] not available; wanted ${type}`)
    return
  }
  if (s.type === type) return
  try {
    s.type = type
    window.api?.log(`[audio-session] ${type}`)
  } catch (err) {
    window.api?.log(`[audio-session] could not set ${type}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** At startup: everything this page plays is for listening to — on the speaker unless the earpiece was chosen. */
export function initAudioSession(): void {
  if (recording === 0) apply(idleType())
}

export function listensOnEarpiece(): boolean {
  return earpiece
}

/** Hold-to-ear listening, or (the default) the loudspeaker. */
export function setListenOnEarpiece(on: boolean): void {
  earpiece = on
  try { localStorage.setItem(EARPIECE_KEY, on ? '1' : '0') } catch { /* private mode: this session only */ }
  if (recording === 0) apply(idleType())
  for (const fn of listeners) fn(on)
}

export function onEarpieceChange(fn: (earpiece: boolean) => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

/**
 * The microphone is about to open. Call before `getUserMedia`, and call the
 * function it returns once when the microphone has closed, however it closed.
 */
export function beginRecordingSession(): () => void {
  recording++
  apply('play-and-record')
  let released = false
  return () => {
    if (released) return
    released = true
    recording--
    if (recording === 0) apply(idleType())
  }
}
