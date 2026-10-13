import type { HoldState } from './held-microphone'

/**
 * Hands-free ready: the switch (MicLockButton.tsx) turning from white on black
 * to black on white — the microphone held and listening — sounds
 * `handsFreeReady` (cues.ts), so it is heard as well as seen. Only the first
 * time after the hold is turned on: the app's microphone stalling and coming
 * back flips the switch too, and a tone there would sound over and over, as
 * the hold's own announcements once did (held-microphone.ts `announce`).
 */
export function installReadyCue(
  onHoldStateChange: (fn: (state: HoldState) => void) => () => void,
  play: () => void,
): () => void {
  /** Turned on and not yet held since: the next `held` is it being ready. */
  let turningOn = true
  return onHoldStateChange((state) => {
    if (state === 'off') turningOn = true
    else if (state === 'held' && turningOn) {
      turningOn = false
      play()
    }
  })
}
