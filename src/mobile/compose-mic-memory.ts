import { browserStorage, type MemoryStorage } from './browser-storage'

/**
 * Whether the composer opens into dictation: it does if the last prompt
 * shipped from a composer went with the microphone still on, and not if it
 * went with the microphone off. Nothing shipped yet, or nothing kept, opens
 * into dictation.
 *
 * One answer for the phone, not one per surface: what decides it is whether
 * talking is possible where you are.
 */

const KEY = 'spaceterm.composeMic'

/** A prompt was shipped, with the microphone on or off. */
export function rememberComposeMic(on: boolean, store: MemoryStorage | null = browserStorage()): void {
  try {
    store?.setItem(KEY, on ? 'on' : 'off')
  } catch { /* nothing to remember with */ }
}

/** Whether the next composer should open into dictation. */
export function composeMicOn(store: MemoryStorage | null = browserStorage()): boolean {
  try {
    return store?.getItem(KEY) !== 'off'
  } catch {
    return true
  }
}
