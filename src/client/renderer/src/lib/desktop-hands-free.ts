import type { ElectronHost } from '../../../../shared/api'
import type { ServerClient } from '../../../../shared/server-client'
import { installHandsFreeMode } from '../../../../mobile/hands-free-mode'
import { onHoldStateChange } from '../../../../mobile/held-microphone'
import { mobileEvents } from '../../../../mobile/mobile-events'

/**
 * Hands-free on the Mac: the phone's hands-free mode (src/mobile/hands-free-mode.ts),
 * switched on from the toolbar's hands-free button, beside Control. Nothing
 * here listens or decides: it is the same code as the phone's, with the Mac
 * as held-microphone.ts's host. What the Mac adds is only what its host needs:
 *
 * - The audio and lifecycle record goes to the server as the phone's does, so
 *   `~/.spaceterm/mobile-events.jsonl` has the Mac's hands-free beside the
 *   phone's, each line under its client's name (`spaceterm-electron …`).
 * - While the microphone is held, Electron does not throttle the window's
 *   timers when it is behind others (`ElectronHost.microphoneHeld`).
 *
 * Control's voice is Voice Operator's on the Mac, not the page's, so
 * hands-free hears straight through it: this assumes a headset, where nothing
 * played reaches the microphone.
 */
/**
 * Why hands-free cannot run on this Mac, or null when it can. Hands-free asks
 * Voice Operator whether speech began with "Control", and Voice Operator's
 * check uses Apple's SpeechTranscriber, which macOS 26 introduced.
 */
export function handsFreeBlocker(macOSVersion: string | null): string | null {
  if (macOSVersion === null) return 'Hands-free needs macOS 26'
  const major = Number.parseInt(macOSVersion, 10)
  return major >= 26 ? null : `Hands-free needs macOS 26 (Voice Operator's wake-word check); this Mac is on macOS ${macOSVersion}`
}

export function installDesktopHandsFree(
  client: Pick<ServerClient, 'mobileEvents' | 'onLifecycle'>,
  host: Pick<ElectronHost, 'microphoneHeld'>,
): () => void {
  mobileEvents.setSender((events) => client.mobileEvents(events))
  const offConnect = client.onLifecycle('connect', () => mobileEvents.flush())
  const offHeld = onHoldStateChange((state) => host.microphoneHeld(state !== 'off'))
  const offMode = installHandsFreeMode(window.api, 'desktop')
  return () => {
    offMode()
    offHeld()
    offConnect()
  }
}
