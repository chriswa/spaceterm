import { installHandsFree, type HandsFreeDeps } from './hands-free'
import { installHeldMicrophone, onHoldStateChange, type HoldHost } from './held-microphone'
import { installReadyCue } from './ready-cue'
import { playHandsFreeCue } from './cues'

/**
 * Hands-free on this device: the microphone held open (held-microphone.ts),
 * "Control" listened for on it (hands-free.ts), and the ready tone as it is
 * first held (ready-cue.ts). The phone (src/mobile/main.tsx) and the Mac
 * (src/client/renderer/src/lib/desktop-hands-free.ts) both start it here, so
 * the two run the same sequence; `host` is the one difference, and is
 * held-microphone.ts's to act on.
 */
export function installHandsFreeMode(api: HandsFreeDeps['api'], host: HoldHost): () => void {
  const offHold = installHeldMicrophone(host)
  const offHandsFree = installHandsFree(api)
  const offReady = installReadyCue(onHoldStateChange, () => playHandsFreeCue('handsFreeReady'))
  return () => {
    offReady()
    offHandsFree()
    offHold()
  }
}
