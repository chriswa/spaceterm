import { installHandsFree, phoneHandsFreeLink, realHandsFreeDeps, setHandsFree, useHandsFree } from './hands-free'
import { holdState, installHeldMicrophone, onHoldStateChange, setHoldMicrophone, type HoldHost } from './held-microphone'
import { nativeMicrophoneAvailable } from './native-microphone'
import type { HandsFreeApi } from '../shared/api'

/**
 * Hands-free on the phone: the microphone held open (held-microphone.ts) and,
 * in the iPhone app, Voice Operator's SDK streaming it to Voice Operator,
 * which listens for "Control" (hands-free.ts). Holding is hands-free there:
 * the hands-free button switches the hold, and the stream follows it. In a
 * browser the hold is only a held microphone for AirPods; there is no SDK.
 *
 * The Mac's hands-free is Voice Operator on the Mac's own microphone, switched
 * from the toolbar (src/client/renderer/src/lib/desktop-hands-free.ts).
 */
export function installHandsFreeMode(
  api: { handsFree: HandsFreeApi },
  host: HoldHost,
  device: () => string,
  onConnect: (fn: () => void) => () => void,
): () => void {
  const offHold = installHeldMicrophone(host)
  if (!nativeMicrophoneAvailable()) return offHold
  const link = phoneHandsFreeLink(api.handsFree, device, onConnect)
  const offHandsFree = installHandsFree(realHandsFreeDeps(api, link))
  const offFollow = onHoldStateChange((state) => {
    // A microphone reopening after a stall flips through `preparing`: the stream rides it out.
    if (state === 'held') setHandsFree(true)
    else if (state === 'off') setHandsFree(false)
  })
  // Ended from the other side (turned on on the Mac, lost): the hold that was for it goes too.
  const offEnded = useHandsFree.subscribe((state, prev) => {
    if (prev.on && !state.on && holdState() !== 'off') setHoldMicrophone(false)
  })
  return () => {
    offEnded()
    offFollow()
    offHandsFree()
    link.dispose()
    offHold()
  }
}
