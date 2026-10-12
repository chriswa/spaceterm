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
 * Where playback goes is iOS's to decide: AirPods or other headphones while
 * they are connected, else the speaker. There is no choice of earpiece; the
 * microphone button shows the route instead (audio-output.ts).
 */

import { recordMobileEvent } from './mobile-events'

type SessionType = 'playback' | 'play-and-record'

interface AudioSessionLike { type: string }

function session(): AudioSessionLike | undefined {
  return (navigator as Navigator & { audioSession?: AudioSessionLike }).audioSession
}

/** Recordings open now. Two can overlap briefly — one ending as the next begins. */
let recording = 0

function apply(type: SessionType): void {
  const s = session()
  if (!s) {
    window.api?.log(`[audio-session] not available; wanted ${type}`)
    return
  }
  if (s.type === type) return
  try {
    const was = s.type
    s.type = type
    window.api?.log(`[audio-session] ${type}`)
    recordMobileEvent('audio-session', { type, was })
  } catch (err) {
    window.api?.log(`[audio-session] could not set ${type}: ${err instanceof Error ? err.message : String(err)}`)
    recordMobileEvent('audio-session-failed', { type, error: err instanceof Error ? err.message : String(err) })
  }
}

/** At startup: everything this page plays is for listening to. */
export function initAudioSession(): void {
  if (recording === 0) apply('playback')
}

/** The session's mode and how many recordings hold it, for a log line. */
export function describeAudioSession(): string {
  return `${session()?.type ?? 'no session API'}, ${recording} recording`
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
    if (recording === 0) apply('playback')
  }
}
