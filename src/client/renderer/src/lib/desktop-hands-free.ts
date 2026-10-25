import type { ServerClient } from '../../../../shared/server-client'
import { installHandsFree, macHandsFreeLink, realHandsFreeDeps, setHandsFree, useHandsFree } from '../../../../mobile/hands-free'
import { rememberHandsFree, rememberedHandsFree } from '../../../../mobile/hands-free-memory'
import { mobileEvents } from '../../../../mobile/mobile-events'

/**
 * Hands-free on the Mac: Voice Operator listening on the Mac's own microphone
 * for "Control", switched on and off from the toolbar's hands-free button,
 * beside Control. Voice Operator does the listening and deciding; the server
 * holds Spaceterm's connection to it (src/server/voice-operator-hands-free.ts)
 * and relays what it says, and this follows it as the phone does
 * (src/mobile/hands-free.ts) — the button's gauges, the cues, and the words
 * for Control.
 *
 * The record of what it heard is Voice Operator's; what is recorded here goes
 * to `~/.spaceterm/mobile-events.jsonl` beside the phone's, under the client's
 * name (`spaceterm-electron …`).
 *
 * Control's voice is Voice Operator's on the Mac, and Voice Operator does not
 * listen through it on the Mac's speakers, so cutting Control off by voice
 * needs a headset.
 */

/**
 * Why hands-free cannot run on this Mac, or null when it can. Voice Operator's
 * trigger-word check uses Apple's SpeechTranscriber, which macOS 26 introduced.
 */
export function handsFreeBlocker(macOSVersion: string | null): string | null {
  if (macOSVersion === null) return 'Hands-free needs macOS 26'
  const major = Number.parseInt(macOSVersion, 10)
  return major >= 26 ? null : `Hands-free needs macOS 26 (Voice Operator's wake-word check); this Mac is on macOS ${macOSVersion}`
}

export function installDesktopHandsFree(client: Pick<ServerClient, 'mobileEvents' | 'onLifecycle'>): () => void {
  mobileEvents.setSender((events) => client.mobileEvents(events))
  const offConnect = client.onLifecycle('connect', () => mobileEvents.flush())
  const offHandsFree = installHandsFree(realHandsFreeDeps(window.api, macHandsFreeLink(window.api.handsFree)))
  // On across a server restart (which reloads this page) and the client relaunching.
  const offRemember = useHandsFree.subscribe((state, prev) => {
    if (state.on !== prev.on) rememberHandsFree(state.on, 'desktop')
  })
  if (rememberedHandsFree('desktop')) {
    window.api.log('[hands-free] it was on before this page loaded: on again')
    setHandsFree(true)
  }
  return () => {
    offRemember()
    offHandsFree()
    offConnect()
  }
}
